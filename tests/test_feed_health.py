"""Offline fixed schedules distinguish provider health from payload/check health."""
import asyncio
from contextlib import aclosing, nullcontext
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import parse_candidates
from sources import Source, SourceCache, stream_feeds

TXT = 'http://8.8.8.8:80'


async def empty():
    return ()


async def turn(cache, feeds, fetch, country='NO', parse=parse_candidates):
    async with aclosing(stream_feeds(country, fetch, parse, empty, sources=feeds, cache=cache)) as stream:
        return {b.source: b async for b in stream}


def row(cache, name, country='NO'):
    return next(r for r in cache.metrics(country) if r['source'] == name)


async def evaluate_policy(cap, episodic=False):
    """Same fixed input schedule; exponential candidate exists only in this harness."""
    now = [0]
    cache = SourceCache(clock=lambda: now[0])
    feeds = [Source('live', 'https://example.org/live/{country}', ttl=60, group='one'),
             Source('mirror', 'https://example.org/mirror/{country}', ttl=60, group='one')]
    calls, coverage, recovered = [], set(), None
    async def fetch(url):
        calls.append((now[0], url))
        if '/live/NO' in url:
            alive = 120 <= now[0] < 150 if episodic else now[0] >= 181
            if not alive:
                return 0, '503', ''
            return 0, '200', 'http://1.1.1.1:8080'
        return 0, '200', TXT
    experiment = (patch.object(SourceCache, '_failure_wait',
                  lambda self, failures, minimum: max(minimum, min(cap, 60 * 2 ** min(3, failures - 1))))
                  if cap > 60 else nullcontext())
    with experiment:
        for tick in range(0, 601, 30):
            now[0] = tick
            for cc in ('NO', 'SE'):
                batches = await turn(cache, feeds, fetch, cc)
                for name, batch in batches.items():
                    for candidate in batch.candidates:
                        coverage.add(str(candidate))
                    if name == 'live' and cc == 'NO' and batch.candidates and recovered is None:
                        recovered = tick
    counts = {name + '/' + cc: sum(url.endswith('/' + name + '/' + cc) for _, url in calls)
              for name in ('live', 'mirror') for cc in ('NO', 'SE')}
    return dict(contacts=counts, coverage=sorted(coverage), recovery_at=recovered,
                actual_fetches=len(calls),
                confirmed_errors=sum(r['errors'] for cc in ('NO', 'SE') for r in cache.metrics(cc)))


class FeedHealthTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_failed_physical_feed_defers_with_finite_recovery(self):
        baseline, adaptive = await evaluate_policy(60), await evaluate_policy(300)
        self.assertLess(adaptive['contacts']['live/NO'], baseline['contacts']['live/NO'])
        for name in ('mirror/NO', 'mirror/SE', 'live/SE'):
            self.assertEqual(adaptive['contacts'][name], baseline['contacts'][name])
        self.assertEqual(adaptive['coverage'], baseline['coverage'])
        self.assertEqual(baseline['recovery_at'], 240)
        self.assertEqual(adaptive['recovery_at'], 420)
        self.assertLessEqual(adaptive['recovery_at'] - 181, 300 + 30)

    async def test_episodic_unique_payload_rejects_exponential_default(self):
        baseline = await evaluate_policy(60, episodic=True)
        adaptive = await evaluate_policy(300, episodic=True)
        self.assertEqual(baseline['recovery_at'], 120)
        self.assertIsNone(adaptive['recovery_at'])
        self.assertLess(len(adaptive['coverage']), len(baseline['coverage']))
        self.assertEqual(SourceCache()._failure_wait(4, 0), 60)
        self.assertEqual(SourceCache()._failure_wait(4, 300), 300)

    async def test_cache_does_not_recount_error_duration_or_refresh_age(self):
        now, wall = [0], [1000]
        cache = SourceCache(clock=lambda: now[0], wall=lambda: wall[0])
        feed = Source('one', 'https://example.org', ttl=60)
        async def fetch(url):
            now[0] += .125
            return 0, '200', TXT
        first = (await turn(cache, [feed], fetch))['one']
        now[0], wall[0] = 1, 2000
        replay = (await turn(cache, [feed], fetch))['one']
        self.assertEqual((first.delivery, replay.delivery), ('fetch', 'cache'))
        self.assertEqual((first.fetch_duration_ms, replay.fetch_duration_ms), (125, 125))
        self.assertEqual((first.fetched_at, replay.fetched_at), (1000, 1000))
        self.assertIsNone(first.updated_at)
        self.assertIsNone(replay.updated_at)
        metric = row(cache, 'one')
        self.assertEqual((metric['fetches'], metric['duration_ms'], metric['cache_hits']), (1, 125, 1))
        metric['fetches'] = 999
        self.assertEqual(row(cache, 'one')['fetches'], 1)

    async def test_provider_row_updated_at_is_not_source_list_time(self):
        import json
        cache = SourceCache(wall=lambda: 1000)
        feed = Source('one', 'https://example.org', 'geonode')
        async def fetch(url):
            return 0, '200', json.dumps({'updatedAt': 999, 'data': [dict(
                ip='8.8.8.8', port=80, country='NO', protocols=['http'], updatedAt=998)]})
        batch = (await turn(cache, [feed], fetch))['one']
        self.assertTrue(batch.candidates)
        self.assertEqual(batch.fetched_at, 1000)
        self.assertIsNone(batch.updated_at)
        self.assertIsNone(row(cache, 'one')['updated_at'])

    async def test_empty_404_and_filtered_empty_reset_failure_streak(self):
        for status, body in [('404', ''), ('200', 'not an endpoint')]:
            with self.subTest(status=status):
                now = [0]
                cache = SourceCache(clock=lambda: now[0])
                feed = Source('one', 'https://example.org', ttl=60, empty_404=True)
                failing = True
                async def fetch(url):
                    return (0, '503', '') if failing else (0, status, body)
                await turn(cache, [feed], fetch)
                now[0] = 60
                failing = False
                batch = (await turn(cache, [feed], fetch))['one']
                self.assertEqual(batch.outcome, 'empty')
                self.assertEqual(batch.candidates, ())
                self.assertIsNotNone(batch.fetched_at)
                metric = row(cache, 'one')
                self.assertEqual((metric['failures'], metric['errors'], metric['completed']), (0, 1, 2))
                self.assertEqual(metric['retry_in_ms'], 60000)

    async def test_classified_errors_never_extend_production_baseline(self):
        for mode in ('local', 'opaque_parser', 'schema'):
            with self.subTest(mode=mode):
                now = [0]
                cache = SourceCache(clock=lambda: now[0])
                feed = Source('one', 'https://example.org', 'geonode' if mode == 'schema' else 'text')
                async def fetch(url):
                    return (127, '000', '') if mode == 'local' else (0, '200', '{')
                def parse(raw):
                    if mode == 'opaque_parser':
                        raise RuntimeError('private details')
                    return parse_candidates(raw)
                await turn(cache, [feed], fetch, parse=parse)
                now[0] = 60
                batch = (await turn(cache, [feed], fetch, parse=parse))['one']
                metric = row(cache, 'one')
                if mode == 'schema':
                    self.assertEqual((batch.outcome, metric['failures'], metric['retry_in_ms']),
                                     ('parser_error', 2, 60000))
                else:
                    self.assertEqual((batch.outcome, metric['failures'], metric['retry_in_ms']),
                                     ('internal_error', 0, 60000))
                    self.assertEqual(metric['internal_errors'], 2)
                self.assertNotIn('private', str(cache.metrics('NO')))

    async def test_cancel_and_min_interval_are_not_provider_failures(self):
        now = [0]
        cache = SourceCache(clock=lambda: now[0])
        feed = Source('one', 'https://example.org', min_interval=300)
        entered = asyncio.Event()
        async def fetch(url):
            entered.set()
            await asyncio.Future()
        task = asyncio.create_task(turn(cache, [feed], fetch))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        metric = row(cache, 'one')
        self.assertEqual((metric['fetches'], metric['completed'], metric['errors'], metric['failures']), (1, 0, 0, 0))
        self.assertEqual(metric['cancellations'], 1)
        now[0] = 1
        batch = (await turn(cache, [feed], fetch))['one']
        self.assertEqual((batch.delivery, batch.outcome), ('deferred', 'min_interval'))
        self.assertEqual(row(cache, 'one')['fetches'], 1)

    async def test_swallowed_cancel_cannot_reset_or_increase_health(self):
        cache = SourceCache()
        entered = asyncio.Event()
        feed = Source('one', 'https://example.org')
        async def fetch(url):
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                return 0, '200', TXT
        task = asyncio.create_task(turn(cache, [feed], fetch))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        metric = row(cache, 'one')
        self.assertEqual((metric['completed'], metric['failures'], metric['cancellations']), (0, 0, 1))
        self.assertEqual(metric['outcome'], 'cancelled')
        self.assertIsNone(metric['fetched_at'])

    async def test_bounded_process_local_diagnostics(self):
        cache = SourceCache()
        async def fetch(url):
            return 0, '200', TXT
        with patch('sources.BACKOFF_LIMIT', 4):
            for cc in ('NO', 'SE', 'JP'):
                await turn(cache, [Source('one', 'https://example.org')], fetch, cc)
            self.assertLessEqual(len(cache._health), 4)
            self.assertTrue(all(r['country'] == 'JP' for r in cache.metrics('JP')))
        with self.assertRaises(ValueError):
            cache.metrics('../NO')


if __name__ == '__main__':
    unittest.main()
