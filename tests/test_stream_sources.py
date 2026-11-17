"""Resource, fairness and ownership checks on the real feed stream (offline)."""
import asyncio
from collections import Counter
from contextlib import aclosing
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import parse_candidates
from sources import (BODY_LIMIT, Source, SourceCache, SOURCES, collect, parse_feed,
                     provider_groups, stream_feeds)


TXT = 'http://8.8.8.8:80'


async def empty():
    return []


async def consume(cc, fetch, cache, *, library=empty, feeds=()):
    async with aclosing(stream_feeds(cc, fetch, parse_candidates, library,
                                     sources=feeds, cache=cache)) as stream:
        return [event async for event in stream]


async def wait(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0)


class FeedStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_completed_feed_yields_without_slow_sibling_and_group_closes_once(self):
        feeds = (Source('slow', 'https://example.org/slow', group='mirror'),
                 Source('fast', 'https://example.org/fast', group='mirror'))
        self.assertEqual(provider_groups(feeds), ('proxy-scraper', 'mirror'))
        slow_started, release = asyncio.Event(), asyncio.Event()
        async def fetch(url):
            if url.endswith('slow'):
                slow_started.set(); await release.wait()
            return 0, '200', TXT
        async with aclosing(stream_feeds('NO', fetch, parse_candidates, empty,
                                         sources=feeds, cache=SourceCache())) as stream:
            awaitables = []
            async with asyncio.timeout(2):
                async for batch in stream:
                    awaitables.append(batch)
                    if batch.source == 'fast':
                        break
            self.assertTrue(slow_started.is_set())
            self.assertFalse(batch.complete)
            self.assertEqual(batch.candidates, tuple(parse_candidates(TXT)))
            release.set()
            remaining = [event async for event in stream]
            all_batches = awaitables + remaining
            self.assertEqual([b.complete for b in all_batches if b.group == 'mirror'], [False, True])
            self.assertEqual([b.source for b in all_batches if b.group == 'mirror'], ['fast', 'slow'])

    async def test_slots_rotate_three_cold_countries_and_library_has_its_own_lane(self):
        feeds = tuple(Source(str(i), 'https://example.org/{country}/'+str(i)) for i in range(8))
        cache = SourceCache(); release = asyncio.Event(); starts = []; libs = []
        live_feed = peak_feed = live_lib = peak_lib = 0
        async def fetch(url):
            nonlocal live_feed, peak_feed
            starts.append(url.split('/')[-2]); live_feed += 1; peak_feed = max(peak_feed, live_feed)
            try: await release.wait(); return 0, '200', TXT
            finally: live_feed -= 1
        def lib(cc):
            async def fetch_lib():
                nonlocal live_lib, peak_lib
                libs.append(cc); live_lib += 1; peak_lib = max(peak_lib, live_lib)
                try: await release.wait(); return []
                finally: live_lib -= 1
            return fetch_lib
        selected = ('NO', 'EE', 'AT')
        tasks = [asyncio.create_task(consume(cc, fetch, cache, library=lib(cc), feeds=feeds)) for cc in selected]
        try:
            await wait(lambda: len(starts) >= 6 and libs)
            self.assertEqual(Counter(starts), dict.fromkeys(selected, 2))
            self.assertEqual(len(libs), 1)
        finally:
            release.set(); await asyncio.gather(*tasks)
        self.assertEqual((peak_feed, peak_lib, live_feed, live_lib), (6, 1, 0, 0))
        self.assertEqual(Counter(starts), dict.fromkeys(selected, 8))
        self.assertCountEqual(libs, selected)

    async def test_single_country_uses_six_slots_and_close_drains_started_and_queued_work(self):
        feeds = tuple(Source(str(i), 'https://example.org/{country}/'+str(i)) for i in range(11))
        cache = SourceCache(); started = []; ended = []; block = asyncio.Event(); cleanup = asyncio.Event()
        async def fetch(url):
            started.append(url)
            try: await block.wait()
            finally: await cleanup.wait(); ended.append(url)
        task = asyncio.create_task(consume('NO', fetch, cache, feeds=feeds))
        await wait(lambda: len(started) == 6)
        task.cancel(); await wait(lambda: any(f.abandoned for f in cache._flights.values()))
        task.cancel(); await asyncio.sleep(0)
        self.assertFalse(task.done()); self.assertEqual(len(started), 6)
        cleanup.set()
        with self.assertRaises(asyncio.CancelledError): await asyncio.wait_for(task, 2)
        self.assertCountEqual(ended, started); self.assertEqual(cache._flights, {})
        # Queued but never-started fetches did not incur a backoff or hold slots.
        self.assertEqual({s.name for (s, _) in cache.next_allowed if isinstance(s, Source)},
                         {url.rsplit('/', 1)[-1] for url in started})
        self.assertEqual(cache._feed_slots.free, 6); self.assertFalse(cache._feed_slots.queues)

    async def test_aclose_after_one_batch_cancels_and_awaits_owned_fetches(self):
        feeds = (Source('hang', 'https://example.org/hang'), Source('win', 'https://example.org/win'))
        started, stopped = asyncio.Event(), asyncio.Event(); cache = SourceCache()
        async def fetch(url):
            if url.endswith('hang'):
                started.set()
                try: await asyncio.Event().wait()
                finally: await asyncio.sleep(0); stopped.set()
            await started.wait(); return 0, '200', TXT
        async with aclosing(stream_feeds('EE', fetch, parse_candidates, empty, sources=feeds, cache=cache)) as stream:
            async for ev in stream:
                if ev.source == 'win': break
        self.assertTrue(stopped.is_set()); self.assertFalse(cache._flights)
        self.assertIsNotNone(cache.get((feeds[1], 'EE')))
        self.assertIsNone(cache.get((feeds[0], 'EE')))

    async def test_singleflight_shares_fetch_and_cancellation_of_one_consumer_is_neutral(self):
        feed = Source('one', 'https://example.org/one'); cache = SourceCache()
        start, release = asyncio.Event(), asyncio.Event(); calls = []
        async def fetch(url):
            calls.append(url); start.set(); await release.wait(); return 0, '200', TXT
        t1, t2 = [asyncio.create_task(consume('AT', fetch, cache, feeds=[feed])) for _ in range(2)]
        try:
            await start.wait(); await wait(lambda: cache._flights[(feed, 'AT')].owners == 2)
            t1.cancel()
            with self.assertRaises(asyncio.CancelledError): await t1
            self.assertEqual(calls, [feed.url]); self.assertEqual(cache._flights[(feed, 'AT')].owners, 1)
        finally:
            release.set(); events = await t2
        self.assertEqual(next(b for b in events if b.source == 'one').candidates, tuple(parse_candidates(TXT)))
        self.assertFalse(cache._flights)

    async def test_original_fetch_timestamp_survives_cache_and_success_guard_survives_eviction(self):
        mono, wall = [0], [1000]; cache = SourceCache(clock=lambda: mono[0], wall=lambda: wall[0], limit=3)
        a, b, c = [Source(k, 'https://example.org/'+k, ttl=300) for k in 'abc']; calls = []
        async def fetch(url): calls.append(url); return 0, '200', TXT
        async def get(source):
            return next(ev for ev in await consume('EE', fetch, cache, feeds=[source]) if ev.source == source.name)
        self.assertEqual((await get(a)).fetched_at, 1000)
        mono[0] = 10; wall[0] = 800
        self.assertEqual((await get(a)).fetched_at, 1000)
        await get(b); await get(c); self.assertIsNone(cache.get((a, 'EE')))
        ev = await get(a); self.assertEqual(ev.candidates, ()); self.assertIsNone(ev.fetched_at)
        self.assertEqual(calls.count(a.url), 1)
        mono[0] = 301; self.assertEqual((await get(a)).fetched_at, 800)
        self.assertEqual(calls.count(a.url), 2)

    async def test_litport_minimum_survives_failure_eviction_and_cancel(self):
        lit = next(s for s in SOURCES if s.name == 'Litport'); other = Source('x', 'https://example.org/x')
        now = [0]; cache = SourceCache(clock=lambda: now[0], limit=1); calls = []; hanging = False
        async def fetch(url):
            calls.append(url)
            if url == other.url: return 0, '200', TXT
            if hanging: await asyncio.Event().wait()
            return 1, '000', ''
        fetch_lit = lambda: consume('NO', fetch, cache, feeds=[lit])
        first = next(b for b in await fetch_lit() if b.source == 'Litport');self.assertIsNotNone(first.error)
        await consume('AT', fetch, cache, feeds=[other]); self.assertIsNone(cache.get((lit, 'NO')))
        now[0] = 61
        self.assertEqual(next(b for b in await fetch_lit() if b.source == 'Litport').error, first.error)
        url = lit.for_country('NO'); self.assertEqual(calls.count(url), 1)
        now[0] = 300; hanging = True; task = asyncio.create_task(fetch_lit())
        await wait(lambda: calls.count(url) == 2); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        now[0] = 599; await fetch_lit(); self.assertEqual(calls.count(url), 2)
        hanging = False; now[0] = 600; await fetch_lit(); self.assertEqual(calls.count(url), 3)

    async def test_backoff_hard_cap_does_not_evict_live_guard(self):
        a, b, c = [Source(k,'https://example.org/'+k) for k in 'abc'];calls=[]; now=[0]
        cache=SourceCache(clock=lambda:now[0],limit=0)
        async def fetch(url): calls.append(url); return 0,'200',TXT
        with patch('sources.BACKOFF_LIMIT',3):
            await consume('NO',fetch,cache,feeds=[a,b]); self.assertEqual(len(cache.next_allowed),3)
            suppressed=await consume('NO',fetch,cache,feeds=[c]);ev=next(e for e in suppressed if e.source=='c')
            self.assertIsNotNone(ev.error); self.assertNotIn(c.url,calls)
            self.assertEqual(len(cache.next_allowed),3)
            await consume('NO',fetch,cache,feeds=[a]);self.assertEqual(calls.count(a.url),1)
            now[0]=301;await consume('NO',fetch,cache,feeds=[c]);self.assertIn(c.url,calls)
            self.assertLessEqual(len(cache.next_allowed),3)

    async def test_body_cap_precedes_parser_and_large_feeds_stop_at_120_unique_endpoints(self):
        src = Source('big', 'https://example.org/big'); called = []
        def parse(data): called.append(data); return parse_candidates(data)
        def fetcher(body):
            async def fetch(_url): return 0, '200', body
            return fetch
        for body in ('a'*(BODY_LIMIT+1), 'о'*(BODY_LIMIT//2+1)):
            async with aclosing(stream_feeds('NO', fetcher(body), parse, empty, sources=[src], cache=SourceCache())) as stream:
                batch = next(b for b in [x async for x in stream] if b.source == 'big')
            self.assertIsNotNone(batch.error); self.assertIsNone(batch.fetched_at)
        self.assertFalse(called)
        text = '\n'.join('http://8.8.8.8:'+str(i+1) for i in range(10000))
        self.assertEqual(len(parse_feed(src, text, 'NO', parse)), 120)
        self.assertEqual(len(called), 120)

    async def test_library_singleflight_uses_original_timestamp_and_120_result_cap(self):
        cache = SourceCache(); started, release = asyncio.Event(), asyncio.Event(); calls = []
        async def lib():
            calls.append(1); started.set(); await release.wait(); return range(9000)
        tasks = [asyncio.create_task(consume('NO', None, cache, library=lib)) for _ in range(3)]
        await started.wait(); release.set(); results = await asyncio.gather(*tasks)
        self.assertEqual(calls, [1]); stamps = []
        for batches in results:
            self.assertEqual(len(batches),1); b=batches[0];self.assertTrue(b.complete)
            self.assertEqual(b.candidates,tuple(range(120))); stamps.append(b.fetched_at)
        self.assertEqual(len(set(stamps)), 1)
        self.assertEqual((await consume('NO',None,cache,library=lib))[0].fetched_at,stamps[0])

if __name__=='__main__': unittest.main()
