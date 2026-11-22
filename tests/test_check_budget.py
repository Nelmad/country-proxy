"""Real asyncio capacity, ownership and Session integration regressions."""
import asyncio
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from check_budget import CheckBudget
from core import Candidate, Session


async def until(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(0)


class CheckBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.budget = CheckBudget()
        self.tasks = []
        self.addAsyncCleanup(self.cleanup)

    async def cleanup(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.budget.close()

    def start(self, endpoint, role, operation, variant=False):
        task = asyncio.create_task(self.budget.run(endpoint, variant, role, operation))
        self.tasks.append(task)
        return task

    async def test_seven_saturated_speculative_preserve_two_reserve_and_one_health(self):
        await self.budget.set_active(True)
        release = asyncio.Event()
        started = []
        async def operation(name):
            started.append(name)
            await release.wait()
        for index in range(10):
            self.start(f's{index}', 'speculative', lambda i=index: operation(f's{i}'))
        await until(lambda: len(started) == 7)
        for index in range(2):
            self.start(f'r{index}', 'reserve', lambda i=index: operation(f'r{i}'))
        self.start('health', 'health', lambda: operation('health'))
        await until(lambda: len(started) == 10)
        self.assertEqual(self.budget.snapshot['roles'],
                         {'health': 1, 'reserve': 2, 'speculative': 7})
        self.assertEqual(set(started), {f's{i}' for i in range(7)} | {'r0', 'r1', 'health'})
        release.set()
        await asyncio.gather(*self.tasks)
        self.assertEqual(self.budget.snapshot['running'], 0)
        self.assertEqual(self.budget.snapshot['requests'], 0)

    async def test_inactive_foreground_has_all_ten_slots(self):
        release = asyncio.Event()
        started = []
        async def operation(index):
            started.append(index)
            await release.wait()
        for index in range(11):
            self.start(str(index), 'foreground', lambda i=index: operation(i))
        await until(lambda: len(started) == 10)
        self.assertEqual(self.budget.snapshot['running'], 10)
        self.assertNotIn(10, started)
        release.set()
        await asyncio.gather(*self.tasks)
        self.assertEqual(len(started), 11)

    async def test_duplicate_check_coalesces_and_one_cancelled_owner_is_neutral(self):
        release, entered = asyncio.Event(), asyncio.Event()
        calls = 0
        async def operation():
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            return 'confirmed'
        first = self.start('same', 'foreground', operation)
        await entered.wait()
        second = self.start('same', 'reserve', operation)
        await until(lambda: self.budget._requests[('same', False)].owners == 2)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertFalse(second.done())
        self.assertEqual(self.budget.snapshot['running'], 1)
        release.set()
        self.assertEqual(await second, 'confirmed')
        self.assertEqual(calls, 1)

    async def test_last_owner_cancellation_waits_for_operation_cleanup(self):
        entered, cleanup, allow_cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def operation():
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cleanup.set()
                await allow_cleanup.wait()
        task = self.start('owned', 'foreground', operation)
        await entered.wait()
        task.cancel()
        await cleanup.wait()
        self.assertFalse(task.done())
        self.assertEqual(self.budget.snapshot['running'], 1)
        allow_cleanup.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.budget.snapshot['running'], 0)
        self.assertEqual(self.budget.snapshot['requests'], 0)

    async def test_different_variants_serialize_same_endpoint(self):
        release, fast_started, slow_started = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def fast():
            fast_started.set()
            await release.wait()
            return 'fast'
        async def slow():
            slow_started.set()
            return 'slow'
        first = self.start('same', 'foreground', fast, variant=False)
        await fast_started.wait()
        second = self.start('same', 'health', slow, variant=True)
        await until(lambda: self.budget.snapshot['requests'] == 2)
        self.assertFalse(slow_started.is_set())
        self.assertEqual(self.budget.snapshot['running'], 1)
        release.set()
        self.assertEqual(await first, 'fast')
        self.assertEqual(await second, 'slow')
        self.assertEqual(self.budget.snapshot['running'], 0)

    async def test_close_does_not_recancel_an_operations_pending_cleanup(self):
        entered, cleanup, allow_cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()
        cleaned = []
        async def operation():
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cleanup.set()
                await allow_cleanup.wait()
                cleaned.append(True)
        task = self.start('owned', 'foreground', operation)
        await entered.wait()
        task.cancel()
        await cleanup.wait()
        close = asyncio.create_task(self.budget.close())
        self.tasks.append(close)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertFalse(close.done())
        self.assertEqual(cleaned, [])
        allow_cleanup.set()
        await close
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(cleaned, [True])
        self.assertEqual(self.budget.snapshot['running'], 0)

    async def test_repeated_owner_cancel_cannot_interrupt_async_child_cleanup(self):
        entered, cleanup, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        cleaned = []
        async def operation():
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cleanup.set()
                await release.wait()
                cleaned.append(True)
        task = self.start('repeat', 'foreground', operation)
        await entered.wait()
        task.cancel()
        await cleanup.wait()
        try:
            for _ in range(3):
                task.cancel()
                await asyncio.sleep(0)
            self.assertFalse(task.done())
            self.assertEqual(self.budget.snapshot['running'], 1)
            self.assertEqual(cleaned, [])
        finally:
            release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(cleaned, [True])
        self.assertEqual(self.budget.snapshot['running'], 0)
        self.assertEqual(self.budget.snapshot['requests'], 0)

    async def test_repeated_transition_cancel_preserves_drain_and_parent_cancel(self):
        entered, cleanup, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        cleaned = []
        async def operation():
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cleanup.set()
                await release.wait()
                cleaned.append(True)
        self.start('repeat', 'foreground', operation)
        await entered.wait()
        transition = asyncio.create_task(self.budget.set_active(True))
        self.tasks.append(transition)
        await cleanup.wait()
        try:
            for _ in range(3):
                transition.cancel()
                await asyncio.sleep(0)
            self.assertFalse(transition.done())
            self.assertEqual(cleaned, [])
        finally:
            release.set()
        with self.assertRaises(asyncio.CancelledError):
            await transition
        self.assertEqual(cleaned, [True])
        self.assertTrue(self.budget.snapshot['active'])
        self.assertEqual(self.budget.snapshot['running'], 0)

    async def test_queued_shared_check_promotes_to_reserved_health_capacity(self):
        await self.budget.set_active(True)
        release = asyncio.Event()
        for index in range(7):
            self.start(str(index), 'speculative', release.wait)
        await until(lambda: self.budget.snapshot['running'] == 7)
        entered = asyncio.Event()
        async def operation():
            entered.set()
            await release.wait()
            return 'shared'
        self.start('waiting', 'speculative', operation)
        await until(lambda: self.budget.snapshot['requests'] == 8)
        self.assertFalse(entered.is_set())
        health = self.start('waiting', 'health', operation)
        await entered.wait()
        self.assertEqual(self.budget.snapshot['roles'],
                         {'health': 1, 'reserve': 0, 'speculative': 7})
        release.set()
        self.assertEqual(await health, 'shared')

    async def test_cancelled_waiter_does_not_release_another_requests_slot(self):
        await self.budget.set_active(True)
        release = asyncio.Event()
        for index in range(7):
            self.start(str(index), 'speculative', release.wait)
        await until(lambda: self.budget.snapshot['running'] == 7)
        waiter = self.start('queued', 'speculative', release.wait)
        await until(lambda: self.budget.snapshot['requests'] == 8)
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        self.assertEqual(self.budget.snapshot['running'], 7)
        self.assertEqual(self.budget.snapshot['requests'], 7)
        release.set()

    async def test_mode_transition_drains_old_checks_before_new_mode_starts(self):
        entered, cleaning, allow_cleanup = [], [], asyncio.Event()
        concurrent = peak = 0
        async def old_operation(index):
            nonlocal concurrent, peak
            concurrent += 1
            peak = max(peak, concurrent)
            entered.append(index)
            try:
                await asyncio.Future()
            finally:
                cleaning.append(index)
                await allow_cleanup.wait()
                concurrent -= 1
        for index in range(10):
            self.start(str(index), 'foreground', lambda i=index: old_operation(i))
        await until(lambda: len(entered) == 10)
        transition = asyncio.create_task(self.budget.set_active(True))
        self.tasks.append(transition)
        await until(lambda: len(cleaning) == 10)
        new_started = asyncio.Event()
        async def new_operation():
            nonlocal concurrent, peak
            concurrent += 1
            peak = max(peak, concurrent)
            new_started.set()
            concurrent -= 1
        fresh = self.start('new-health', 'health', new_operation)
        await asyncio.sleep(0)
        self.assertFalse(transition.done())
        self.assertFalse(new_started.is_set())
        allow_cleanup.set()
        await transition
        await fresh
        self.assertEqual(peak, 10)
        self.assertTrue(self.budget.snapshot['active'])
        self.assertEqual(self.budget.snapshot['running'], 0)

    async def test_close_cancels_waiting_and_running_work_and_rejects_new_work(self):
        entered = asyncio.Event()
        async def operation():
            entered.set()
            await asyncio.Future()
        running = self.start('same', 'foreground', operation)
        await entered.wait()
        waiting = self.start('same', 'reserve', operation, variant=True)
        await until(lambda: self.budget.snapshot['requests'] == 2)
        await self.budget.close()
        for task in (running, waiting):
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.budget.snapshot['requests'], 0)
        self.assertEqual(self.budget.snapshot['running'], 0)
        with self.assertRaises(asyncio.CancelledError):
            await self.budget.run('new', False, 'foreground', operation)

    async def test_cancel_before_worker_first_instruction_does_not_leak_request(self):
        # Arrange task cancellation immediately after registration, before its
        # coroutine can acquire a slot or enter its try/finally.
        entered = False
        async def operation():
            nonlocal entered
            entered = True
        original = self.budget._execute
        async def cancel_before_entry(request):
            return await original(request)
        self.budget._execute = cancel_before_entry
        task = self.start('pre-entry', 'foreground', operation)
        await asyncio.sleep(0)
        request = self.budget._requests[('pre-entry', False)]
        request.task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(entered)
        self.assertEqual(self.budget.snapshot['requests'], 0)
        self.assertEqual(self.budget.snapshot['running'], 0)


class SessionBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_rotation_then_repeated_session_stop_drains_raw_cleanup(self):
        item = Candidate('http', '1.1.1.1', 8080)
        connected, entered, cleaning, release = (asyncio.Event() for _ in range(4))
        calls, cleaned = 0, []
        async def discover(country):
            return [item], []
        async def checker(candidate, country, slow):
            nonlocal calls
            calls += 1
            if calls == 1:
                return {'scheme': item.scheme, 'host': item.host, 'port': item.port,
                        'country': 'NO', 'exitIp': '8.8.8.8'}
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cleaning.set()
                await release.wait()
                cleaned.append(True)
        class Pool:
            def __init__(self, *args):
                self.entries = {}
            async def take(self):
                return None
            async def run(self):
                await asyncio.Future()
            def publish(self):
                pass
        session = Session('NO', lambda e: connected.set() if e['phase'] == 'connected' else None,
                          discoverer=discover, checker=checker, pool_factory=Pool, interval=60)
        task = asyncio.create_task(session.run())
        try:
            await asyncio.wait_for(connected.wait(), 1)
            session.nudge()
            await asyncio.wait_for(entered.wait(), 1)
            session.nudge(rotate=True)
            await asyncio.wait_for(cleaning.wait(), 1)
            for _ in range(3):
                task.cancel()
                await asyncio.sleep(0)
            self.assertFalse(task.done())
            self.assertEqual(cleaned, [])
        finally:
            release.set()
            task.cancel()
            result = await asyncio.gather(task, return_exceptions=True)
        self.assertIsInstance(result[0], asyncio.CancelledError)
        self.assertEqual(cleaned, [True])
        self.assertTrue(session.check_budget.snapshot['closed'])
        self.assertEqual(session.check_budget.snapshot['requests'], 0)
        self.assertIsNone(session.pool_task)

    async def test_repeated_session_stop_during_pool_check_cleanup_still_closes_budget(self):
        active = Candidate('http', '1.1.1.1', 8080)
        reserve = Candidate('http', '8.8.8.8', 8080)
        entered, cleaning, release = (asyncio.Event() for _ in range(3))
        cleaned = []
        async def discover(country):
            return [active], []
        async def checker(candidate, country, slow):
            if candidate == active:
                return {'scheme': active.scheme, 'host': active.host, 'port': active.port,
                        'country': 'NO', 'exitIp': '1.1.1.1'}
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cleaning.set()
                await release.wait()
                cleaned.append(True)
        class Pool:
            def __init__(self, *args):
                self.entries, self.checker = {}, args[2]
            async def take(self):
                return None
            async def run(self):
                await self.checker(reserve, 'NO', True)
            def publish(self):
                pass
        session = Session('NO', lambda _: None, discoverer=discover, checker=checker,
                          pool_factory=Pool, interval=60)
        task = asyncio.create_task(session.run())
        try:
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel()
            await asyncio.wait_for(cleaning.wait(), 1)
            for _ in range(3):
                task.cancel()
                await asyncio.sleep(0)
            self.assertFalse(task.done())
            self.assertEqual(cleaned, [])
        finally:
            release.set()
            task.cancel()
            result = await asyncio.gather(task, return_exceptions=True)
        self.assertIsInstance(result[0], asyncio.CancelledError)
        self.assertEqual(cleaned, [True])
        self.assertTrue(session.check_budget.snapshot['closed'])
        self.assertEqual(session.check_budget.snapshot['requests'], 0)
        self.assertIsNone(session.pool_task)

    async def test_session_keeps_factory_signature_and_counts_shared_raw_check_once(self):
        release, entered = asyncio.Event(), asyncio.Event()
        calls, factory_args = [], []
        async def checker(item, country, slow):
            calls.append((item, country, slow))
            entered.set()
            await release.wait()
            return {'scheme': item.scheme, 'host': item.host, 'port': item.port,
                    'country': 'NO', 'exitIp': '8.8.8.8', 'latencyMs': 1}
        class Pool:
            def __init__(self, *args):
                factory_args.extend(args)
                self.checker = args[2]
        session = Session('NO', lambda _: None, checker=checker, pool_factory=Pool)
        self.addAsyncCleanup(session.check_budget.close)
        self.assertEqual(len(factory_args), 7)
        self.assertEqual(session.pool.checker, session.reserve_checked)
        self.assertEqual(session.pool.refill_checker, session.speculative_checked)
        item = Candidate('http', '1.1.1.1', 8080)
        first = asyncio.create_task(session.checked(item, 'NO', True))
        await entered.wait()
        second = asyncio.create_task(session.reserve_checked(item, 'NO', True))
        await until(lambda: session.check_budget._requests[(item.key, True)].owners == 2)
        release.set()
        self.assertEqual(await first, await second)
        self.assertEqual(len(calls), 1)
        self.assertEqual(session.diagnostics['attempts'], 1)
        self.assertEqual(session.diagnostics['passed'], 1)

    async def test_session_cancel_is_not_internal_or_unavailable_failure(self):
        entered = asyncio.Event()
        async def checker(item, country, slow):
            entered.set()
            await asyncio.Future()
        session = Session('NO', lambda _: None, checker=checker)
        self.addAsyncCleanup(session.check_budget.close)
        task = asyncio.create_task(session.checked(Candidate('http', '1.1.1.1', 80), 'NO'))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(session.diagnostics, {'attempts': 0, 'passed': 0, 'failures': {}})
        self.assertEqual(session.check_budget.snapshot['running'], 0)

    async def test_real_session_transitions_and_finally_closes_allocator(self):
        item = Candidate('http', '1.1.1.1', 8080)
        connected, replacing = asyncio.Event(), asyncio.Event()
        reserve_started, cleanup_entered, cleanup_release, drained = (asyncio.Event() for _ in range(4))
        reacquiring = asyncio.Event()
        observations, acquisitions = [], []
        async def discover(country):
            return [item], []
        async def checker(candidate, country, slow):
            return {'scheme': candidate.scheme, 'host': candidate.host,
                    'port': candidate.port, 'country': 'NO', 'exitIp': '8.8.8.8'}
        def emit(event):
            if event['phase'] in ('connected', 'replacing'):
                observations.append((event['phase'], session.check_budget.snapshot['active']))
                (connected if event['phase'] == 'connected' else replacing).set()
        class Pool:
            def __init__(self, *args):
                self.entries = {}
            async def take(self):
                return None
            async def run(self):
                async def held_reserve():
                    reserve_started.set()
                    try:
                        await asyncio.Future()
                    finally:
                        cleanup_entered.set()
                        await cleanup_release.wait()
                        drained.set()
                await session.check_budget.run('held-reserve', False, 'reserve', held_reserve)
            def publish(self):
                pass
        session = Session('NO', emit, discoverer=discover, checker=checker,
                          pool_factory=Pool, interval=60, retry=60)
        acquire = session.acquire
        async def observed_acquire():
            acquisitions.append((drained.is_set(), session.check_budget.snapshot))
            if len(acquisitions) == 2:
                reacquiring.set()
            return await acquire()
        session.acquire = observed_acquire
        task = asyncio.create_task(session.run())
        try:
            await asyncio.wait_for(connected.wait(), 1)
            await asyncio.wait_for(reserve_started.wait(), 1)
            session.nudge(rotate=True)
            await asyncio.wait_for(replacing.wait(), 1)
            await asyncio.wait_for(cleanup_entered.wait(), 1)
            # Withdrawal must not wait for cleanup; the cancelling reserve still
            # owns its slot, and foreground reacquisition must not overlap it.
            self.assertEqual(observations, [('connected', True), ('replacing', True)])
            self.assertEqual(len(acquisitions), 1)
            self.assertFalse(reacquiring.is_set())
            self.assertFalse(drained.is_set())
            self.assertEqual(session.check_budget.snapshot, {
                'active': True, 'closed': False, 'running': 1, 'requests': 1,
                'roles': {'health': 0, 'reserve': 1, 'speculative': 0}})
            cleanup_release.set()
            await asyncio.wait_for(reacquiring.wait(), 1)
            self.assertEqual(acquisitions[1], (True, {
                'active': False, 'closed': False, 'running': 0, 'requests': 0,
                'roles': {'health': 0, 'reserve': 0, 'speculative': 0}}))
        finally:
            cleanup_release.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.assertIn(('connected', True), observations)
        self.assertIn(('replacing', True), observations)
        self.assertFalse(session.check_budget.snapshot['active'])
        self.assertTrue(session.check_budget.snapshot['closed'])
        self.assertEqual(session.check_budget.snapshot['running'], 0)
        self.assertEqual(session.check_budget.snapshot['requests'], 0)


if __name__ == '__main__':
    unittest.main()
