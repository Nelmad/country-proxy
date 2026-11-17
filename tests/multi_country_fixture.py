#!/usr/bin/env python3
"""Owned-profile fixture for multi-country UI/failover; real TLS and GeoIP.

Two loopback ports share the machine's real country and egress. Only endpoint
identity is relaxed, exactly as in fixture_host.py. This is not evidence of
cross-country or distinct public-IP replacement. Never register in normal Chrome.
"""
import asyncio
import hashlib
from contextlib import aclosing
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
import host
from core import Candidate, Session
from sources import Source, SourceCache, provider_groups, stream_feeds
from pool import ReservePool


def configure(config_path):
    config_path = Path(config_path).resolve()
    config_path.relative_to(ROOT / '.runtime')
    config = json.loads(config_path.read_text())
    ports = config['ports']
    if (not isinstance(ports, list) or len(ports) != 2 or len(set(ports)) != 2
            or any(type(port) is not int or not 0 < port < 65536 for port in ports)):
        raise ValueError('Exactly two distinct fixture ports required')
    candidates = [Candidate('http', '127.0.0.1', port) for port in ports]
    events = config_path.parent / 'native-events.jsonl'

    def record(value):
        with events.open('a') as output:
            output.write(json.dumps({'at': time.time(), 'mono': time.monotonic(), **value}) + '\n')

    record({'event': 'start', 'fingerprints': {
        source.name: hashlib.sha256(source.read_bytes()).hexdigest()
        for source in sorted((ROOT / 'native').glob('*.py'))}})

    async def discover_fixture(requested):
        record({'event': 'discover', 'country': requested})
        # Every selected source bucket returns the same actual endpoints. The
        # unmodified checker decides whether real GeoIP is in the selected set.
        return candidates, []

    class FixturePool(ReservePool):
        def conflicts(self, left, right):
            return (left['host'], left['port']) == (right['host'], right['port'])

        def candidate_conflicts(self, item, proxy):
            return (item.host, item.port) == (proxy['host'], proxy['port'])

    class FixtureSession(Session):
        async def _raw_report(self, item, country, slow=False, extras=None):
            record({'event': 'checker-start', 'session': self.fixture_id,
                    'candidate': item.key, 'pending': sorted(self.pending),
                    'streams': dict(self.stream_ids)})
            result = await super()._raw_report(item, country, slow, extras)
            record({'event': 'checker-result', 'session': self.fixture_id,
                    'candidate': item.key, 'accepted': result['ok']})
            return result

        def __init__(self, requested, emit):
            self.fixture_id = f'{time.monotonic_ns()}'
            self.pending, self.stream_ids = set(), {}
            selected = [requested] if isinstance(requested, str) else list(requested)
            streaming = config.get('streaming', False)
            quality = config.get('sourceQuality', False)
            observed_cache = SourceCache() if quality else None
            feeds = (Source('fixture-fast', 'fixture://fast/{country}'),
                     Source('fixture-slow', 'fixture://slow/{country}'))
            if quality:
                feeds += (Source('fixture-mirror', 'fixture://mirror/{country}', group='fixture-fast'),
                          Source('fixture-peer', 'fixture://peer/{country}'))
            release = config_path.parent / 'release-slow'
            started = set()
            ready = asyncio.Event()
            serial = 0

            async def source_stream(cc):
                nonlocal serial
                serial += 1
                lease = f'{self.fixture_id}:{serial}:{cc}'
                self.stream_ids[cc] = lease
                record({'event': 'discover', 'country': cc, 'lease': lease,
                        'session': self.fixture_id})
                cache = observed_cache or SourceCache()
                async def fetch(url):
                    kind = url.split('/')[2]
                    key = f'{lease}:{kind}'
                    self.pending.add(key)
                    record({'event': 'feed-start', 'lease': lease, 'kind': kind,
                            'country': cc, 'session': self.fixture_id})
                    try:
                        if kind == 'slow':
                            started.add(cc)
                            if set(selected) <= started:
                                ready.set()
                            while not release.exists():
                                await asyncio.sleep(.02)
                        else:
                            if not release.exists():
                                await ready.wait()
                            record({'event': 'fast-release', 'lease': lease,
                                    'pending': sorted(self.pending)})
                        return 0, '200', 'owned-endpoints' if kind != 'slow' else ''
                    except asyncio.CancelledError:
                        record({'event': 'feed-cancel', 'lease': lease, 'kind': kind,
                                'country': cc, 'session': self.fixture_id})
                        raise
                    finally:
                        self.pending.discard(key)
                        record({'event': 'feed-disposed', 'lease': lease, 'kind': kind,
                                'country': cc, 'session': self.fixture_id})
                async def library():
                    return ()
                try:
                    async with aclosing(stream_feeds(cc, fetch,
                            lambda raw: candidates if raw == 'owned-endpoints' else [],
                            library, sources=feeds, cache=cache)) as batches:
                        async for batch in batches:
                            record({'event': 'batch', 'lease': lease, 'source': batch.source})
                            yield batch
                finally:
                    record({'event': 'stream-disposed', 'lease': lease,
                            'session': self.fixture_id,
                            'pending': sorted(k for k in self.pending if k.startswith(lease + ':')),
                            'flights': sum(1 for _, country in cache._flights if country == cc)})
            def observed(event):
                if event.get('phase') == 'connected':
                    record({'event': 'connected', 'requested': requested,
                            'session': self.fixture_id, 'pending': sorted(self.pending),
                            'country': event.get('country'), 'proxy': event['proxy']})
                emit(event)
            options = {}
            if streaming:
                options = {'source_stream': source_stream,
                           'source_groups': provider_groups(feeds), 'feed_cache': observed_cache}
            super().__init__(requested, observed, discoverer=discover_fixture,
                             pool_factory=FixturePool, **options)

        def eligible(self, candidate):
            return self.excluded.get(candidate.key, 0) <= time.monotonic()

        def exclude(self, candidate, seconds=180):
            self.excluded[candidate.key] = time.monotonic() + seconds

    return FixtureSession


if __name__ == '__main__':
    host.Session = configure(sys.argv[1])
    asyncio.run(host.main())
