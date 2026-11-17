"""History hints exercise real admissions/checker starts, never network calls."""
import asyncio
from collections import Counter, namedtuple
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, COUNTRIES
from history import EndpointHistory
from stream_search import StreamSearch

Batch = namedtuple('Batch', 'group source candidates fetched_at complete error', defaults=(True, None))
def batch(group, items, complete=True):
    return Batch(group, group, tuple(items), 1000., complete)
def item(n):
    return Candidate('http', f'8.{n // 65536}.{n // 256 % 256}.{n % 256}', 3128)
def identity(_):
    pass


class HistorySchedulerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = 1000.
        self.history = EndpointHistory(clock=lambda: self.now, wall_clock=lambda: self.now,
                                       jitter=lambda: 0)

    def remember(self, candidate, observation, report):
        kind = ('success' if report.get('ok') else
                {'invalid_trace': 'endpoint_failure', 'cancel': 'cancel',
                 'internal': 'internal', 'neutral': 'neutral', 'country': 'country'}.get(
                     report.get('reason'), 'unknown'))
        proxy = report.get('proxy') or {}
        self.history.observe(candidate, kind, latency_ms=proxy.get('latencyMs'),
                             country=proxy.get('country') or report.get('country'),
                             groups=[source['group'] for source in observation['sources']])

    async def test_fast_failure_slow_success_is_one_terminal_with_late_provenance(self):
        offered = asyncio.Event()
        async def producer(_):
            yield batch('first', [item(1)])
            await offered.wait()
            yield batch('late', [item(1)])
        async def checker(candidate, cc, slow):
            if not slow:
                offered.set()
                return {'ok': False, 'reason': 'invalid_trace'}
            await asyncio.sleep(0)
            return {'ok': True, 'proxy': {'country': cc, 'latencyMs': 12}}
        calls = []
        def terminal(candidate, observation, report):
            calls.append((observation, report))
            self.remember(candidate, observation, report)
        search = StreamSearch('NO', ['first', 'late'], producer, shuffle=identity,
                              history=self.history)
        result, _ = await search.run_round(checker, on_terminal=terminal)
        self.assertEqual(result, {'country': 'NO', 'latencyMs': 12})
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][1]['ok'])
        self.assertEqual({s['group'] for s in calls[0][0]['sources']}, {'first', 'late'})
        self.assertTrue(self.history.eligible(item(1)))
        self.assertFalse(self.history.is_exploration(item(1)))
        self.assertEqual((search.last_stats['admissions'], search.last_stats['checks']), (1, 2))

    async def test_quarantine_retains_backlog_until_expiry_without_a_source_reoffer(self):
        physical = []
        async def producer(_):
            if search.round_number == 1:
                yield batch('g', [item(1)])
        async def checker(candidate, cc, slow):
            physical.append((search.round_number, slow))
            if search.round_number == 1:
                return {'ok': False, 'reason': 'timeout'}
            return {'ok': True, 'proxy': {'country': cc, 'latencyMs': 10}}
        search = StreamSearch('NO', ['g'], producer, shuffle=identity, history=self.history)
        await search.run_round(checker, on_terminal=self.remember)
        self.assertFalse(self.history.eligible(item(1)))
        self.assertIn(item(1).key, search.records)
        await search.run_round(checker, on_terminal=self.remember)
        self.assertEqual(physical, [(1, False), (1, True)])
        self.now += 61
        result, _ = await search.run_round(checker, on_terminal=self.remember)
        self.assertEqual(result['country'], 'NO')
        self.assertEqual(physical[-1], (3, False))

    async def test_exploration_fifo_gets_every_fifth_country_admission_across_eight_groups(self):
        # Even a still-producing provider cannot hold the exploration ticket.
        groups = [f'g{i}' for i in range(8)]
        known = [item(i + 1) for i in range(8)]
        recovering = [item(100), item(101)]
        for candidate in known:
            self.history.observe(candidate, 'success', latency_ms=1, country='NO')
        self.history.observe(recovering[0], 'unknown')
        self.history.observe(recovering[1], 'unknown')
        self.now += 61
        async def producer(_):
            for group, candidate in zip(groups, known):
                endpoints = [candidate]
                if group == 'g7':
                    endpoints += recovering if search.round_number == 1 else recovering[::-1]
                yield batch(group, endpoints, complete=False)
            await asyncio.Future()
        physical = []
        async def checker(candidate, cc, slow):
            physical.append(candidate)
            return {'ok': True, 'proxy': {'country': cc, 'latencyMs': 1}}
        search = StreamSearch('NO', groups, producer, cap=1, shuffle=identity,
                              history=self.history, discovery_budget=.005)
        for _ in range(10):
            await search.run_round(checker, on_result=lambda _: False, slow_only=True,
                                   on_terminal=self.remember)
        self.assertEqual([physical.index(c) + 1 for c in recovering], [5, 10])
        self.assertEqual(physical[:4], known[:4])
        self.assertEqual(len(physical), 10)
        self.assertLessEqual(sum(map(len, search.pending['NO'].values())), 120)

    async def test_stop_makes_provisional_fast_failure_and_cancelled_slow_neutral(self):
        slow_entered = asyncio.Event()
        async def producer(_):
            yield batch('g', [item(1)])
        async def checker(*args):
            if not args[-1]:
                return {'ok': False, 'reason': 'invalid_trace'}
            slow_entered.set()
            await asyncio.Future()
        calls = []
        def terminal(candidate, observation, report):
            calls.append(report)
            self.remember(candidate, observation, report)
        search = StreamSearch('NO', ['g'], producer, history=self.history)
        task = asyncio.create_task(search.run_round(checker, on_terminal=terminal))
        await asyncio.wait_for(slow_entered.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(calls, [{'ok': False, 'reason': 'cancel'}])
        self.assertTrue(self.history.eligible(item(1)))
        self.assertIn(item(1).key, search.records)

    async def test_late_country_credit_survives_ranked_saturation(self):
        ready = asyncio.Event()
        release = asyncio.Event()
        calls = Counter()
        candidates = {cc: [item(offset + i) for i in range(120)]
                      for cc, offset in [('EE', 1), ('NO', 1000)]}
        for candidate in candidates['EE']:
            self.history.observe(candidate, 'success', latency_ms=1, country='EE')
        async def producer(cc):
            if cc == 'NO':
                await ready.wait()
            yield batch('g', candidates[cc])
        async def checker(candidate, _, slow):
            calls['EE' if candidate in candidates['EE'] else 'NO'] += 1
            if sum(calls.values()) == 10:
                ready.set()
                release.set()
            await release.wait()
            return {'ok': False, 'reason': 'internal'}
        search = StreamSearch(['EE', 'NO'], ['g'], producer, shuffle=identity,
                              history=self.history)
        await search.run_round(checker, slow_only=True, on_terminal=self.remember)
        self.assertEqual(calls, {'EE': 60, 'NO': 60})
        self.assertEqual(search.last_stats['checks'], 120)
        self.assertEqual(search.last_stats['peak_checks'], 10)

    async def test_warm_ready_feed_still_starts_when_exploration_debt_and_sibling_hangs(self):
        entered = asyncio.Event()
        cleanup = asyncio.Event()
        warm = [item(i + 1) for i in range(12)]
        for candidate in warm:
            self.history.observe(candidate, 'success', latency_ms=1, country='NO')
        async def producer(_):
            try:
                yield batch('ready', warm)
                await asyncio.Future()
            finally:
                cleanup.set()
        calls = []
        async def checker(candidate, cc, slow):
            self.assertFalse(cleanup.is_set())
            calls.append(candidate)
            entered.set()
            return {'ok': True, 'proxy': {'country': cc, 'latencyMs': 1}}
        search = StreamSearch('NO', ['ready', 'hanging'], producer, cap=12,
                              shuffle=identity, history=self.history, discovery_budget=30)
        search.since_exploration['NO'] = 4
        result, _ = await asyncio.wait_for(search.run_round(
            checker, slow_only=True, concurrency=1, on_terminal=self.remember), 1)
        self.assertTrue(entered.is_set())
        self.assertTrue(cleanup.is_set())
        self.assertEqual(result['country'], 'NO')
        self.assertEqual(calls, [warm[0]])

    async def test_exploration_debt_reserves_only_one_in_five_of_a_large_round(self):
        known = [item(i + 1) for i in range(12)]
        for candidate in known:
            self.history.observe(candidate, 'success', latency_ms=1, country='NO')
        async def producer(_):
            yield batch('g', known)
        starts = []
        async def checker(candidate, cc, slow):
            starts.append(candidate)
            return {'ok': False, 'reason': 'internal'}
        search = StreamSearch('NO', ['g'], producer, cap=12, shuffle=identity,
                              history=self.history)
        search.since_exploration['NO'] = 4
        await search.run_round(checker, slow_only=True, on_terminal=self.remember)
        self.assertEqual(starts, known)
        self.assertEqual(search.last_stats['admissions'], 12)

    async def test_ordinary_new_endpoint_checks_do_not_reset_fifo_exploration_debt(self):
        groups = [f'g{i}' for i in range(8)]
        target, known = item(100), item(101)
        self.history.observe(known, 'success', latency_ms=1, country='NO')
        async def producer(_):
            # Target is oldest exploration; g7's ordinary ranked head is known.
            yield batch('g7', [target, known])
            for index, group in enumerate(groups[:-1]):
                yield batch(group, [item(index + 1)])
        starts = []
        async def checker(candidate, cc, slow):
            starts.append(candidate)
            return {'ok': True, 'proxy': {'country': cc, 'latencyMs': 1}}
        search = StreamSearch('NO', groups, producer, cap=1, history=self.history, shuffle=identity)
        for _ in range(5):
            await search.run_round(checker, slow_only=True, on_terminal=self.remember)
        self.assertEqual(starts[4], target)
