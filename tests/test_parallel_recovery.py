"""Recovery races reserve verification with a single bounded discovery owner."""
import asyncio
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, Session
from pool import ReservePool

A = Candidate('http', '8.8.8.8', 80)
B = Candidate('http', '1.1.1.1', 80)
C = Candidate('http', '9.9.9.9', 80)
D = Candidate('http', '4.2.2.2', 80)


def proxy(item, cc='NO', exit_ip=None):
    return dict(scheme=item.scheme, host=item.host, port=item.port, country=cc,
                exitIp=exit_ip or item.host, latencyMs=1, checkedAt=0)


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.001)


class Recovery(unittest.IsolatedAsyncioTestCase):
    def make(self, checker, items=(C,), countries=('AT', 'EE', 'NO')):
        self.calls = []
        async def discover(cc):
            self.calls.append(cc)
            return list(items), []
        s = Session(countries, lambda _: None, discover, checker, shuffle=lambda _: None)
        s.previous = proxy(A, 'AT')
        s.exclude(A)
        self.addAsyncCleanup(s.check_budget.close)
        return s

    async def test_fresh_success_does_not_wait_for_held_reserve_and_drains_it(self):
        entered, cancelled = asyncio.Event(), asyncio.Event()
        async def check(item, *_):
            if item == B:
                entered.set()
                try:
                    await asyncio.Future()
                finally:
                    cancelled.set()
            await entered.wait()
            return proxy(item, 'EE')
        s = self.make(check)
        self.assertTrue(s.pool.accept(proxy(B)))
        result, _ = await asyncio.wait_for(s.acquire(), .5)
        self.assertEqual(result, proxy(C, 'EE'))
        self.assertTrue(cancelled.is_set())
        self.assertIn(B.key, s.pool.entries)  # cancelled check is inconclusive
        self.assertEqual(s.check_budget.snapshot['running'], 0)
        self.assertEqual(s.check_budget.snapshot['requests'], 0)
        self.assertFalse(s.search._running)

    async def test_empty_search_waits_for_reserve(self):
        async def check(item, *_):
            await asyncio.sleep(.02)
            return proxy(item)
        s = self.make(check, items=())
        s.pool.accept(proxy(B))
        result, _ = await s.acquire()
        self.assertEqual(result['host'], B.host)

    async def test_empty_reserve_waits_for_fresh(self):
        async def check(item, *_):
            if item == B:
                return None
            await asyncio.sleep(.02)
            return proxy(item, 'EE')
        s = self.make(check)
        s.pool.accept(proxy(B))
        result, _ = await s.acquire()
        self.assertEqual(result['host'], C.host)

    async def test_search_skips_previous_exit_and_continues_same_round(self):
        async def check(item, *_):
            return proxy(item, 'EE', A.host if item == C else None)
        s = self.make(check, items=(A, C, D))
        result, _ = await s.acquire()
        self.assertEqual(result['host'], D.host)
        self.assertEqual(s.search.round_number, 1)

    async def test_group_members_get_equal_admission_and_reserved_hosts_are_not_reprobed(self):
        started, release = [], asyncio.Event()
        items = [Candidate('http', f'11.0.0.{i}', 80) for i in range(1, 25)]
        async def check(item, *_):
            started.append(item)
            await release.wait()
            return None
        s = self.make(check, items=items + [B, Candidate('socks5', B.host, 1080)])
        s.pool.accept(proxy(B))
        task = asyncio.create_task(s.acquire())
        try:
            await until(lambda: len(started) >= 9)
            self.assertEqual(started.count(B), 1)
            self.assertFalse(any(c.host == B.host and c != B for c in started))
            self.assertLessEqual(s.check_budget.snapshot['running'], 10)
            self.assertEqual(set(self.calls), {'AT', 'EE', 'NO'})
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(s.search._running)
        self.assertFalse(s.check_budget.snapshot['requests'])

    async def test_cancel_twice_waits_for_both_branch_cleanup_and_never_offers(self):
        started, cleaning, cleaned = [], [], []
        release = asyncio.Event()
        async def check(item, *_):
            started.append(item)
            try:
                await asyncio.Future()
            finally:
                cleaning.append(item)
                await release.wait()
                cleaned.append(item)
        s = self.make(check)
        s.pool.accept(proxy(B))
        original = s.pool.entries[B.key]
        task = asyncio.create_task(s.acquire())
        await until(lambda: len(started) == 2)
        task.cancel()
        await until(lambda: len(cleaning) == 2)
        task.cancel()
        await asyncio.sleep(.01)
        self.assertFalse(task.done())
        release.set()
        result = await asyncio.gather(task, return_exceptions=True)
        self.assertIsInstance(result[0], asyncio.CancelledError)
        self.assertCountEqual(cleaned, started)
        self.assertIs(s.pool.entries[B.key], original)
        self.assertFalse(s.check_budget.snapshot['requests'])
        self.assertFalse(s.search._running)

    async def test_success_observed_in_cancelled_take_is_kept_at_its_real_time(self):
        for completed_at, finished_at in ((10, 20), (85, 95)):
            with self.subTest(completed_at=completed_at, finished_at=finished_at):
                held, cleaning, release = (asyncio.Event() for _ in range(3))
                now = [0]
                async def check(item, *_):
                    if item == D:
                        held.set()
                        try:
                            await asyncio.Future()
                        finally:
                            cleaning.set()
                            await release.wait()
                    if item == B:
                        await held.wait()
                        now[0] = completed_at
                        return proxy(B, 'NO')
                    await cleaning.wait()
                    return proxy(C, 'EE')
                s = self.make(check)
                s.pool.clock = lambda: now[0]
                s.pool.accept(proxy(B)); s.pool.accept(proxy(D))
                dead_id = s.pool._reserve_ids[D.key]
                task = asyncio.create_task(s.acquire())
                try:
                    await cleaning.wait()
                    # B has really passed, but take is draining D; C may now win.
                    await asyncio.sleep(.02)
                    self.assertFalse(task.done())
                    now[0] = finished_at
                    release.set()
                    selected, _ = await task
                    self.assertEqual(selected['host'], C.host)
                    self.assertEqual(s.pool.entries[B.key][1], completed_at)
                    if finished_at < 90:
                        self.assertEqual(s.pool.entries[D.key][1], 0)
                        self.assertFalse(s.pool.removals)
                    else:
                        self.assertNotIn(D.key, s.pool.entries)
                        self.assertEqual([(e['reserveId'], e['reason']) for e in s.pool.removals], [(dead_id, 'expired')])
                finally:
                    release.set(); task.cancel(); await asyncio.gather(task, return_exceptions=True)
        
    async def test_cleanup_cannot_extend_winner_ttl_or_override_new_exclusion(self):
        for expire in (False, True):
            with self.subTest(expire=expire):
                entered = asyncio.Event()
                now = [0]
                async def check(item, *_):
                    if item == B:
                        entered.set()
                        try:
                            await asyncio.Future()
                        finally:
                            if expire:
                                now[0] = 91
                            else:
                                s.exclude(C)
                    await entered.wait()
                    return proxy(C)
                s = self.make(check)
                s.pool.clock = lambda: now[0]
                s.pool.accept(proxy(B))
                selected, _ = await s.acquire()
                self.assertIsNone(selected)
                self.assertFalse(s.check_budget.snapshot['requests'])

    async def test_fresh_runner_up_survives_winner_expiry_during_cleanup(self):
        # A production check that finished before cancellation remains real
        # evidence even if its owner is still draining asynchronous cleanup.
        now = [0]
        s = self.make(lambda *_: None)
        s.pool.clock = lambda: now[0]
        s.pool.accept(proxy(B))
        async def take(*, on_result):
            on_result(proxy(B), 0)
            return proxy(B)
        async def search(checker, eligible, progress, **kwargs):
            try:
                await asyncio.Future()
            finally:
                # This controlled tail models a completed terminal report being
                # harvested during the round's cancellation drain.
                now[0] = 80
                kwargs['on_terminal'](C, {}, {'ok': True, 'proxy': proxy(C, 'EE'), '_completed_at': 80})
                now[0] = 91
        s.pool.take = take
        s.search.run_round = search
        selected, _ = await s.acquire()
        self.assertEqual(selected['host'], C.host)
        self.assertNotIn(B.key, s.pool.entries)

    async def test_observed_fallback_from_reserve_is_consumed_without_false_loss(self):
        async def check(*_): return None
        s = self.make(check, items=())
        s.pool.accept(proxy(B))
        async def take(*, on_result):
            on_result(proxy(B), s.pool.clock())
            # A separately cancelled branch cannot erase a previously observed
            # physical success; the enclosing live recovery still owns it.
            raise asyncio.CancelledError
        s.pool.take = take
        selected, _ = await s.acquire()
        self.assertEqual(selected['host'], B.host)
        self.assertNotIn(B.key, s.pool.entries)
        self.assertFalse(s.pool.removals)

    async def test_old_observation_cannot_overwrite_new_lease_or_generation(self):
        for changed in ('token', 'generation'):
            with self.subTest(changed=changed):
                async def check(*_): return None
                s = self.make(check, items=())
                s.pool.accept(proxy(B))
                entry = s.pool.entries[B.key]
                lease = (B.key, entry, s.pool._tokens[B.key], s.pool._generation)
                replacement = proxy(B, 'EE', '11.0.0.22')
                async def take(*, on_result):
                    on_result(proxy(B), s.pool.clock(), lease=lease)
                    if changed == 'generation':
                        s.pool._generation += 1
                        s.pool.entries.clear()
                    else:
                        s.pool._remove(B.key)
                        self.assertTrue(s.pool.accept(replacement))
                    return proxy(B)
                s.pool.take = take
                selected, _ = await s.acquire()
                self.assertIsNone(selected)
                if changed == 'generation':
                    self.assertFalse(s.pool.entries)
                else:
                    self.assertEqual(s.pool.entries[B.key][0], replacement)

    async def test_replacement_refill_is_gated_then_replenished_before_next_failover(self):
        offers = asyncio.Queue()
        async def discover(_):
            return ([A, B, C, D] if s.confirmed_attempt >= 2 else [A, B, C]), []
        async def check(item, *_):
            await asyncio.sleep(.001 if item == A else .003)
            return proxy(item, {A:'AT', B:'EE', C:'NO', D:'EE'}[item])
        def emit(event):
            if event['phase'] == 'connected': offers.put_nowait(event)
        s = Session(['AT', 'EE', 'NO'], emit, discover, check, interval=60,
                    shuffle=lambda _: None)
        s.wait_for_browser = True
        task = asyncio.create_task(s.run())
        def confirm(event):
            identity = {k: event['proxy'][k] for k in ('scheme', 'host', 'port')}
            self.assertTrue(s.browser_feedback('confirm', event['attempt'], identity))
        try:
            initial = await asyncio.wait_for(offers.get(), 1)
            self.assertFalse(s.pool.entries)
            confirm(initial)
            await until(lambda: len(s.pool.entries) == 2)
            s.nudge(True)
            second = await asyncio.wait_for(offers.get(), 1)
            self.assertNotEqual(second['proxy']['host'], initial['proxy']['host'])
            self.assertFalse(s.pool.refill_allowed.is_set())
            before = s.pool.counts['rounds']
            await asyncio.sleep(.02)
            self.assertEqual(s.pool.counts['rounds'], before)
            confirm(second)
            await until(lambda: len(s.pool.entries) == 2)
            self.assertGreater(s.pool.counts['rounds'], before)
            s.nudge(True)
            third = await asyncio.wait_for(offers.get(), 1)
            self.assertNotIn(third['proxy']['host'], (initial['proxy']['host'], second['proxy']['host']))
            self.assertEqual(third['countries'], ['AT', 'EE', 'NO'])
        finally:
            task.cancel(); await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(s.check_budget.snapshot['requests'])
        self.assertFalse(s.search._running)


class RefillWake(unittest.IsolatedAsyncioTestCase):
    async def test_removed_entry_wakes_refill_without_waiting_interval(self):
        calls = []
        async def discover(_):
            calls.append(time.monotonic())
            return [D], []
        async def check(item, *_):
            return proxy(item)
        pool = ReservePool(['AT', 'EE', 'NO'], discover, check, lambda: proxy(A),
                           lambda _: True, lambda *_: None, lambda _: None, interval=60)
        pool.accept(proxy(B)); pool.accept(proxy(C))
        task = asyncio.create_task(pool.run())
        try:
            await asyncio.sleep(.01)
            self.assertFalse(calls)
            pool._remove(B.key, 'expired')
            await asyncio.wait_for(until(lambda: D.key in pool.entries), .5)
            self.assertEqual(len(calls), 1)
            await asyncio.sleep(.03)
            self.assertEqual(len(calls), 1)
        finally:
            task.cancel(); await asyncio.gather(task, return_exceptions=True)

    async def test_empty_refill_uses_backoff_and_browser_gate(self):
        calls = []
        async def discover(_):
            calls.append(time.monotonic()); return [], []
        async def check(*_): return None
        pool = ReservePool('NO', discover, check, lambda: proxy(A), lambda _: True,
                           lambda *_: None, lambda _: None, interval=.1)
        pool.refill_allowed.clear()
        task = asyncio.create_task(pool.run())
        try:
            await asyncio.sleep(.03); self.assertFalse(calls)
            pool.refill_allowed.set()
            await until(lambda: len(calls) == 1)
            await asyncio.sleep(.03); self.assertEqual(len(calls), 1)
            await until(lambda: len(calls) == 2)
            self.assertGreaterEqual(calls[1] - calls[0], .09)
        finally:
            task.cancel(); await asyncio.gather(task, return_exceptions=True)


if __name__ == '__main__':
    unittest.main()
