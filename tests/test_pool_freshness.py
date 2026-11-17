"""Deterministic lease and scheduling tests: no network, subprocess or real waits."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate
from pool import ReservePool

A = Candidate('http', '8.8.8.8', 3128)
B = Candidate('http', '1.1.1.1', 3128)
C = Candidate('socks5', '9.9.9.9', 1080)
D = Candidate('http', '4.2.2.2', 80)


def proxy(item, *, latency=1, exit_ip=None, country='NO'):
    return dict(scheme=item.scheme, host=item.host, port=item.port, country=country,
                exitIp=exit_ip or item.host, latencyMs=latency, checkedAt=123)


async def settle():
    # Drain runnable coroutine callbacks; deadlines come only from the injected clock.
    for _ in range(30):
        await asyncio.sleep(0)


class FreshnessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 0
        self.events = []
        self.blocked = set()
        self.active = proxy(A)
        self.tasks = []
        self.refill_entered = asyncio.Event()
        self.refill_cancelled = asyncio.Event()

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    async def blocked_discovery(self, countries):
        self.refill_entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            self.refill_cancelled.set()

    def make(self, checker, discoverer=None):
        return ReservePool(('NO', 'EE'), discoverer or self.blocked_discovery, checker,
                           lambda: self.active, lambda item: item.host not in self.blocked,
                           lambda item, seconds: self.blocked.add(item.host), self.events.append,
                           clock=lambda: self.now)

    def start(self, pool):
        task = asyncio.create_task(pool.run())
        self.tasks.append(task)
        return task

    async def advance(self, pool, instant):
        self.now = instant
        # Wake a scheduler whose real timer cannot observe synthetic time advancing.
        pool._changed.set()
        await settle()

    async def test_refill_longer_than_ttl_never_starves_due_checks(self):
        starts = []
        async def checker(item, countries, slow):
            starts.append(self.now)
            return proxy(item)
        pool = self.make(checker)
        pool.accept(proxy(B))
        task = self.start(pool)
        await settle()
        self.assertTrue(self.refill_entered.is_set())
        self.assertEqual(starts, [])  # Fresh acceptance already anchors the first deadline.
        for now in (30, 60, 90, 120):
            await self.advance(pool, now)
            self.assertEqual(pool.entries[B.key][1], now)
            self.assertEqual(self.events[-1]['reserveCount'], 1)
        self.assertEqual(starts, [30, 60, 90, 120])
        self.assertFalse(task.done())
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(self.refill_cancelled.is_set())
        self.assertFalse(pool._probes)
        self.assertFalse(pool._refresh_tasks)

    async def test_individual_due_times_and_no_duplicate_for_inflight_entry(self):
        starts = []
        release_b = asyncio.Event()
        async def checker(item, countries, slow):
            starts.append((item, self.now))
            if item == B:
                await release_b.wait()
            return proxy(item)
        pool = self.make(checker)
        pool.accept(proxy(B))
        self.now = 10
        pool.accept(proxy(C))
        self.start(pool)
        await self.advance(pool, 30)
        self.assertEqual(starts, [(B, 30)])
        await self.advance(pool, 40)
        self.assertEqual(starts, [(B, 30), (C, 40)])
        self.assertEqual(pool.entries[C.key][1], 40)
        await self.advance(pool, 60)
        self.assertEqual(starts, [(B, 30), (C, 40)])
        release_b.set()
        await settle()
        self.assertEqual(pool.entries[B.key][1], 60)

    async def test_expired_inflight_entry_is_not_ready_or_resurrected(self):
        release = asyncio.Event()
        entered = asyncio.Event()
        async def checker(item, countries, slow):
            entered.set()
            await release.wait()
            return proxy(item)
        pool = self.make(checker)
        pool.accept(proxy(B))
        self.start(pool)
        await self.advance(pool, 30)
        self.assertTrue(entered.is_set())
        await self.advance(pool, 90)
        self.assertNotIn(B.key, pool.entries)
        self.assertEqual(self.events[-1]['reserveCount'], 0)
        release.set()
        await settle()
        self.assertNotIn(B.key, pool.entries)
        self.assertFalse(pool._refresh_tasks)

    async def test_failed_refresh_does_not_extend_success_time(self):
        async def checker(*args):
            return None
        pool = self.make(checker)
        pool.accept(proxy(B))
        self.start(pool)
        await self.advance(pool, 30)
        self.assertNotIn(B.key, pool.entries)
        self.assertIn(B.host, self.blocked)
        self.assertEqual(self.events[-1]['reserveCount'], 0)

    async def test_old_completion_cannot_overwrite_replaced_entry_lease(self):
        release = asyncio.Event()
        async def checker(item, countries, slow):
            await release.wait()
            return proxy(item, latency=1)
        pool = self.make(checker)
        pool.accept(proxy(B))
        self.start(pool)
        await self.advance(pool, 30)
        self.assertIn(B.key, pool._refresh_tasks)
        pool._remove(B.key)
        self.now = 31
        pool.accept(proxy(B, latency=99))
        release.set()
        await settle()
        self.assertEqual(pool.entries[B.key][0]['latencyMs'], 99)
        self.assertEqual(pool.entries[B.key][1], 31)
        self.assertFalse(self.blocked)

    async def test_stop_discards_late_success_but_preserves_fresh_promotion(self):
        entered = asyncio.Event()
        cancelled = asyncio.Event()
        calls = 0
        async def checker(item, countries, slow):
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancelled.set()
                    return proxy(item, latency=99)
            return proxy(item)
        pool = self.make(checker)
        pool.accept(proxy(B, latency=1))
        task = self.start(pool)
        await self.advance(pool, 30)
        self.assertTrue(entered.is_set())
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(cancelled.is_set())
        self.assertEqual(pool.entries[B.key][1], 0)
        self.assertEqual(pool.entries[B.key][0]['latencyMs'], 1)
        self.assertFalse(pool._probes)
        self.assertFalse(pool._refresh_tasks)
        self.assertFalse(pool.checking)
        self.assertEqual((await pool.take())['host'], B.host)
        self.assertFalse(pool.entries)

    async def test_manual_cycles_coalesce_the_same_entry_probe(self):
        entered = asyncio.Event()
        release = asyncio.Event()
        calls = 0
        async def checker(item, countries, slow):
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            return proxy(item)
        async def discovery(_):
            return [], []
        pool = self.make(checker, discovery)
        pool.accept(proxy(B))
        first = asyncio.create_task(pool.refresh())
        second = asyncio.create_task(pool.refresh())
        self.tasks.extend((first, second))
        await settle()
        self.assertTrue(entered.is_set())
        self.assertEqual(calls, 1)
        release.set()
        await asyncio.gather(first, second)
        self.assertEqual(calls, 1)
        self.assertEqual(len(pool.entries), 1)

    async def test_coalesced_check_survives_one_owner_cancellation(self):
        release = asyncio.Event()
        calls = 0
        async def checker(item, countries, slow):
            nonlocal calls
            calls += 1
            await release.wait()
            return proxy(item)
        pool = self.make(checker)
        first = asyncio.create_task(pool.verify(B))
        second = asyncio.create_task(pool.verify(B))
        self.tasks.extend((first, second))
        await settle()
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        self.assertFalse(second.done())
        self.assertEqual(calls, 1)
        release.set()
        self.assertEqual((await second)['host'], B.host)
        self.assertFalse(pool._probes)

    async def test_simultaneous_refill_preserves_host_exit_diversity_and_limit(self):
        release = asyncio.Event()
        async def checker(item, countries, slow):
            await release.wait()
            return proxy(item, exit_ip='8.8.4.4' if item in (B, C) else item.host)
        async def discovery(_):
            return [B, C, D, Candidate('http', D.host, 9999)], []
        pool = self.make(checker, discovery)
        task = asyncio.create_task(pool.refresh())
        self.tasks.append(task)
        await settle()
        release.set()
        await task
        self.assertEqual(len(pool.entries), 2)
        values = [entry[0] for entry in pool.entries.values()]
        self.assertEqual(len({value['host'] for value in values}), 2)
        self.assertEqual(len({value['exitIp'] for value in values}), 2)

    async def test_refill_errors_do_not_stop_maintenance_and_use_distinct_checker(self):
        reserved = []
        speculative = []
        async def checker(item, countries, slow):
            reserved.append((item, self.now))
            return proxy(item)
        async def refill_checker(item, countries, slow):
            speculative.append(item)
            raise RuntimeError('source candidate failed')
        async def discovery(_):
            return [C], []
        pool = self.make(checker, discovery)
        pool.refill_checker = refill_checker
        pool.accept(proxy(B))
        task = self.start(pool)
        await settle()
        self.assertEqual(speculative, [C])
        self.assertEqual(reserved, [])
        await self.advance(pool, 30)
        self.assertEqual(reserved, [(B, 30)])
        self.assertFalse(task.done())
        self.assertEqual(pool.entries[B.key][1], 30)

    async def test_wall_clock_jumps_do_not_change_refresh_or_expiry_deadlines(self):
        starts = []
        async def checker(item, countries, slow):
            starts.append(self.now)
            return proxy(item)
        pool = self.make(checker)
        with patch('pool.time.time', return_value=1_000_000_000):
            pool.accept(proxy(B))
            self.start(pool)
            await self.advance(pool, 29)
        with patch('pool.time.time', return_value=-1_000_000_000):
            await self.advance(pool, 29.9)
            self.assertEqual(starts, [])
            await self.advance(pool, 30)
            self.assertEqual(starts, [30])
            self.assertEqual(pool.entries[B.key][1], 30)
            await self.advance(pool, 59)
            self.assertEqual(starts, [30])

    async def test_new_reserve_wakes_maintenance_for_its_own_success_deadline(self):
        starts = []
        async def checker(item, countries, slow):
            starts.append(self.now)
            return proxy(item)
        pool = self.make(checker)
        self.start(pool)
        await settle()
        self.assertTrue(self.refill_entered.is_set())
        self.now = 7
        pool.accept(proxy(B))
        await settle()
        await self.advance(pool, 36)
        self.assertEqual(starts, [])
        await self.advance(pool, 37)
        self.assertEqual(starts, [37])

    async def test_cancelled_manual_refresh_cannot_accept_checker_ignoring_cancel(self):
        entered = asyncio.Event()
        async def checker(item, countries, slow):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return proxy(item, latency=99)
        pool = self.make(checker)
        pool.accept(proxy(B))
        self.now = 30
        task = asyncio.create_task(pool.refresh())
        self.tasks.append(task)
        await settle()
        self.assertTrue(entered.is_set())
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(pool.entries[B.key][0]['latencyMs'], 1)
        self.assertEqual(pool.entries[B.key][1], 0)
        self.assertFalse(pool._probes)
        self.assertFalse(pool._refresh_tasks)

    async def test_repeated_run_cancellation_waits_for_checker_finally(self):
        entered = asyncio.Event()
        cleaning = asyncio.Event()
        release_cleanup = asyncio.Event()
        cleaned = asyncio.Event()
        async def checker(item, countries, slow):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await release_cleanup.wait()
                cleaned.set()
        pool = self.make(checker)
        pool.accept(proxy(B))
        task = self.start(pool)
        await self.advance(pool, 30)
        self.assertTrue(entered.is_set())
        task.cancel()
        await asyncio.wait_for(cleaning.wait(), .5)
        task.cancel()
        await settle()
        self.assertFalse(task.done())
        self.assertFalse(cleaned.is_set())
        release_cleanup.set()
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(cleaned.is_set())
        self.assertFalse(pool._probes)
        self.assertFalse(pool._refresh_tasks)
        self.assertFalse(pool._running)
        self.assertEqual(pool.entries[B.key][1], 0)

    async def test_repeated_run_cancellation_waits_for_discovery_finally(self):
        entered = asyncio.Event()
        cleaning = asyncio.Event()
        release_cleanup = asyncio.Event()
        cleaned = asyncio.Event()
        async def checker(item, countries, slow):
            return proxy(item)
        async def discovery(_):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await release_cleanup.wait()
                cleaned.set()
        pool = self.make(checker, discovery)
        task = self.start(pool)
        await settle()
        self.assertTrue(entered.is_set())
        task.cancel()
        await asyncio.wait_for(cleaning.wait(), .5)
        task.cancel()
        await settle()
        self.assertFalse(task.done())
        release_cleanup.set()
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(cleaned.is_set())
        self.assertFalse(pool._probes)
        self.assertFalse(pool._refresh_tasks)
        self.assertFalse(pool._running)

    async def test_new_owner_waits_for_abandoned_probe_cleanup(self):
        entered = asyncio.Event()
        cleaning = asyncio.Event()
        release_cleanup = asyncio.Event()
        calls = live = peak = 0
        async def checker(item, countries, slow):
            nonlocal calls, live, peak
            calls += 1
            live += 1
            peak = max(peak, live)
            try:
                if calls == 1:
                    entered.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        cleaning.set()
                        await release_cleanup.wait()
                return proxy(item)
            finally:
                live -= 1
        pool = self.make(checker)
        first = asyncio.create_task(pool.verify(B))
        self.tasks.append(first)
        await asyncio.wait_for(entered.wait(), .5)
        first.cancel()
        await asyncio.wait_for(cleaning.wait(), .5)
        second = asyncio.create_task(pool.verify(B))
        self.tasks.append(second)
        await settle()
        self.assertEqual(calls, 1)
        self.assertFalse(first.done())
        self.assertFalse(second.done())
        release_cleanup.set()
        await asyncio.gather(first, return_exceptions=True)
        self.assertEqual((await second)['host'], B.host)
        self.assertEqual(calls, 2)
        self.assertEqual(peak, 1)
        self.assertEqual(live, 0)
        self.assertFalse(pool._probes)

    async def test_stopped_refill_cannot_accept_checker_ignoring_cancel(self):
        entered = asyncio.Event()
        async def checker(item, countries, slow):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return proxy(item)
        async def discovery(_):
            return [B], []
        pool = self.make(checker, discovery)
        task = self.start(pool)
        await settle()
        self.assertTrue(entered.is_set())
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(pool.entries)
        self.assertFalse(pool._probes)
        self.assertFalse(pool._refresh_tasks)
        self.assertFalse(pool._running)

    async def test_simultaneous_refresh_and_refill_cannot_share_egress(self):
        release = asyncio.Event()
        entered = set()
        async def checker(item, countries, slow):
            entered.add(item)
            await release.wait()
            return proxy(item, exit_ip='8.8.4.4')
        async def discovery(_):
            return [C], []
        pool = self.make(checker, discovery)
        pool.accept(proxy(B))
        self.start(pool)
        await settle()
        self.assertEqual(entered, {C})
        await self.advance(pool, 30)
        self.assertEqual(entered, {B, C})
        release.set()
        await settle()
        values = [entry[0] for entry in pool.entries.values()]
        self.assertEqual(len(values), 1)
        self.assertEqual(values[0]['exitIp'], '8.8.4.4')
        self.assertLessEqual(max(event['reserveCount'] for event in self.events), 2)

    async def test_refreshed_route_conflicting_with_active_cannot_reenter_pool(self):
        release = asyncio.Event()
        async def checker(item, countries, slow):
            await release.wait()
            return proxy(item)
        pool = self.make(checker)
        pool.accept(proxy(B))
        self.start(pool)
        await self.advance(pool, 30)
        self.active = proxy(B)
        release.set()
        await settle()
        self.assertFalse(pool.entries)
        self.assertEqual(self.events[-1]['reserveCount'], 0)


if __name__ == '__main__':
    unittest.main()
