"""Country-scoped public feeds. All records still pass core's strict endpoint parser."""
import asyncio
from collections import Counter, OrderedDict, deque
from contextlib import aclosing, asynccontextmanager
from itertools import islice
from dataclasses import dataclass, replace
import json
import re
import time

from check_budget import await_cleanup

PER_FEED_LIMIT = 120
BODY_LIMIT = 2_000_000
FEED_CONCURRENCY = 6
BACKOFF_LIMIT = 4096
LIBRARY_NAME = 'proxy-scraper'
FAILURE_TTL = 60


class FeedFailure(ValueError):
    """A confirmed remote response or source-document parse failure."""
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    format: str = 'text'
    ttl: int = 300
    empty_404: bool = False
    group: str = ''
    min_interval: int = 0

    def for_country(self, country):
        if not re.fullmatch(r'[A-Z]{2}', country):
            raise ValueError('Invalid country')
        return self.url.format(country=country, lower=country.lower())


SOURCES = (
    Source('hproxy-live', 'https://hproxy.com/api/proxy-list?format=json&country={lower}&limit=200',
           'hproxy-live', ttl=60, group='hproxy'),
    Source('hproxy', 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/by-country/{country}.txt',
           empty_404=True, group='hproxy'),
    Source('Proxifly', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/{country}/data.txt', empty_404=True),
    Source('ProxyScrape', 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=all&country={country}&timeout=60000&proxy_format=protocolipport&format=text&limit=2000', ttl=60),
    Source('GeoNode', 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&country={country}', 'geonode'),
    Source('Litport', 'https://raw.githubusercontent.com/litportnet/free-proxy-list/live/proxies/countries/{lower}/all.txt', empty_404=True, min_interval=300),
    Source('ProxMint', 'https://proxmint.com/api/free-proxies?country={lower}&pageSize=200&sort=checked', 'proxmint', ttl=1800),
    *(Source('Databay/' + scheme, 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/{lower}/' + scheme + '.txt',
             'plain-' + scheme, empty_404=True, group='Databay') for scheme in ('http', 'https', 'socks4', 'socks5')),
)


@dataclass(frozen=True)
class SourceBatch:
    group: str
    source: str
    candidates: tuple
    error: str | None
    fetched_at: float | None   # Unix seconds of the original response, not publication time.
    complete: bool            # No more feeds of this group in this country producer.
    delivery: str = 'fetch'    # fetch, shared, cache, deferred
    outcome: str = 'ok'        # ok, empty, transport_error, parser_error, internal_error, min_interval
    fetch_duration_ms: float | None = None
    updated_at: float | None = None  # Trusted source-list publication time; never local fetch time.


@dataclass(frozen=True)
class _Payload:
    candidates: tuple = ()
    error: str | None = None
    fetched_at: float | None = None
    delivery: str = 'fetch'
    outcome: str = 'ok'
    fetch_duration_ms: float | None = None
    updated_at: float | None = None


@dataclass
class _Flight:
    task: asyncio.Task
    released: asyncio.Event
    owners: int = 0
    abandoned: bool = False


class _CountrySlots:
    """Rotate waiting countries; a sole requester can still use every slot."""
    def __init__(self, capacity):
        self.free = capacity
        self.queues = OrderedDict()
        self.scheduled = False

    def _wake(self):
        if self.free and self.queues and not self.scheduled:
            # Batch concurrent enqueue operations before choosing a country. Without
            # this, the first of three cold jobs would start its whole source list.
            self.scheduled = True
            asyncio.get_running_loop().call_soon(self._dispatch)

    def _dispatch(self):
        self.scheduled = False
        while self.free and self.queues:
            country, queue = self.queues.popitem(last=False)
            ticket = queue.popleft()
            if queue:
                self.queues[country] = queue
            if not ticket.cancelled():
                self.free -= 1
                ticket.set_result(None)

    @asynccontextmanager
    async def slot(self, country):
        ticket = asyncio.get_running_loop().create_future()
        queue = self.queues.setdefault(country, deque())
        queue.append(ticket)
        self._wake()
        try:
            await ticket
            yield
        finally:
            if ticket.done() and not ticket.cancelled():
                self.free += 1  # Includes cancellation after grant but before resumption.
            elif ticket in queue:
                queue.remove(ticket)
                if not queue and self.queues.get(country) is queue:
                    del self.queues[country]
            self._wake()


class SourceCache:
    """One per helper: bounded payload LRU, independent request deadlines and owned I/O."""
    def __init__(self, clock=time.monotonic, limit=160, wall=time.time):
        self.clock, self.wall = clock, wall
        self.limit = max(0, min(160, limit))
        self.entries = OrderedDict()
        self.next_allowed = {}  # key -> (monotonic deadline, optional sanitized error); no payload
        self._flights = {}
        self._loop = None
        self._health = OrderedDict()  # Process-local, no URLs, bodies or endpoint data.

    def _record(self, key):
        if key not in self._health:
            source, country = key
            self._health[key] = dict(source=source.name if isinstance(source, Source) else source,
                                     group=(source.group or source.name) if isinstance(source, Source) else source,
                                     country=country, fetches=0, errors=0, internal_errors=0, cancellations=0,
                                     last_fetch_at=None, completed=0,
                                     duration_ms=0.0, last_duration_ms=None, fetched_at=None,
                                     updated_at=None, outcome=None, failures=0,
                                     cache_hits=0, shared=0, deferred=0)
        self._health.move_to_end(key)
        while len(self._health) > BACKOFF_LIMIT:
            self._health.popitem(last=False)
        return self._health[key]

    def metrics(self, country):
        """Detached bounded diagnostics for one exact country; timestamps may be unknown."""
        if not isinstance(country, str) or not re.fullmatch(r'[A-Z]{2}', country):
            raise ValueError('Invalid country')
        now = self.clock()
        return [dict(row, retry_in_ms=max(0.0, (self.next_allowed.get(key, (now,))[0] - now) * 1000))
                for key, row in self._health.items() if key[1] == country]

    def _delivery(self, key, value, delivery):
        field = {'cache': 'cache_hits', 'shared': 'shared', 'deferred': 'deferred'}.get(delivery)
        if field:
            self._record(key)[field] += 1
        return replace(value, delivery=delivery)

    def _failure_wait(self, failures, minimum):
        # Keep the established probe cadence: episodic recovery can carry unique
        # endpoints that a longer adaptive pause would miss.
        return max(FAILURE_TTL, minimum)

    def get(self, key):
        entry = self.entries.get(key)
        if entry is None:
            return None
        expires, value = entry
        if expires <= self.clock():
            del self.entries[key]
            return None
        self.entries.move_to_end(key)
        return value

    def put(self, key, value, ttl):
        self.entries[key] = (self.clock() + ttl, value)
        self.entries.move_to_end(key)
        while len(self.entries) > self.limit:
            self.entries.popitem(last=False)

    def _slots(self, is_library):
        loop = asyncio.get_running_loop()
        if self._loop is not loop:
            if self._flights:
                raise RuntimeError('Source cache is in use by another event loop')
            self._loop = loop
            self._feed_slots = _CountrySlots(FEED_CONCURRENCY)
            self._library_slot = _CountrySlots(1)
        return self._library_slot if is_library else self._feed_slots

    async def load(self, key, produce, *, ttl, minimum, error, is_library=False):
        slots = self._slots(is_library)
        while True:
            flight = self._flights.get(key)
            if flight is None:
                break
            if not flight.abandoned:
                return self._delivery(key, await self._join(key, flight), 'shared')
            # The final previous owner already cancelled this fetch. Its cleanup
            # must finish before a new owner retries or consults the backoff.
            await flight.released.wait()
        value = self.get(key)
        if value is not None:
            return self._delivery(key, value, 'cache')
        now = self.clock()
        guard = self.next_allowed.get(key)
        if guard is not None and guard[0] > now:
            row = self._record(key)
            return self._delivery(key, _Payload(error=guard[1], outcome=row['outcome'] if guard[1] else 'min_interval'), 'deferred')

        async def one():
            async with slots.slot(key[1]):
                if key not in self.next_allowed and len(self.next_allowed) >= BACKOFF_LIMIT:
                    self.next_allowed = {k: v for k, v in self.next_allowed.items() if v[0] > self.clock()}
                    if len(self.next_allowed) >= BACKOFF_LIMIT:
                        # Do not evict an active guard to accommodate an unknown key.
                        return self._delivery(key, _Payload(error=error, outcome='internal_error'), 'deferred')
                # A started request retains the established guard even on cancellation;
                # cancellation is never evidence for extending that guard.
                started = self.clock()
                self.next_allowed[key] = (started + max(FAILURE_TTL, minimum), None)
                row = self._record(key)
                row['fetches'] += 1
                row['last_fetch_at'] = self.wall()
                try:
                    items = await produce()
                    candidates = tuple(islice(items, PER_FEED_LIMIT))
                    if asyncio.current_task().cancelling():
                        raise asyncio.CancelledError
                    value = _Payload(candidates, fetched_at=self.wall(),
                                     outcome='ok' if candidates else 'empty')
                    row['failures'] = 0
                    wait = max(ttl, minimum)
                except asyncio.CancelledError:
                    raise
                except FeedFailure as exc:
                    if asyncio.current_task().cancelling():
                        raise asyncio.CancelledError
                    row['errors'] += 1
                    row['failures'] += 1
                    wait = self._failure_wait(row['failures'], minimum)
                    value = _Payload(error=error, outcome=exc.reason)
                except Exception:
                    if asyncio.current_task().cancelling():
                        raise asyncio.CancelledError
                    # Opaque library/local errors are observable, not provider health evidence.
                    row['internal_errors'] += 1
                    wait = max(FAILURE_TTL, minimum)
                    value = _Payload(error=error, outcome='internal_error')
                finally:
                    if asyncio.current_task().cancelling():
                        row['cancellations'] += 1
                        row['outcome'] = 'cancelled'
                    duration = max(0.0, (self.clock() - started) * 1000)
                    row['last_duration_ms'] = duration
                    row['duration_ms'] += duration
                if asyncio.current_task().cancelling():
                    raise asyncio.CancelledError
                value = replace(value, fetch_duration_ms=duration)
                row['completed'] += 1
                row['outcome'] = value.outcome
                row['fetched_at'] = value.fetched_at
                self.next_allowed[key] = (self.clock() + wait, value.error)
                if wait:
                    self.put(key, value, wait)
                return value

        flight = _Flight(asyncio.create_task(one()), asyncio.Event())
        self._flights[key] = flight
        return await self._join(key, flight)

    async def _join(self, key, flight):
        flight.owners += 1
        try:
            return await asyncio.shield(flight.task)
        finally:
            flight.owners -= 1
            if not flight.owners:
                flight.abandoned = True
                if not flight.task.done():
                    flight.task.cancel()
                try:
                    await await_cleanup(asyncio.gather(flight.task, return_exceptions=True))
                finally:
                    self._flights.pop(key)
                    flight.released.set()


CACHE = SourceCache()


def fair_merge(pools, cap):
    """Round-robin unique endpoints so an early large feed cannot consume the cap."""
    pending = deque(iter(pool) for pool in pools)
    result, seen = [], set()
    while pending and len(result) < cap:
        iterator = pending.popleft()
        try:
            item = next(iterator)
        except StopIteration:
            continue
        pending.append(iterator)
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def parse_feed(source, raw, country, parse):
    if not isinstance(raw, str) or len(raw) > BODY_LIMIT or len(raw.encode('utf-8')) > BODY_LIMIT:
        raise FeedFailure('parser_error')
    # Avoid materializing the complete list of lines or parsed endpoints. Input
    # text is already byte-bounded; stop as soon as this feed's unique cap is met.
    if source.format == 'text' or source.format.startswith('plain-'):
        found = {}
        for match in re.finditer(r'[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]+', raw):
            line = match.group().strip()
            if source.format != 'text':
                if not re.fullmatch(r'\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}', line):
                    continue
                line = source.format.removeprefix('plain-') + '://' + line
            for candidate in parse(line):
                found[candidate] = None
                if len(found) == PER_FEED_LIMIT:
                    return list(found)
        return list(found)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise FeedFailure('parser_error') from exc
    if source.format == 'hproxy-live':
        if not isinstance(data, list):
            raise FeedFailure('parser_error')
        rows = data
    else:
        field = {'geonode': 'data', 'proxmint': 'rows'}.get(source.format)
        if field is None or not isinstance(data, dict) or not isinstance(data.get(field), list):
            raise FeedFailure('parser_error')
        rows = data[field]
    country_field = {'geonode': 'country', 'proxmint': 'countryCode', 'hproxy-live': 'country_code'}[source.format]
    result = {}
    for row in islice(rows, 2000):
        if not isinstance(row, dict):
            continue
        if source.format == 'hproxy-live':
            # The live API's timestamps are provider observations, not local proof.
            # Ignore recently_alive rows and known/invalid TLS interception flags.
            intercepted = row.get('tls_intercepted')
            if row.get('status') != 'alive' or (intercepted is not None and intercepted is not False):
                continue
        cc = row.get(country_field)
        if not isinstance(cc, str) or cc.upper() != country:
            continue
        host, port = row.get('ip'), row.get('port')
        if not isinstance(host, str) or not re.fullmatch(r'\d{1,3}(?:\.\d{1,3}){3}', host):
            continue
        if type(port) not in (int, str) or not re.fullmatch(r'\d{1,5}', str(port)):
            continue
        protocols = [row.get('protocol')] if source.format == 'proxmint' else row.get('protocols')
        if not isinstance(protocols, list):
            continue
        for protocol in protocols[:4]:
            # JSON lists use "https" for CONNECT, not TLS-to-proxy.
            if protocol == 'https':
                protocol = 'http'
            if protocol in ('http', 'socks4', 'socks5'):
                for item in parse(f'{protocol}://{host}:{port}'):
                    result[item] = None
                    if len(result) == PER_FEED_LIMIT:
                        return list(result)
    return list(result)


def provider_groups(sources=SOURCES):
    return tuple(dict.fromkeys([LIBRARY_NAME, *(s.group or s.name for s in sources)]))


async def stream_feeds(country, fetch, parse, library, *, sources=SOURCES, cache=CACHE):
    """Emit at feed completion. Consumers that break early must close the iterator."""
    if not isinstance(country, str) or not re.fullmatch(r'[A-Z]{2}', country):
        raise ValueError('Invalid country')
    sources = tuple(sources)
    names = [LIBRARY_NAME, *(source.name for source in sources)]
    if len(names) != len(set(names)):
        raise ValueError('Source names must be unique')
    groups = Counter([LIBRARY_NAME, *(source.group or source.name for source in sources)])

    async def one(source):
        if source is None:
            value = await cache.load((LIBRARY_NAME, country), library, ttl=60, minimum=0,
                                     error=LIBRARY_NAME + ': источник недоступен', is_library=True)
            return LIBRARY_NAME, LIBRARY_NAME, value

        async def obtain():
            rc, status, raw = await fetch(source.for_country(country))
            if rc:
                raise ValueError('Transport failure')
            if status == '404' and source.empty_404:
                return ()
            if status != '200':
                if isinstance(status, str) and re.fullmatch(r'[45][0-9]{2}', status):
                    raise FeedFailure('transport_error')
                raise ValueError('Ambiguous response status')
            return parse_feed(source, raw, country, parse)

        value = await cache.load((source, country), obtain, ttl=source.ttl, minimum=source.min_interval,
                                 error=source.name + ': источник недоступен или неверный формат')
        return source.group or source.name, source.name, value

    tasks = [asyncio.create_task(one(source)) for source in (None, *sources)]
    try:
        for done in asyncio.as_completed(tasks):
            group, name, value = await done
            groups[group] -= 1
            yield SourceBatch(group, name, value.candidates, value.error, value.fetched_at, groups[group] == 0,
                              value.delivery, value.outcome, value.fetch_duration_ms, value.updated_at)
    finally:
        for task in tasks:
            if not task.done() and not task.cancelling():
                task.cancel()
        await await_cleanup(asyncio.gather(*tasks, return_exceptions=True))


async def collect(country, fetch, parse, library, cap=120, sources=SOURCES, cache=CACHE):
    """Compatibility collector; preserve declared source order for deterministic callers."""
    sources = tuple(sources)
    batches = {}
    async with aclosing(stream_feeds(country, fetch, parse, library, sources=sources, cache=cache)) as stream:
        async for batch in stream:
            batches[batch.source] = batch
    groups, errors = {}, []
    for name in (LIBRARY_NAME, *(source.name for source in sources)):
        batch = batches[name]
        groups.setdefault(batch.group, []).append(batch.candidates)
        if batch.error:
            errors.append(batch.error)
    pools = [fair_merge(shards, PER_FEED_LIMIT) for shards in groups.values()]
    return fair_merge(pools, max(0, min(cap, 120))), errors
