"""Offline refill capacity through the actual Session scheduler and check budget."""
import asyncio
from collections import Counter
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, Session
from sources import SourceBatch


def item(number):
    return Candidate('http', f'8.1.{number // 250}.{number % 250 + 1}', 8080)


def proxy(candidate, country='EE'):
    return dict(scheme=candidate.scheme, host=candidate.host, port=candidate.port,
                country=country, exitIp=candidate.host, checkedAt=1, latencyMs=1)


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0)


class RefillCapacity(unittest.IsolatedAsyncioTestCase):
    async def session(self, checker, source, countries='EE', emit=lambda _: None):
        session = Session(countries, emit, checker=checker, source_stream=source,
                          source_groups=('feed',), shuffle=lambda _: None)
        session.active = proxy(item(2000))
        await session.check_budget.set_active(True)
        self.addAsyncCleanup(session.check_budget.close)
        return session

    def owned(self, coroutine):
        task = asyncio.create_task(coroutine)
        async def finish():
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.addAsyncCleanup(finish)
        return task

    async def test_seven_refill_checks_leave_health_and_two_reserve_slots(self):
        release = asyncio.Event()
        started = []
        live = peak = 0
        async def source(_):
            yield SourceBatch('feed', 'feed', tuple(item(n) for n in range(20)), None, 1, True)
        async def checker(candidate, country, slow):
            nonlocal live, peak
            self.assertEqual(country, 'EE')
            self.assertTrue(slow)
            started.append(candidate)
            live += 1
            peak = max(peak, live)
            try:
                await release.wait()
            finally:
                live -= 1
        session = await self.session(checker, source)
        refill = self.owned(session.pool._refill())
        try:
            await until(lambda: len(started) == 7)
            self.assertEqual(session.check_budget.snapshot['roles'],
                             {'health': 0, 'reserve': 0, 'speculative': 7})
            privileged = [self.owned(session.reserve_checked(item(n), 'EE', True))
                          for n in (1000, 1001)]
            privileged.append(self.owned(session._single_report(item(1002), 'EE', True, 'health')))
            await until(lambda: len(started) == 10)
            self.assertEqual(session.check_budget.snapshot['roles'],
                             {'health': 1, 'reserve': 2, 'speculative': 7})
            extra = self.owned(session.speculative_checked(item(1003), 'EE', True))
            await until(lambda: session.check_budget.snapshot['requests'] == 11)
            self.assertEqual(len(started), 10)
            self.assertNotIn(item(1003), started)
            self.assertEqual((live, peak), (10, 10))
            release.set()
            await asyncio.wait_for(asyncio.gather(refill, extra, *privileged), 2)
        finally:
            release.set()
        self.assertEqual(peak, 10)
        self.assertEqual(live, 0)
        self.assertEqual(session.check_budget.snapshot['running'], 0)
        self.assertEqual(session.check_budget.snapshot['requests'], 0)
        self.assertEqual(session.search.last_stats['peak_checks'], 7)
        self.assertEqual(session.pool._probes, {})

    async def test_repeated_cancel_drains_seven_checks_and_source(self):
        release = asyncio.Event()
        cleaning, cleaned = set(), set()
        source_cleaning, source_cleaned = asyncio.Event(), asyncio.Event()
        started = []
        async def source(_):
            try:
                yield SourceBatch('feed', 'feed', tuple(item(n) for n in range(20)), None, 1, False)
                await asyncio.Future()
            finally:
                source_cleaning.set()
                await release.wait()
                source_cleaned.set()
        async def checker(candidate, country, slow):
            self.assertEqual((country, slow), ('EE', True))
            started.append(candidate)
            try:
                await asyncio.Future()
            finally:
                cleaning.add(candidate.key)
                await release.wait()
                cleaned.add(candidate.key)
        session = await self.session(checker, source)
        refill = self.owned(session.pool._refill())
        try:
            await until(lambda: len(started) == 7)
            refill.cancel()
            await until(lambda: len(cleaning) == 7 and source_cleaning.is_set())
            for _ in range(3):
                refill.cancel()
                await asyncio.sleep(0)
            self.assertFalse(refill.done())
            self.assertEqual(cleaned, set())
            self.assertFalse(source_cleaned.is_set())
            self.assertEqual(session.check_budget.snapshot['running'], 7)
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(refill, 2)
        finally:
            release.set()
        self.assertEqual(cleaned, {candidate.key for candidate in started})
        self.assertTrue(source_cleaned.is_set())
        self.assertEqual(session.check_budget.snapshot['running'], 0)
        self.assertEqual(session.check_budget.snapshot['requests'], 0)
        self.assertEqual(session.pool._probes, {})
        self.assertFalse(session.search._running)
        self.assertFalse(session.pool.entries)
        self.assertEqual(session.pool.counts['cancelled'], 7)
        self.assertEqual(len(session.search.last_observations), 7)
        self.assertTrue(all(o['stage'] == 'cancelled' for o in session.search.last_observations))

    async def test_seven_successes_keep_global_two_reserve_limit(self):
        release = asyncio.Event()
        started = []
        sizes = []
        async def source(_):
            yield SourceBatch('feed', 'feed', tuple(item(n) for n in range(20)), None, 1, True)
        async def checker(candidate, country, slow):
            self.assertEqual((country, slow), ('EE', True))
            started.append(candidate)
            await release.wait()
            return proxy(candidate)
        def emit(event):
            if event['phase'] == 'pool':
                sizes.append(event['reserveCount'])
        session = await self.session(checker, source, emit=emit)
        refill = self.owned(session.pool._refill())
        try:
            await until(lambda: len(started) == 7)
            release.set()
            await asyncio.wait_for(refill, 2)
        finally:
            release.set()
        self.assertEqual(len(started), 7)
        self.assertEqual(len(session.pool.entries), 2)
        self.assertEqual(session.pool.counts['added'], 2)
        self.assertEqual(max(sizes), 2)
        self.assertEqual(session.search.last_stats['peak_checks'], 7)
        self.assertEqual(session.check_budget.snapshot['requests'], 0)
        self.assertEqual(session.pool._probes, {})

    async def test_refill_admissions_share_countries_equally_for_input_permutations(self):
        selected = ('AT', 'EE', 'NO')
        observations = []
        for countries, active_country in ((selected, 'EE'), (selected[::-1], 'NO')):
            calls = []
            async def source(cc):
                offset = selected.index(cc) * 200
                yield SourceBatch('feed', 'feed', tuple(item(offset + n) for n in range(120)), None, 1, True)
            async def checker(candidate, country, slow):
                self.assertEqual((country, slow), (selected, True))
                calls.append(candidate)
                await asyncio.sleep(0)
            session = await self.session(checker, source, countries)
            session.active['country'] = active_country
            await asyncio.wait_for(session.pool._refill(), 3)
            admitted = Counter(o['requestedCountry'] for o in session.search.last_observations)
            self.assertEqual(admitted, Counter(dict.fromkeys(selected, 40)))
            self.assertEqual(len(calls), 120)
            self.assertEqual(len(set(calls)), 120)
            self.assertEqual(session.search.last_stats['admissions'], 120)
            self.assertEqual(session.search.last_stats['fast'], 0)
            self.assertEqual(session.search.last_stats['slow'], 120)
            self.assertLessEqual(session.search.last_stats['peak_checks'], 7)
            observations.append([o['endpoint'] for o in session.search.last_observations])
        self.assertEqual(*observations)


if __name__ == '__main__':
    unittest.main()
