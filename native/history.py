"""Bounded endpoint hints; no source label, old success or cooldown proves a proxy safe.

Runtime decisions use monotonic time only. Disk timestamps are wall-clock hints;
backward wall-clock jumps invalidate a restored document instead of lengthening a
quarantine. Callers group fast/slow into one logical result before observe().
A validated HTTPS response with an invalid trace can use endpoint_failure.
Ambiguous TLS is unknown and a known local configuration problem is neutral.
"""
from collections import OrderedDict
from dataclasses import dataclass, field
import ipaddress
import json
import math
import random
import re
import time


MAX_RECORDS = 5000
MAX_AGE = 7 * 24 * 3600
MAX_BYTES = 2 * 1024 * 1024
MAX_GROUPS = 32
MAX_STREAK = 16
SCHEMES = frozenset(('http', 'https', 'socks4', 'socks5'))
OUTCOMES = ('success', 'invalid_trace', 'timeout', 'http', 'transport', 'connect', 'tls', 'country', 'unknown')
GROUP = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}\Z')


@dataclass
class HistoryRecord:
    scheme: str
    host: str
    port: int
    first_seen: float
    last_seen: float
    last_success: float | None = None
    streak: int = 0
    cooldown_until: float | None = None
    ewma_ms: float | None = None
    country_hint: str | None = None
    groups: tuple = field(default_factory=tuple)
    last_outcome: str | None = None


def _number(value, *, minimum=0, maximum=None):
    try:
        finite = type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite or value < minimum:
        raise ValueError('invalid history number')
    if maximum is not None and value > maximum:
        raise ValueError('history number exceeds bound')
    return value


def _groups(groups):
    if not isinstance(groups, (list, tuple, set, frozenset)) or len(groups) > MAX_GROUPS:
        raise ValueError('invalid source groups')
    if any(not isinstance(g, str) or not GROUP.fullmatch(g) for g in groups):
        raise ValueError('invalid source group')
    return tuple(sorted(set(groups)))


class EndpointHistory:
    def __init__(self, *, clock=time.monotonic, wall_clock=time.time,
                 jitter=random.random, max_records=MAX_RECORDS,
                 endpoint_validator=None):
        if type(max_records) is not int or not 1 <= max_records <= MAX_RECORDS:
            raise ValueError('invalid history capacity')
        self.clock, self.wall_clock, self.jitter = clock, wall_clock, jitter
        # Explicit injection supports isolated loopback labs; production never
        # enables it. It cannot permit hostnames, credentials or malformed ports.
        self.endpoint_validator = endpoint_validator
        self.max_records = max_records
        self.records = OrderedDict()
        self.revision = 0
        self._last_now = float('-inf')

    def _now(self):
        now = self.clock()
        if type(now) not in (int, float) or not math.isfinite(now):
            raise ValueError('invalid monotonic clock')
        self._last_now = max(self._last_now, now)
        return self._last_now

    def _key(self, item):
        try:
            scheme, host, port = item.scheme, item.host, item.port
            if scheme not in SCHEMES or not isinstance(host, str) or len(host) > 45 or '%' in host:
                return None
            if type(port) is not int or not 1 <= port <= 65535:
                return None
            address = ipaddress.ip_address(host)
            allowed = ((address.is_global and not address.is_multicast)
                       if self.endpoint_validator is None else self.endpoint_validator(address))
            if not allowed:
                return None
            return scheme, str(address), port
        except (AttributeError, TypeError, ValueError):
            return None

    def prune(self):
        """Expire inactive records before evicting the oldest observations."""
        now = self._now()
        removed = 0
        # Rows are ordered by last physical observation, oldest first.
        while self.records:
            oldest = next(iter(self.records.values()))
            if len(self.records) <= self.max_records and now - oldest.last_seen < MAX_AGE:
                break
            self.records.popitem(last=False)
            removed += 1
        if removed:
            self.revision += 1
        return removed

    def get(self, item):
        self.prune()
        return self.records.get(self._key(item))

    def seen(self, item, groups=()):
        """Remember a feed offer, without renewing an old endpoint's retention.

        lastSeen advances on a real non-neutral check, not repeated stale feed
        offers. Otherwise a dead endpoint reoffered forever would never expire.
        """
        self.prune()
        key = self._key(item)
        if key is None:
            return None
        groups = _groups(groups)
        rec = self.records.get(key)
        if rec is None:
            now = self._now()
            rec = HistoryRecord(*key, now, now, groups=groups)
            self.records[key] = rec
            self.revision += 1
            self.prune()
        else:
            merged = tuple(sorted(set(rec.groups).union(groups)))[:MAX_GROUPS]
            if merged != rec.groups:
                rec.groups = merged
                self.revision += 1
        return rec

    def eligible(self, item):
        rec = self.get(item)
        return rec is None or rec.cooldown_until is None or self._now() >= rec.cooldown_until

    def is_exploration(self, item):
        rec = self.get(item)
        return (rec is None or rec.last_success is None or
                (rec.cooldown_until is not None and self._now() >= rec.cooldown_until))

    def rank(self, item):
        rec = self.get(item)
        recent = rec is not None and rec.last_success is not None and self._now() - rec.last_success <= 300
        return (0 if recent else 1, rec.streak if rec else 0,
                1 if rec is None or rec.ewma_ms is None else 0,
                rec.ewma_ms if rec and rec.ewma_ms is not None else 0)

    def observe(self, item, kind, *, latency_ms=None, country=None, groups=(), reason=None):
        if kind not in ('success', 'endpoint_failure', 'unknown', 'country',
                        'cancel', 'internal', 'neutral'):
            raise ValueError('invalid logical outcome')
        if kind in ('cancel', 'internal', 'neutral'):
            return self.get(item)
        if latency_ms is not None:
            _number(latency_ms, maximum=86400000)
        if kind == 'success' and latency_ms is None:
            raise ValueError('native success needs a latency sample')
        if country is not None:
            from core import COUNTRIES
            if not isinstance(country, str) or country not in COUNTRIES:
                raise ValueError('invalid actual country')
        rec = self.seen(item, groups)
        if rec is None:
            return None
        now = self._now()
        rec.last_seen = now
        self.records.move_to_end((rec.scheme, rec.host, rec.port))
        if kind == 'unknown':
            rec.last_outcome = reason if reason in ('timeout', 'http', 'transport', 'connect', 'tls') else 'unknown'
        else:
            rec.last_outcome = 'invalid_trace' if kind == 'endpoint_failure' else kind
        if country is not None:
            rec.country_hint = country
        if kind == 'success':
            rec.last_success = now
            rec.streak = 0
            rec.cooldown_until = None
            rec.ewma_ms = latency_ms if rec.ewma_ms is None else .75 * rec.ewma_ms + .25 * latency_ms
        elif kind == 'endpoint_failure':
            rec.streak = min(MAX_STREAK, rec.streak + 1)
            fraction = self.jitter()
            _number(fraction, maximum=1)
            rec.cooldown_until = now + min(3600, 60 * (2 ** (rec.streak - 1)) * (1 + .1 * fraction))
        elif kind == 'unknown':
            rec.cooldown_until = max(rec.cooldown_until or now, now + 60)
        # A country mismatch updates a hint only; it neither erases an existing
        # terminal streak nor creates or extends any global endpoint cooldown.
        self.revision += 1
        return rec

    def snapshot(self):
        """Return a JSON-compatible v1 document, newest first, bounded to 2MiB.

        Large source metadata can make the disk limit tighter than 5000 records.
        Omit the oldest disk entries in one bounded pass; memory is unaffected.
        """
        self.prune()
        now, wall = self._now(), _number(self.wall_clock())
        document = {'schemaVersion': 1, 'savedAt': wall, 'records': []}
        size = len(json.dumps(document, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
        for rec in reversed(self.records.values()):
            stamp = lambda value: None if value is None else max(0, wall + (value - now))
            entry = {'scheme': rec.scheme, 'host': rec.host, 'port': rec.port,
                     'firstSeen': stamp(rec.first_seen), 'lastSeen': stamp(rec.last_seen),
                     'lastSuccess': stamp(rec.last_success), 'streak': rec.streak,
                     'cooldownUntil': stamp(rec.cooldown_until), 'ewmaMs': rec.ewma_ms,
                     'lastOutcome': rec.last_outcome, 'countryHint': rec.country_hint, 'groups': list(rec.groups)}
            cost = len(json.dumps(entry, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
            cost += bool(document['records'])
            if size + cost > MAX_BYTES:
                break
            document['records'].append(entry)
            size += cost
        return document

    def restore(self, payload):
        """Strict, atomic decoded-document validation; invalid files load cold."""
        if type(payload) is not dict or set(payload) != {'schemaVersion', 'savedAt', 'records'}:
            raise ValueError('invalid history document')
        if type(payload['schemaVersion']) is not int or payload['schemaVersion'] != 1:
            raise ValueError('unsupported history schema')
        wall = _number(self.wall_clock())
        saved = _number(payload['savedAt'], maximum=wall)
        rows = payload['records']
        if type(rows) is not list or len(rows) > MAX_RECORDS:
            raise ValueError('invalid history records')
        now = self._now()
        records = {}
        fields = {'scheme', 'host', 'port', 'firstSeen', 'lastSeen', 'lastSuccess',
                  'streak', 'cooldownUntil', 'ewmaMs', 'countryHint', 'groups', 'lastOutcome'}
        from core import COUNTRIES
        for row in rows:
            if type(row) is not dict or set(row) != fields:
                raise ValueError('invalid history record')
            # Reuse the endpoint validator without constructing a core Candidate.
            from types import SimpleNamespace
            key = self._key(SimpleNamespace(**{name: row[name] for name in ('scheme', 'host', 'port')}))
            if key is None or key in records or key[1] != row['host']:
                raise ValueError('invalid or duplicate endpoint')
            first = _number(row['firstSeen'], maximum=saved)
            last = _number(row['lastSeen'], minimum=first, maximum=saved)
            success, cooldown = row['lastSuccess'], row['cooldownUntil']
            if success is not None:
                _number(success, minimum=first, maximum=last)
            if cooldown is not None:
                _number(cooldown, maximum=saved + 3600)
            streak = row['streak']
            if type(streak) is not int or not 0 <= streak <= MAX_STREAK:
                raise ValueError('invalid terminal streak')
            ewma = row['ewmaMs']
            if ewma is not None:
                _number(ewma, maximum=86400000)
            country = row['countryHint']
            if country is not None and (not isinstance(country, str) or country not in COUNTRIES):
                raise ValueError('invalid actual country hint')
            if (success is None) != (ewma is None):
                raise ValueError('inconsistent success sample')
            outcome = row['lastOutcome']
            if outcome is not None and outcome not in OUTCOMES:
                raise ValueError('invalid last outcome')
            groups = _groups(row['groups'])
            if type(row['groups']) is not list or list(groups) != row['groups']:
                raise ValueError('noncanonical source groups')
            to_mono = lambda stamp: None if stamp is None else now + (stamp - wall)
            records[key] = HistoryRecord(*key, to_mono(first), to_mono(last),
                                         to_mono(success), streak, to_mono(cooldown),
                                         ewma, country, groups, outcome)
        if len(json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8')) > MAX_BYTES:
            raise ValueError('oversize history document')
        self.records = OrderedDict(sorted(reversed(records.items()), key=lambda pair: pair[1].last_seen))
        self.revision += 1
        self.prune()
        return len(self.records)
