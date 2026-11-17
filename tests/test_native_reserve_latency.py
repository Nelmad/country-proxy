"""Reserve-only optional HTTPS transfers: strict admission and bounded ownership."""
import asyncio
from collections import Counter
from contextlib import contextmanager
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import core
from check_budget import SupplementalBudget
from core import Candidate, Session, inspect_proxy

A = Candidate('socks5', '8.8.8.8', 1080)
COUNTRIES = ('AT', 'EE', 'NO')


def response(url, country='EE'):
    return ((0, '200', f'loc={country}\nip=8.8.4.4\n') if url == core.TRACE
            else (0, '204', ''))


async def until(predicate, timeout=2):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(.001)


@contextmanager
def timings(delay=.01, deadline=.5):
    with patch.object(core, 'RESERVE_EXTRA_DELAY', delay), patch.object(core, 'RESERVE_PROBE_TIMEOUT', deadline):
        yield


class NativeReserveLatency(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.budget = SupplementalBudget()
        self.tasks = []

    async def asyncTearDown(self):
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.assertEqual(self.budget.running, 0)

    def start(self, awaitable):
        task = asyncio.create_task(awaitable)
        self.tasks.append(task)
        return task

    async def test_fast_success_still_has_exactly_two_https_requests(self):
        calls = []
        async def fetch(url, *_):
            calls.append(url)
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            result = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertTrue(result['ok'])
        self.assertCountEqual(calls, [core.TRACE, core.TARGET])

    async def test_pending_trace_extra_wins_and_cancels_original(self):
        calls, cancelled = Counter(), []
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE and calls[url] == 1:
                try:
                    await asyncio.Future()
                finally:
                    cancelled.append(url)
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            result = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertTrue(result['ok'])
        self.assertEqual(result['proxy']['country'], 'EE')
        self.assertEqual(calls, {core.TRACE: 2, core.TARGET: 1})
        self.assertEqual(cancelled, [core.TRACE])

    async def test_successful_trace_extra_never_bypasses_pending_target(self):
        calls = Counter()
        release_target = asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            ordinal = calls[url]
            if ordinal == 1:
                await asyncio.Future()
            if url == core.TARGET:
                await release_target.wait()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            task = self.start(inspect_proxy(A, COUNTRIES, True, extras=self.budget))
            await until(lambda: calls[core.TARGET] == 2)
            await asyncio.sleep(.01)
            self.assertFalse(task.done())
            release_target.set()
            self.assertTrue((await task)['ok'])
        self.assertEqual(calls, {core.TRACE: 2, core.TARGET: 2})

    async def test_all_selected_countries_can_pass_the_supplement(self):
        for country in COUNTRIES:
            calls = Counter()
            async def fetch(url, *_):
                calls[url] += 1
                if url == core.TRACE and calls[url] == 1:
                    await asyncio.Future()
                return response(url, country)
            with self.subTest(country=country), timings(), patch.object(core, 'curl', fetch):
                result = await inspect_proxy(A, tuple(reversed(COUNTRIES)), True, extras=self.budget)
                self.assertEqual(result['proxy']['country'], country)

    async def test_extra_tls_http_country_invalid_trace_and_internal_reject(self):
        cases = [
            ((60, '000', ''), 'tls'),
            ((0, '503', ''), 'http'),
            ((0, '200', 'loc=US\nip=8.8.4.4'), 'country'),
            ((0, '200', 'loc=EE\nip=127.0.0.1'), 'invalid_trace'),
            (FileNotFoundError('fixture'), 'internal'),
        ]
        for answer, reason in cases:
            calls = Counter()
            async def fetch(url, *_):
                calls[url] += 1
                if url == core.TARGET:
                    return response(url)
                if calls[url] == 1:
                    await asyncio.Future()
                if isinstance(answer, Exception):
                    raise answer
                return answer
            with self.subTest(reason=reason), timings(), patch.object(core, 'curl', fetch):
                result = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
                self.assertFalse(result['ok'])
                self.assertEqual((result['reason'], result['endpoint']), (reason, 'trace'))
                self.assertNotIn('proxy', result)

    async def test_bad_extra_target_rejects_even_after_valid_trace(self):
        calls = Counter()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TARGET:
                if calls[url] == 1:
                    await asyncio.Future()
                return 0, '503', ''
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            result = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertEqual((result['reason'], result['endpoint']), ('http', 'target'))

    async def test_optional_transport_failures_preserve_slow_working_primary(self):
        for answer in [(7, '000', ''), (28, '000', ''), (56, '000', ''), TimeoutError()]:
            calls = Counter()
            release = asyncio.Event()
            extra_failed = asyncio.Event()
            async def fetch(url, *_):
                calls[url] += 1
                if url == core.TRACE:
                    if calls[url] == 1:
                        await release.wait()
                    else:
                        extra_failed.set()
                        if isinstance(answer, Exception):
                            raise answer
                        return answer
                return response(url)
            with self.subTest(answer=answer), timings(), patch.object(core, 'curl', fetch):
                task = self.start(inspect_proxy(A, COUNTRIES, True, extras=self.budget))
                await extra_failed.wait()
                await asyncio.sleep(.005)
                self.assertFalse(task.done())
                release.set()
                self.assertTrue((await task)['ok'])
                self.assertEqual(calls, {core.TRACE: 2, core.TARGET: 1})

    async def test_primary_failure_remains_immediate_with_held_extra(self):
        calls = Counter()
        release_primary = asyncio.Event()
        extra_entered = asyncio.Event()
        extra_cancelled = asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await release_primary.wait()
                    return 7, '000', ''
                extra_entered.set()
                try:
                    await asyncio.Future()
                finally:
                    extra_cancelled.set()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            task = self.start(inspect_proxy(A, COUNTRIES, True, extras=self.budget))
            await extra_entered.wait()
            release_primary.set()
            result = await asyncio.wait_for(task, .2)
        self.assertEqual(result['reason'], 'connect')
        self.assertTrue(extra_cancelled.is_set())

    async def test_primary_failure_before_delay_does_not_start_extra(self):
        calls = Counter()
        async def fetch(url, *_):
            calls[url] += 1
            return (60, '000', '') if url == core.TRACE else response(url)
        with timings(), patch.object(core, 'curl', fetch):
            result = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertEqual(result['reason'], 'tls')
        self.assertEqual(calls, {core.TRACE: 1, core.TARGET: 1})

    async def test_shared_deadline_is_not_renewed_by_supplement(self):
        calls, disposed = [], []
        async def fetch(url, *_):
            token = len(calls)
            calls.append(url)
            try:
                await asyncio.Future()
            finally:
                disposed.append(token)
        with timings(delay=.025, deadline=.06), patch.object(core, 'curl', fetch):
            started = time.monotonic()
            result = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
            duration = time.monotonic() - started
        self.assertEqual(result['reason'], 'timeout')
        self.assertGreaterEqual(duration, .05)
        self.assertLess(duration, .085)
        self.assertEqual(len(calls), 4)
        self.assertCountEqual(disposed, range(4))

    async def test_fast_mode_ignores_optional_policy_and_deadline(self):
        calls = []
        async def fetch(url, *_):
            calls.append(url)
            await asyncio.sleep(.04)
            return response(url)
        with timings(delay=.005, deadline=.015), patch.object(core, 'curl', fetch):
            result = await inspect_proxy(A, COUNTRIES, False, extras=self.budget)
        self.assertTrue(result['ok'])
        self.assertCountEqual(calls, [core.TRACE, core.TARGET])

    async def test_no_available_permit_does_not_queue_or_retry(self):
        held = [self.budget.acquire(), self.budget.acquire()]
        calls = []
        release = asyncio.Event()
        async def fetch(url, *_):
            calls.append(url)
            await release.wait()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            task = self.start(inspect_proxy(A, COUNTRIES, True, extras=self.budget))
            await asyncio.sleep(.035)
            for owner in held:
                self.budget.release(owner)
            await asyncio.sleep(.025)
            self.assertCountEqual(calls, [core.TRACE, core.TARGET])
            release.set()
            self.assertTrue((await task)['ok'])

    async def test_repeated_cancellation_drains_children_before_releasing_permits(self):
        calls = []
        cleanup_entered, finish_cleanup = asyncio.Event(), asyncio.Event()
        async def fetch(url, *_):
            calls.append(url)
            try:
                await asyncio.Future()
            finally:
                cleanup_entered.set()
                await finish_cleanup.wait()
        with timings(), patch.object(core, 'curl', fetch):
            task = self.start(inspect_proxy(A, COUNTRIES, True, extras=self.budget))
            await until(lambda: len(calls) == 4)
            self.assertEqual(self.budget.running, 2)
            task.cancel()
            await cleanup_entered.wait()
            for _ in range(3):
                task.cancel()
                await asyncio.sleep(0)
            self.assertFalse(task.done())
            self.assertEqual(self.budget.running, 2)
            finish_cleanup.set()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_cancellation_that_returns_late_success_cannot_publish_proxy(self):
        entered = 0
        async def fetch(url, *_):
            nonlocal entered
            entered += 1
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            task = self.start(inspect_proxy(A, COUNTRIES, True, extras=self.budget))
            await until(lambda: entered == 4)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_permit_is_released_when_extra_task_is_cancelled_before_start(self):
        create_task = asyncio.create_task
        cancel_next = False
        class PrestartCancellationBudget(SupplementalBudget):
            def acquire(inner):
                nonlocal cancel_next
                owner = super().acquire()
                cancel_next = owner is not None
                return owner
        self.budget = PrestartCancellationBudget()
        def create(coro, *args, **kwargs):
            nonlocal cancel_next
            task = create_task(coro, *args, **kwargs)
            if cancel_next:
                cancel_next = False
                task.cancel()
            return task
        calls = []
        async def fetch(url, *_):
            calls.append(url)
            await asyncio.Future()
        with timings(), patch.object(core, 'curl', fetch), patch.object(asyncio, 'create_task', create):
            with self.assertRaises(asyncio.CancelledError):
                await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertCountEqual(calls, [core.TRACE, core.TARGET])
        self.assertEqual(self.budget.running, 0)

    async def test_actual_four_subprocesses_are_reaped_on_cancel(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            serial = 0
            async def fetch(url, *_):
                nonlocal serial
                serial += 1
                pid_path = directory / str(serial)
                script = ('import os,time,pathlib; '
                          'pathlib.Path(__import__("sys").argv[1]).write_text(str(os.getpid())); '
                          'time.sleep(60)')
                await core.process([sys.executable, '-c', script, str(pid_path)], 62)
                return response(url)
            with timings(), patch.object(core, 'curl', fetch):
                task = self.start(inspect_proxy(A, COUNTRIES, True, extras=self.budget))
                await until(lambda: len(list(directory.iterdir())) == 4)
                pids = [int(path.read_text()) for path in directory.iterdir()]
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            for pid in pids:
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)

    async def test_session_keeps_ten_endpoint_slots_and_at_most_two_extra_transfers(self):
        session = Session(COUNTRIES, lambda _: None)
        await session.check_budget.set_active(True)
        running = peak = 0
        calls = []
        async def fetch(url, candidate, _slow):
            nonlocal running, peak
            calls.append((candidate.key, url))
            running += 1
            peak = max(peak, running)
            try:
                await asyncio.Future()
            finally:
                running -= 1
        roles = ['speculative'] * 7 + ['reserve'] * 2 + ['health']
        with timings(delay=.025), patch.object(core, 'curl', fetch):
            tasks = [self.start(session._budgeted(Candidate('http', f'8.8.4.{i+1}', 8080),
                                                   COUNTRIES, True, role))
                     for i, role in enumerate(roles)]
            await until(lambda: len(calls) == 22)
            await asyncio.sleep(.02)
            self.assertEqual(len(calls), 22)
            self.assertEqual(peak, 22)
            self.assertEqual(session.supplemental_budget.running, 2)
            self.assertEqual(session.check_budget.snapshot['running'], 10)
            await session.check_budget.close()
            await asyncio.gather(*tasks, return_exceptions=True)
        self.assertEqual(running, 0)
        self.assertEqual(session.supplemental_budget.running, 0)
        self.assertEqual(session.check_budget.snapshot['requests'], 0)
        self.assertEqual(session.diagnostics['attempts'], 0)

    async def test_reserve_joining_foreground_preserves_existing_unhedged_work(self):
        session = Session(COUNTRIES, lambda _: None)
        calls = []
        release = asyncio.Event()
        async def fetch(url, *_):
            calls.append(url)
            await release.wait()
            return response(url)
        try:
            with timings(), patch.object(core, 'curl', fetch):
                original = self.start(session.scan_report(A, COUNTRIES, True))
                await until(lambda: len(calls) == 2)
                reserve = self.start(session.reserve_report(A, COUNTRIES, True))
                await until(lambda: session.check_budget._requests[(A.key, True)].owners == 2)
                await asyncio.sleep(.035)
                self.assertEqual(len(calls), 2)
                self.assertEqual(session.supplemental_budget.running, 0)
                release.set()
                first, second = await asyncio.gather(original, reserve)
                self.assertTrue(first['ok'] and second['ok'])
                self.assertEqual(session.diagnostics['attempts'], 1)
        finally:
            release.set()
            await session.check_budget.close()


if __name__ == '__main__':
    unittest.main()
