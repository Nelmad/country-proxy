"""Bounded reserve races with production identities; no network or Chrome."""
import asyncio
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, Session
from pool import ReservePool

ACTIVE = Candidate('http', '8.8.8.8', 3128)
A = Candidate('http', '1.1.1.1', 3128)
B = Candidate('socks5', '9.9.9.9', 1080)


def proxy(item, country='NO', **values):
    return dict(scheme=item.scheme, host=item.host, port=item.port,
                country=country, exitIp=item.host, latencyMs=1, checkedAt=123,
                **values)


async def until(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(0)


class ReserveRaceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 0
        self.events = []
        self.excluded = []
        self.tasks = []

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def make(self, checker, countries=('NO', 'EE')):
        async def discover(_):
            return [], []
        return ReservePool(countries, discover, checker, lambda: proxy(ACTIVE),
                           lambda _: True, lambda item, _: self.excluded.append(item),
                           self.events.append, clock=lambda: self.now)

    def start(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.append(task)
        return task

    async def test_real_checker_fast_second_reserve_uses_privileged_capacity(self):
        # Exercise inspect_proxy, both HTTPS responses, Session.reserve_checked
        # and the real budget. Only the transport is an artificial fixture.
        for countries in (('NO', 'EE'), ('EE', 'NO')):
            with self.subTest(countries=countries):
                entered, disposed = set(), set()
                release = asyncio.Event()
                async def discover(_):
                    return [], []
                session = Session(countries, self.events.append, discoverer=discover)
                session.active = proxy(ACTIVE)
                await session.check_budget.set_active(True)
                async def speculative():
                    await release.wait()
                saturated = [self.start(session.check_budget.run(
                    f'spec-{i}', True, 'speculative', speculative)) for i in range(7)]
                await until(lambda: session.check_budget.snapshot['roles']['speculative'] == 7)
                async def transport(url, item, slow):
                    self.assertTrue(slow)
                    entered.add((item, url))
                    try:
                        if item == A:
                            await asyncio.Event().wait()
                        await asyncio.sleep(.1)
                        return ((0, '200', f'ip={item.host}\nloc=EE')
                                if 'trace' in url else (0, '204', ''))
                    finally:
                        disposed.add((item, url))
                self.assertTrue(session.pool.accept(proxy(A)))
                self.assertTrue(session.pool.accept(proxy(B, 'EE')))
                try:
                    with patch('core.curl', transport):
                        started = time.monotonic()
                        result = await asyncio.wait_for(session.pool.take(), 3)
                        self.assertLess(time.monotonic() - started, 3)
                    self.assertEqual(result['host'], B.host)
                    self.assertEqual(result['country'], 'EE')
                    self.assertEqual(len(entered), 4)
                    self.assertEqual(disposed, entered)
                    self.assertEqual(session.check_budget.snapshot['roles'],
                                     {'health': 0, 'reserve': 0, 'speculative': 7})
                    self.assertFalse(session.pool._probes)
                    self.assertIn(A.key, session.pool.entries)
                    self.assertNotIn(B.key, session.pool.entries)
                finally:
                    release.set()
                    await asyncio.gather(*saturated, return_exceptions=True)
                    await session.check_budget.close()
                self.assertEqual(session.check_budget.snapshot['requests'], 0)

    async def test_completed_runner_up_keeps_actual_success_time_once(self):
        calls = []
        async def checker(item, *_):
            calls.append(item)
            self.now = 10 if item == A else 11
            return proxy(item, 'NO' if item == A else 'EE')
        pool = self.make(checker)
        pool.accept(proxy(A)); pool.accept(proxy(B, 'EE'))
        selected = await pool.take()
        self.assertEqual(selected['host'], A.host)
        self.assertEqual(calls, [A, B])
        self.assertEqual(list(pool.entries), [B.key])
        self.assertEqual(pool.entries[B.key][1], 11)
        self.assertEqual(self.excluded, [])
        self.assertFalse(pool._probes)

    async def test_finished_checker_is_harvested_before_shield_owner_resumes(self):
        observed = []
        owner = None
        async def checker(item, *_):
            # shield's completion callback runs first, but this callback cancels
            # the owner before its newly scheduled continuation can execute.
            asyncio.current_task().add_done_callback(lambda _: owner.cancel())
            self.now = 43
            return proxy(item)
        pool = self.make(checker)
        owner = self.start(pool.verify(A, on_result=lambda result, at:
                                       observed.append((result, at))))
        with self.assertRaises(asyncio.CancelledError):
            await owner
        self.assertEqual(observed, [(proxy(A), 43)])
        self.assertFalse(pool._probes)

    async def test_inconclusive_cancel_preserves_only_original_ttl(self):
        entered = asyncio.Event()
        async def checker(item, *_):
            if item == A:
                entered.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    # A checker ignoring cancellation cannot refresh its lease.
                    return {**proxy(item), 'latencyMs': 999}
            await entered.wait()
            self.now = 85
            return proxy(item, 'EE')
        pool = self.make(checker)
        pool.accept(proxy(A)); pool.accept(proxy(B, 'EE'))
        original = pool.entries[A.key]
        self.now = 80
        self.assertEqual((await pool.take())['host'], B.host)
        self.assertIs(pool.entries[A.key], original)
        self.assertEqual(pool.entries[A.key][1], 0)
        self.assertNotIn(A, self.excluded)
        self.now = 89; pool.prune()
        self.assertIn(A.key, pool.entries)
        self.now = 90; pool.prune()
        self.assertFalse(pool.entries)

    async def test_repeat_stop_drains_async_cleanup_and_keeps_original_leases(self):
        entered, cleaning = set(), set()
        release = asyncio.Event()
        cleaned = set()
        async def checker(item, *_):
            entered.add(item)
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.add(item)
                await release.wait()
                cleaned.add(item)
        pool = self.make(checker)
        pool.accept(proxy(A)); pool.accept(proxy(B, 'EE'))
        originals = dict(pool.entries)
        task = self.start(pool.take())
        await until(lambda: len(entered) == 2)
        task.cancel()
        await until(lambda: len(cleaning) == 2)
        for _ in range(3):
            task.cancel()
            await asyncio.sleep(0)
        self.assertFalse(task.done())
        self.assertFalse(cleaned)
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(cleaned, {A, B})
        self.assertEqual(pool.entries, originals)
        self.assertFalse(pool._probes)

    async def test_failures_mismatches_and_unselected_country_never_promote(self):
        for bad in (None, proxy(ACTIVE), proxy(A, 'PL'),
                    {**proxy(A), 'exitIp': ACTIVE.host}):
            with self.subTest(bad=bad):
                async def checker(item, *_):
                    return bad if item == A else None
                pool = self.make(checker)
                pool.accept(proxy(A)); pool.accept(proxy(B, 'EE'))
                self.assertIsNone(await pool.take())
                self.assertFalse(pool.entries)
                self.assertFalse(pool._probes)
                self.assertEqual(self.excluded[-2:], [A, B])

    async def test_expired_original_and_old_generation_cannot_be_resurrected(self):
        for change in ('expire', 'generation', 'replace'):
            with self.subTest(change=change):
                entered, release = asyncio.Event(), asyncio.Event()
                async def checker(item, *_):
                    entered.set()
                    await release.wait()
                    return proxy(item)
                pool = self.make(checker)
                pool.accept(proxy(A))
                original = pool.entries[A.key]
                task = self.start(pool.take())
                await entered.wait()
                if change == 'expire':
                    self.now += 90
                elif change == 'generation':
                    pool._generation += 1
                else:
                    pool._remove(A.key)
                    pool.accept({**proxy(A), 'latencyMs': 99})
                release.set()
                self.assertIsNone(await task)
                if change == 'expire':
                    self.assertFalse(pool.entries)
                    self.assertNotIn(A, self.excluded)
                elif change == 'generation':
                    self.assertIs(pool.entries[A.key], original)
                else:
                    self.assertEqual(pool.entries[A.key][0]['latencyMs'], 99)
                self.assertFalse(pool._probes)
                self.now = 0

    async def test_cleanup_crossing_original_ttl_keeps_fresh_winner(self):
        entered = asyncio.Event()
        async def checker(item, *_):
            if item == B:
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    self.now = 95
            await entered.wait()
            self.now = 85
            return proxy(item)
        pool = self.make(checker)
        pool.accept(proxy(A)); pool.accept(proxy(B, 'EE'))
        self.assertEqual((await pool.take())['host'], A.host)
        self.assertEqual(self.now, 95)
        self.assertFalse(pool.entries)
        self.assertFalse(self.excluded)
        self.assertFalse(pool._probes)

    async def test_paused_refill_does_not_pause_due_reserve_refresh(self):
        refreshed, discovered = [], []
        async def checker(item, *_):
            refreshed.append(item)
            return proxy(item)
        async def discovery(_):
            discovered.append(True)
            return [], []
        pool = self.make(checker)
        pool.discoverer = discovery
        pool.refill_allowed.clear()
        pool.accept(proxy(A))
        task = self.start(pool.run())
        self.now = 30
        pool._changed.set()
        await until(lambda: pool.entries[A.key][1] == 30)
        self.assertEqual(refreshed, [A])
        self.assertFalse(discovered)
        pool.refill_allowed.set()
        await until(lambda: bool(discovered))
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


if __name__ == '__main__':
    unittest.main()
