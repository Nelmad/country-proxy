"""Country-scoped public feeds. All records still pass core's strict endpoint parser."""
import asyncio
from collections import OrderedDict, deque
from dataclasses import dataclass
import json
import re
import time

PER_FEED_LIMIT = 120


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    format: str = 'text'
    ttl: int = 300
    empty_404: bool = False
    group: str = ''

    def for_country(self, country):
        if not re.fullmatch(r'[A-Z]{2}', country):
            raise ValueError('Invalid country')
        return self.url.format(country=country, lower=country.lower())


SOURCES = (
    Source('hproxy', 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/by-country/{country}.txt', empty_404=True),
    Source('Proxifly', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/{country}/data.txt', empty_404=True),
    Source('ProxyScrape', 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=all&country={country}&timeout=60000&proxy_format=protocolipport&format=text&limit=2000', ttl=60),
    Source('GeoNode', 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&country={country}', 'geonode'),
    Source('Litport', 'https://raw.githubusercontent.com/litportnet/free-proxy-list/live/proxies/countries/{lower}/all.txt', empty_404=True),
    Source('ProxMint', 'https://proxmint.com/api/free-proxies?country={lower}&pageSize=200&sort=checked', 'proxmint', ttl=1800),
    *(Source('Databay/' + scheme, 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/{lower}/' + scheme + '.txt',
             'plain-' + scheme, empty_404=True, group='Databay') for scheme in ('http', 'https', 'socks4', 'socks5')),
)


class SourceCache:
    """Bounded, process-local cache; failed requests back off for one minute."""
    def __init__(self, clock=time.monotonic, limit=160):
        self.clock, self.limit = clock, limit
        self.entries = OrderedDict()

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
    if source.format == 'text':
        return parse(raw)[:PER_FEED_LIMIT]
    if source.format.startswith('plain-'):
        scheme = source.format.removeprefix('plain-')
        # A protocol-specific file must contain bare endpoints, not URL overrides.
        lines = [scheme + '://' + line.strip() for line in raw.splitlines()
                 if re.fullmatch(r'\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}', line.strip())]
        return parse('\n'.join(lines))[:PER_FEED_LIMIT]
    data = json.loads(raw)
    field = {'geonode': 'data', 'proxmint': 'rows'}.get(source.format)
    if field is None or not isinstance(data, dict) or not isinstance(data.get(field), list):
        raise ValueError('Invalid feed schema')
    result = []
    for row in data[field][:2000]:
        if not isinstance(row, dict):
            continue
        cc = row.get('country' if source.format == 'geonode' else 'countryCode')
        if not isinstance(cc, str) or cc.upper() != country:
            continue
        host, port = row.get('ip'), row.get('port')
        if not isinstance(host, str) or not re.fullmatch(r'\d{1,3}(?:\.\d{1,3}){3}', host):
            continue
        if type(port) not in (int, str) or not re.fullmatch(r'\d{1,5}', str(port)):
            continue
        protocols = row.get('protocols') if source.format == 'geonode' else [row.get('protocol')]
        if not isinstance(protocols, list):
            continue
        for protocol in protocols[:4]:
            if protocol in ('http', 'socks4', 'socks5'):
                result.extend(parse(f'{protocol}://{host}:{port}'))
            # JSON feeds use "https" for CONNECT capability, not TLS-to-proxy.
            elif protocol == 'https':
                result.extend(parse(f'http://{host}:{port}'))
    return list(dict.fromkeys(result))[:PER_FEED_LIMIT]


async def collect(country, fetch, parse, library, cap=120, sources=SOURCES, cache=CACHE):
    if not isinstance(country, str) or not re.fullmatch(r'[A-Z]{2}', country):
        raise ValueError('Invalid country')

    async def one(source):
        key = (source, country)
        cached = cache.get(key)
        if cached is not None:
            return cached
        try:
            rc, status, raw = await fetch(source.for_country(country))
            if rc:
                raise ValueError('Transport failure')
            if status == '404' and source.empty_404:
                values = []
            elif status == '200':
                values = parse_feed(source, raw, country, parse)
            else:
                raise ValueError('HTTP failure')
            value = (values, None)
            cache.put(key, value, source.ttl)
        except Exception:
            value = ([], source.name + ': источник недоступен или неверный формат')
            cache.put(key, value, 60)
        return value

    results = await asyncio.gather(library(), *(one(s) for s in sources), return_exceptions=True)
    groups, errors = {}, []
    if isinstance(results[0], BaseException):
        errors.append('proxy-scraper: источник недоступен')
    else:
        groups['proxy-scraper'] = [results[0][:PER_FEED_LIMIT]]
    for source, result in zip(sources, results[1:]):
        if isinstance(result, BaseException):
            errors.append(source.name + ': источник недоступен')
            continue
        values, error = result
        if error:
            errors.append(error)
        groups.setdefault(source.group or source.name, []).append(values)
    # Protocol shards belong to one provider and receive one provider's share.
    pools = [fair_merge(shards, PER_FEED_LIMIT) for shards in groups.values()]
    return fair_merge(pools, max(0, min(cap, 120))), errors
