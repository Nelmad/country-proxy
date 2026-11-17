"""A reserve timeout can use an existing hedge, never acquire another transfer."""
import asyncio
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

if sys.version_info < (3, 11):
    raise RuntimeError('Reserve timeout tests require Python 3.11 or newer')

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import core
from check_budget import SupplementalBudget

COUNTRIES = ('AT', 'EE', 'NO')
A = core.Candidate('http', '8.8.8.8', 8080)


def response(url, country='EE'):
    return ((0, '200', f'loc={country}\nip=8.8.4.4\n') if url == core.TRACE else (0, '204', ''))


@contextmanager
def timings(delay=.005, deadline=.2):
    with patch.object(core, 'RESERVE_EXTRA_DELAY', delay), patch.object(core, 'RESERVE_PROBE_TIMEOUT', deadline):
        yield


async def until(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(.001)


class CountingBudget(SupplementalBudget):
    def __init__(self):
        super().__init__()
        self.acquisitions = 0
        self.peak = 0

    def acquire(self):
        self.acquisitions += 1
        owner = super().acquire()
        self.peak = max(self.peak, self.running)
        return owner


class ReserveTimeout(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.budget = CountingBudget()

    async def asyncTearDown(self):
        self.assertEqual(self.budget.running, 0)

    def after_timeout(self, endpoint=core.TRACE, country='EE', answer=None):
        calls, entered, failed = Counter(), asyncio.Event(), asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == endpoint:
                if calls[url] == 1:
                    await entered.wait()
                    failed.set()
                    return 28, '000', ''
                entered.set()
                await failed.wait()
                await asyncio.sleep(.003)
                if isinstance(answer, Exception):
                    raise answer
                if answer is not None:
                    return answer
            return response(url, country)
        return fetch, calls, entered, failed

    async def test_existing_hedge_survives_timeout_for_each_control_protocol_and_country(self):
        for scheme in ('http', 'https', 'socks4', 'socks5'):
            for endpoint in (core.TRACE, core.TARGET):
                for country in COUNTRIES:
                    fetch, calls, _, _ = self.after_timeout(endpoint, country)
                    budget = CountingBudget()
                    with self.subTest(scheme=scheme, endpoint=endpoint, country=country), timings(), patch.object(core, 'curl', fetch):
                        report = await core.inspect_proxy(core.Candidate(scheme, A.host, A.port),
                            tuple(reversed(COUNTRIES)), True, extras=budget)
                        self.assertTrue(report['ok'])
                        self.assertEqual(report['proxy']['country'], country)
                        self.assertEqual(calls[endpoint], 2)
                        self.assertEqual(sum(calls.values()), 3)
                        self.assertEqual((budget.acquisitions, budget.peak, budget.running), (1, 1, 0))

    async def test_failed_hedge_retains_original_timeout_without_third_transfer(self):
        for answer in ((7, '000', ''), (28, '000', ''), (56, '000', '')):
            fetch, calls, _, _ = self.after_timeout(answer=answer)
            with self.subTest(answer=answer), timings(), patch.object(core, 'curl', fetch):
                report = await core.inspect_proxy(A, COUNTRIES, True, extras=self.budget)
            self.assertEqual((report['reason'], report['code']), ('timeout', 28))
            self.assertEqual(calls, {core.TRACE: 2, core.TARGET: 1})

    async def test_completed_hedge_success_is_not_hidden_by_primary_timeout_callback_order(self):
        calls, release = Counter(), asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await release.wait()
                    return 28, '000', ''
                release.set()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            report = await core.inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertTrue(report['ok'])
        self.assertEqual((calls[core.TRACE], self.budget.acquisitions), (2, 1))

    async def test_hard_hedge_failure_still_vetoes_after_primary_timeout(self):
        for answer, reason in [((35, '000', ''), 'tls'), ((60, '000', ''), 'tls'),
                              ((0, '503', ''), 'http'), ((0, '200', 'loc=US\nip=8.8.4.4'), 'country'),
                              ((0, '200', 'loc=EE\nip=127.0.0.1'), 'invalid_trace'),
                              (PermissionError('fixture'), 'internal')]:
            fetch, calls, _, _ = self.after_timeout(answer=answer)
            with self.subTest(reason=reason), timings(), patch.object(core, 'curl', fetch):
                report = await core.inspect_proxy(A, COUNTRIES, True, extras=self.budget)
            self.assertEqual((report['reason'], report['endpoint']), (reason, 'trace'))
            if reason == 'tls':
                self.assertEqual(report['code'], answer[0])
            self.assertEqual(calls, {core.TRACE: 2, core.TARGET: 1})

    async def test_timeout_before_hedge_never_starts_or_acquires_one(self):
        calls = Counter()
        async def fetch(url, *_):
            calls[url] += 1
            return (28, '000', '') if url == core.TRACE else response(url)
        with timings(), patch.object(core, 'curl', fetch):
            report = await core.inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertEqual(report['code'], 28)
        self.assertEqual(self.budget.acquisitions, 0)
        self.assertEqual(calls, {core.TRACE: 1, core.TARGET: 1})

    async def test_denied_timer_is_not_retried_when_permit_later_becomes_free(self):
        held = [self.budget.acquire(), self.budget.acquire()]
        denied = asyncio.Event()
        original = self.budget.acquire
        def acquire():
            owner = original()
            if owner is None:
                denied.set()
            return owner
        calls = Counter()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                await denied.wait()
                for owner in held:
                    self.budget.release(owner)
                held.clear()
                return 28, '000', ''
            return response(url)
        try:
            with timings(), patch.object(self.budget, 'acquire', acquire), patch.object(core, 'curl', fetch):
                report = await core.inspect_proxy(A, COUNTRIES, True, extras=self.budget)
            self.assertEqual(report['code'], 28)
            self.assertEqual(self.budget.acquisitions, 3)
            self.assertEqual(calls, {core.TRACE: 1, core.TARGET: 1})
        finally:
            for owner in held:
                self.budget.release(owner)

    async def test_already_failed_hedge_does_not_erase_primary_timeout(self):
        calls, failed = Counter(), asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await failed.wait()
                    await asyncio.sleep(.002)
                    return 28, '000', ''
                failed.set()
                return 7, '000', ''
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            report = await core.inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertEqual((report['reason'], report['code']), ('timeout', 28))
        self.assertEqual(calls[core.TRACE], 2)

    async def test_process_timeout_without_code28_still_cancels_existing_hedge(self):
        calls, entered, disposed = Counter(), asyncio.Event(), asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await entered.wait()
                    raise TimeoutError()
                entered.set()
                try:
                    await asyncio.Future()
                finally:
                    disposed.set()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            report = await asyncio.wait_for(core.inspect_proxy(A, COUNTRIES, True, extras=self.budget), .1)
        self.assertEqual(report['reason'], 'timeout')
        self.assertNotIn('code', report)
        self.assertTrue(disposed.is_set())

    async def test_shared_deadline_is_not_reset_by_primary_timeout(self):
        calls, disposed = Counter(), []
        async def fetch(url, *_):
            calls[url] += 1
            if calls[url] == 1:
                await asyncio.sleep(.035)
                return 28, '000', ''
            try:
                await asyncio.Future()
            finally:
                disposed.append(url)
        with timings(deadline=.065), patch.object(core, 'curl', fetch):
            start = time.monotonic()
            report = await core.inspect_proxy(A, COUNTRIES, True, extras=self.budget)
            duration = time.monotonic() - start
        self.assertEqual(report['reason'], 'timeout')
        self.assertGreaterEqual(duration, .055)
        self.assertLess(duration, .105)
        self.assertEqual(calls, {core.TRACE: 2, core.TARGET: 2})
        self.assertCountEqual(disposed, [core.TRACE, core.TARGET])
        self.assertEqual((self.budget.acquisitions, self.budget.peak), (2, 2))

    async def test_other_https_control_is_still_required(self):
        calls, entered, failed, release = Counter(), asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await entered.wait()
                    failed.set()
                    return 28, '000', ''
                entered.set()
            else:
                await release.wait()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            task = asyncio.create_task(core.inspect_proxy(A, COUNTRIES, True, extras=self.budget))
            try:
                await failed.wait()
                await asyncio.sleep(.008)
                self.assertFalse(task.done())
                release.set()
                self.assertTrue((await task)['ok'])
            finally:
                release.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_cancellation_drains_waiting_hedge_before_returning(self):
        calls, entered, failed, cleanup = Counter(), asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await entered.wait()
                    failed.set()
                    return 28, '000', ''
                entered.set()
                try:
                    await asyncio.Future()
                finally:
                    await cleanup.wait()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            task = asyncio.create_task(core.inspect_proxy(A, COUNTRIES, True, extras=self.budget))
            try:
                await failed.wait()
                await asyncio.sleep(.003)
                self.assertFalse(task.done())
                task.cancel()
                await asyncio.sleep(.003)
                self.assertEqual(self.budget.running, 1)
                task.cancel()
                cleanup.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            finally:
                cleanup.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_completed_primary_tls35_is_never_masked_by_hedge_success(self):
        calls, release = Counter(), asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await release.wait()
                    return 35, '000', ''
                release.set()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            report = await core.inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertEqual((report['reason'], report['code']), ('tls', 35))

    async def test_hard_result_during_cleanup_vetoes_other_attempt_success(self):
        calls, entered = Counter(), asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await entered.wait()
                    try:
                        await asyncio.Future()
                    except asyncio.CancelledError:
                        return 35, '000', ''
                entered.set()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            report = await core.inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertEqual((report['reason'], report['code']), ('tls', 35))

    async def test_health_speculative_and_fast_checks_have_no_timeout_hedge(self):
        async def discover(*_):
            return [], []
        session = core.Session(COUNTRIES, lambda _: None, discoverer=discover)
        await session.check_budget.set_active(True)
        try:
            for role, slow in (('health', True), ('speculative', True), ('reserve', False)):
                calls = Counter()
                async def fetch(url, *_):
                    calls[url] += 1
                    return (28, '000', '') if url == core.TRACE else response(url)
                with self.subTest(role=role, slow=slow), timings(), patch.object(core, 'curl', fetch):
                    report = await session._budgeted(A, COUNTRIES, slow, role)
                self.assertEqual(report['code'], 28)
                self.assertEqual(calls[core.TRACE], 1)
                self.assertEqual(session.supplemental_budget.running, 0)
        finally:
            await session.check_budget.close()

    async def test_session_maintenance_history_once_for_success_and_terminal_failure(self):
        async def discover(*_):
            return [], []
        for answer, expected in ((None, 'success'), ((28, '000', ''), 'unknown')):
            session = core.Session(COUNTRIES, lambda _: None, discoverer=discover)
            await session.check_budget.set_active(True)
            now = [100.]
            session.pool.clock = lambda: now[0]
            old = dict(scheme=A.scheme, host=A.host, port=A.port, country='EE', exitIp='8.8.4.4',
                       latencyMs=1, checkedAt=1)
            self.assertTrue(session.pool.accept(old))
            now[0] += 30
            fetch, calls, _, _ = self.after_timeout(answer=answer)
            original, outcomes = session.history.observe, []
            def observe(item, kind, **kwargs):
                outcomes.append(kind)
                return original(item, kind, **kwargs)
            try:
                with self.subTest(expected=expected), timings(), patch.object(core, 'curl', fetch), patch.object(session.history, 'observe', observe):
                    await session.pool.refresh()
                self.assertEqual(outcomes, [expected])
                self.assertEqual(session.diagnostics['attempts'], 1)
                self.assertEqual(calls[core.TRACE], 2)
                self.assertEqual(session.history.eligible(A), expected == 'success')
                if expected == 'success':
                    self.assertEqual(session.pool.entries[A.key][1], now[0])
                    self.assertNotEqual(session.pool.entries[A.key][0]['checkedAt'], 1)
                    self.assertFalse(session.pool.removals)
                else:
                    self.assertNotIn(A.key, session.pool.entries)
                    self.assertEqual(session.pool.removals[0]['check']['code'], 28)
            finally:
                await session.check_budget.close()

    async def test_expired_lease_cannot_be_renewed_by_late_hedge(self):
        async def discover(*_):
            return [], []
        session = core.Session(COUNTRIES, lambda _: None, discoverer=discover)
        await session.check_budget.set_active(True)
        now = [100.]
        session.pool.clock = lambda: now[0]
        old = dict(scheme=A.scheme, host=A.host, port=A.port, country='EE', exitIp='8.8.4.4',
                   latencyMs=1, checkedAt=1)
        self.assertTrue(session.pool.accept(old))
        entered, failed, release, calls = asyncio.Event(), asyncio.Event(), asyncio.Event(), Counter()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await entered.wait()
                    failed.set()
                    return 28, '000', ''
                entered.set()
                await release.wait()
            return response(url)
        try:
            with timings(), patch.object(core, 'curl', fetch):
                task = asyncio.create_task(session.pool.refresh())
                try:
                    await failed.wait()
                    now[0] += 91
                    session.pool.prune()
                    release.set()
                    await task
                finally:
                    release.set()
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            self.assertNotIn(A.key, session.pool.entries)
            self.assertEqual(session.pool.removals[0]['reason'], 'expired')
        finally:
            await session.check_budget.close()

    async def test_removed_or_changed_generation_lease_cannot_be_renewed_by_late_hedge(self):
        async def discover(*_):
            return [], []
        for invalidate in ('removed', 'generation'):
            session = core.Session(COUNTRIES, lambda _: None, discoverer=discover)
            await session.check_budget.set_active(True)
            old = dict(scheme=A.scheme, host=A.host, port=A.port, country='EE', exitIp='8.8.4.4',
                       latencyMs=1, checkedAt=1)
            self.assertTrue(session.pool.accept(old))
            original_entry = session.pool.entries[A.key]
            entered, failed, release, calls = asyncio.Event(), asyncio.Event(), asyncio.Event(), Counter()
            async def fetch(url, *_):
                calls[url] += 1
                if url == core.TRACE:
                    if calls[url] == 1:
                        await entered.wait()
                        failed.set()
                        return 28, '000', ''
                    entered.set()
                    await release.wait()
                return response(url)
            try:
                with self.subTest(invalidate=invalidate), timings(), patch.object(core, 'curl', fetch):
                    task = asyncio.create_task(session.pool.refresh())
                    try:
                        await failed.wait()
                        if invalidate == 'removed':
                            session.pool._remove(A.key, 'removed')
                        else:
                            session.pool._generation += 1
                        release.set()
                        await task
                    finally:
                        release.set()
                        if not task.done():
                            task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                if invalidate == 'removed':
                    self.assertNotIn(A.key, session.pool.entries)
                else:
                    self.assertIn(A.key, session.pool.entries)
                    self.assertIs(session.pool.entries[A.key], original_entry)
                    self.assertEqual(original_entry[0]['checkedAt'], 1)
            finally:
                await session.check_budget.close()


if __name__ == '__main__':
    unittest.main()
