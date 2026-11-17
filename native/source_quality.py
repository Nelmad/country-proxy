"""Session-local source evidence; no ranking, persistence, network, or feed-label geo.

For each retained endpoint, divide ONE vote among supplying groups, then divide
that group's fraction among its requested countries. Late duplicate observations
redistribute earned evidence. Counters describe fixed five-minute windows starting
with the first meaningful terminal assessment, not lifetime success/health counts.
Pending provenance has the same TTL. Deterministic earliest-expiry eviction drops
an endpoint's evidence entirely (never leaves cumulative credit behind).

Storage: <=5000 records, each <=32 integer country bitsets (<=249 bits each).
Country/group aggregates are maintained on mutation. summary(country) costs at
most 32 rows plus amortized expiry; it does not scan live endpoint records.
All calls belong on the owning Session's event loop.
"""
from collections import OrderedDict
from dataclasses import dataclass, field
import math
import time

WINDOW_SECONDS = 300
MAX_ENTRIES = 5000


@dataclass
class _Evidence:
    expires: float
    # Integer indexes/bitsets avoid country/group strings per provenance pair.
    sources: dict = field(default_factory=dict)
    assessed: bool = False
    native: bool = False
    browser: bool = False
    last_native_ok: bool = False


class SourceQuality:
    """Observe discovery, terminal native reports, then exact browser offers.

    observe(item, requested_country, group): call for EVERY _offer observation.
    terminal(item, report): inspect_proxy-shaped terminal result; health/replays
        cannot create a second endpoint vote. Unknown endpoints are ignored.
    native_offer(item, attempt): arm a current offer after terminal success.
    confirm(item, attempt): credit only that exact armed offer; returns bool.
    summary(country): one selected requested country, including zero groups.

    The caller supplies freshness: terminal receives current check reports only,
    never persisted history or source country labels. ``proxy.country`` must be
    inside this Session's selected countries. ``attempt`` is the Session's exact
    immutable offer token (str/int); older attempts cannot confirm newer offers.
    """
    def __init__(self, countries, groups, *, clock=time.monotonic, max_entries=MAX_ENTRIES):
        self.countries = tuple(dict.fromkeys(countries))
        self.groups = tuple(dict.fromkeys(groups))
        if not 1 <= len(self.countries) <= 249 or any(
                not isinstance(cc, str) or len(cc) != 2 or not cc.isascii() or
                not cc.isupper() or not cc.isalpha() for cc in self.countries):
            raise ValueError('expected 1..249 selected uppercase ISO country codes')
        if not 1 <= len(self.groups) <= 32 or any(
                not isinstance(g, str) or not g or len(g) > 128 for g in self.groups):
            raise ValueError('expected 1..32 known provider groups')
        if type(max_entries) is not int or not 1 <= max_entries <= MAX_ENTRIES:
            raise ValueError('max_entries must be 1..5000')
        self._ci = {cc: i for i, cc in enumerate(self.countries)}
        self._gi = {g: i for i, g in enumerate(self.groups)}
        self._clock, self._cap = clock, max_entries
        self._records = OrderedDict()
        # assessed/native/browser shares and distinct assessed/native endpoints.
        self._totals = [[[0., 0., 0., 0, 0] for _ in self.groups] for _ in self.countries]
        self._counts = [[0, 0] for _ in self.countries]
        self._offer = None
        self._capacity_limited = False

    @staticmethod
    def _key(item):
        # Candidate identity includes scheme, host AND port; never strip scheme.
        scheme, host, port = item.scheme, item.host, item.port
        if not isinstance(scheme, str) or not isinstance(host, str) or (
                not scheme or not host or len(scheme) > 16 or len(host) > 253 or
                not isinstance(port, int) or not 0 < port < 65536):
            raise ValueError('invalid endpoint')
        return scheme, host, port

    def _now(self):
        now = self._clock()
        if not math.isfinite(now):
            raise ValueError('clock must be finite and monotonic')
        return now

    def _drop(self, key):
        rec = self._records.pop(key)
        self._apply(rec, -1)
        if self._offer is not None and self._offer[0] == key:
            self._offer = None

    def _expire(self, now):
        # Fixed expiries and monotonic insertion preserve FIFO expiry order.
        while self._records:
            key, rec = next(iter(self._records.items()))
            if rec.expires > now:
                break
            self._drop(key)

    def _apply(self, rec, sign):
        if not rec.sources or not rec.assessed:
            return
        country_union = 0
        for gi, bits in rec.sources.items():
            country_union |= bits
            share = sign / (len(rec.sources) * bits.bit_count())
            remaining = bits
            while remaining:
                low = remaining & -remaining
                ci = low.bit_length() - 1
                row = self._totals[ci][gi]
                for idx, earned in enumerate((rec.assessed, rec.native, rec.browser)):
                    if earned:
                        row[idx] += share
                row[3] += sign * rec.assessed
                row[4] += sign * rec.native
                remaining ^= low
        while country_union:
            low = country_union & -country_union
            row = self._counts[low.bit_length() - 1]
            row[0] += sign * rec.assessed
            row[1] += sign * rec.native
            country_union ^= low

    def observe(self, item, requested_country, group):
        if requested_country not in self._ci or group not in self._gi:
            raise ValueError('unknown requested country or provider group')
        key, now = self._key(item), self._now()
        self._expire(now)
        rec = self._records.get(key)
        if rec is None:
            if len(self._records) >= self._cap:
                self._capacity_limited = True
                self._drop(next(iter(self._records)))
            rec = self._records[key] = _Evidence(now + WINDOW_SECONDS)
        gi, bit = self._gi[group], 1 << self._ci[requested_country]
        if rec.sources.get(gi, 0) & bit:
            return
        self._apply(rec, -1)
        rec.sources[gi] = rec.sources.get(gi, 0) | bit
        self._apply(rec, 1)

    def terminal(self, item, report):
        key = self._key(item)
        now = self._now()
        self._expire(now)
        rec = self._records.get(key)
        if rec is None or not isinstance(report, dict):
            return False
        reason = report.get('reason')
        if reason in ('internal', 'neutral', 'cancel', 'cancelled') or (
                reason == 'tls' and report.get('code') in (58, 59, 77, 82)):
            return False
        proxy = report.get('proxy')
        # A successful report must describe this exact checked endpoint.
        success = bool(report.get('ok') and isinstance(proxy, dict) and
                       proxy.get('country') in self._ci and
                       (proxy.get('scheme'), proxy.get('host'), proxy.get('port')) == key and
                       type(proxy.get('port')) is int)
        rec.last_native_ok = success
        if rec.assessed and (rec.native or not success):
            return success
        if not rec.assessed:
            # An admitted slow check gets a full evidence window, even when
            # discovery happened close to pending provenance expiry.
            rec.expires = now + WINDOW_SECONDS
            self._records.move_to_end(key)
        self._apply(rec, -1)
        rec.assessed = True
        rec.native |= success
        self._apply(rec, 1)
        return success

    def native_offer(self, item, attempt):
        key = self._key(item)
        self._expire(self._now())
        if type(attempt) not in (str, int) or (
                isinstance(attempt, str) and (not attempt or len(attempt) > 256)):
            raise ValueError('expected bounded exact offer token')
        rec = self._records.get(key)
        if rec is None or not rec.native or not rec.last_native_ok:
            self._offer = None
            return False
        self._offer = (key, attempt)
        return True

    def confirm(self, item, attempt):
        key = self._key(item)
        self._expire(self._now())
        rec = self._records.get(key)
        if (type(attempt) not in (str, int) or self._offer != (key, attempt) or
                rec is None or not rec.native or not rec.last_native_ok):
            return False
        if not rec.browser:
            self._apply(rec, -1)
            rec.browser = True
            self._apply(rec, 1)
        return True

    def summary(self, country):
        if country not in self._ci:
            raise ValueError('unknown requested country')
        self._expire(self._now())
        ci = self._ci[country]
        groups = []
        for gi, group in enumerate(self.groups):
            row = self._totals[ci][gi]
            groups.append({'group': group,
                           'assessedShare': max(0., row[0]),
                           'nativeQualifiedShare': max(0., row[1]),
                           'browserConfirmedShare': max(0., row[2]),
                           'assessedNative': row[3], 'nativeWorking': row[4]})
        return {'country': country, 'windowSeconds': WINDOW_SECONDS,
                'retainedEndpoints': len(self._records),
                'capacityLimited': self._capacity_limited,
                'assessedNative': self._counts[ci][0],
                'nativeWorking': self._counts[ci][1], 'groups': groups}
