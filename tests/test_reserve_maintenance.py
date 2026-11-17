"""Reserve SOCKS negotiation retries stay within the existing validation lease."""
import asyncio
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

if sys.version_info < (3, 11):
    raise RuntimeError('Reserve maintenance tests require Python 3.11 or newer')

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import core
from check_budget import SupplementalBudget
from core import Candidate, Session, inspect_proxy

COUNTRIES = ('AT', 'EE', 'NO')
A = Candidate('socks5', '8.8.8.8', 1080)


def response(url, country='EE'):
    return ((0, '200', f'loc={country}\nip=8.8.4.4\n') if url == core.TRACE
            else (0, '204', ''))


@contextmanager
def timings(delay=.015, deadline=.3):
    with patch.object(core, 'RESERVE_EXTRA_DELAY', delay), patch.object(core, 'RESERVE_PROBE_TIMEOUT', deadline):
        yield


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.001)


class ReserveMaintenance(unittest.IsolatedAsyncioTestCase):
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

    async def test_trace_and_target_retry_for_both_socks_protocols_and_equal_countries(self):
        for scheme in ('socks4', 'socks5'):
            for endpoint in (core.TRACE, core.TARGET):
                for country in COUNTRIES:
                    calls = Counter()
                    async def fetch(url, *_):
                        calls[url] += 1
                        if url == endpoint and calls[url] == 1:
                            return 97, '000', ''
                        return response(url, country)
                    item = Candidate(scheme, A.host, A.port)
                    with self.subTest(scheme=scheme, endpoint=endpoint, country=country), timings(), patch.object(core, 'curl', fetch):
                        report = await inspect_proxy(item, tuple(reversed(COUNTRIES)), True, extras=self.budget)
                    self.assertTrue(report['ok'])
                    self.assertEqual(report['proxy']['country'], country)
                    self.assertEqual(calls[endpoint], 2)
                    self.assertEqual(sum(calls.values()), 3)

    async def test_repeat_failure_and_hard_retry_results_reject_without_third_attempt(self):
        cases = [((97, '000', ''), 'connect'), ((60, '000', ''), 'tls'),
                 ((0, '503', ''), 'http'), ((0, '200', 'loc=US\nip=8.8.4.4'), 'country'),
                 ((0, '200', 'loc=EE\nip=127.0.0.1'), 'invalid_trace'),
                 (PermissionError('fixture'), 'internal')]
        for answer, reason in cases:
            calls = Counter()
            async def fetch(url, *_):
                calls[url] += 1
                if url == core.TRACE:
                    if calls[url] == 1:
                        return 97, '000', ''
                    if isinstance(answer, Exception):
                        raise answer
                    return answer
                return response(url)
            with self.subTest(reason=reason), timings(), patch.object(core, 'curl', fetch):
                report = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
            self.assertEqual((report['reason'], report['endpoint']), (reason, 'trace'))
            self.assertEqual(calls, {core.TRACE: 2, core.TARGET: 1})

    async def test_retry_still_requires_other_https_control(self):
        calls = Counter()
        release = asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE and calls[url] == 1:
                return 97, '000', ''
            if url == core.TARGET:
                await release.wait()
            return response(url)
        with timings(delay=.2), patch.object(core, 'curl', fetch):
            task = self.start(inspect_proxy(A, COUNTRIES, True, extras=self.budget))
            try:
                await until(lambda: calls[core.TRACE] == 2 or task.done())
                self.assertFalse(task.done())
                release.set()
                self.assertTrue((await task)['ok'])
            finally:
                release.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_started_hedge_is_only_retry_even_when_primary_fails_late(self):
        calls = Counter()
        hedge = asyncio.Event()
        primary = asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await hedge.wait()
                    primary.set()
                    return 97, '000', ''
                hedge.set()
                await primary.wait()
                await asyncio.sleep(.005)
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            report = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertTrue(report['ok'])
        self.assertEqual(calls, {core.TRACE: 2, core.TARGET: 1})

    async def test_denied_timer_allowance_cannot_retry_when_permit_later_released(self):
        held = [self.budget.acquire(), self.budget.acquire()]
        denied = asyncio.Event()
        original = self.budget.acquire
        def acquire():
            result = original()
            if result is None:
                denied.set()
            return result
        calls = Counter()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                await denied.wait()
                for owner in held:
                    self.budget.release(owner)
                held.clear()
                return 97, '000', ''
            return response(url)
        try:
            with timings(), patch.object(self.budget, 'acquire', acquire), patch.object(core, 'curl', fetch):
                report = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
            self.assertEqual(report['code'], 97)
            self.assertEqual(calls, {core.TRACE: 1, core.TARGET: 1})
        finally:
            for owner in held:
                self.budget.release(owner)

    async def test_denied_immediate_retry_never_queues(self):
        held = [self.budget.acquire(), self.budget.acquire()]
        calls = Counter()
        async def fetch(url, *_):
            calls[url] += 1
            return (97, '000', '') if url == core.TRACE else response(url)
        try:
            with timings(), patch.object(core, 'curl', fetch):
                report = await asyncio.wait_for(inspect_proxy(A, COUNTRIES, True, extras=self.budget), .1)
            self.assertEqual(report['code'], 97)
            for owner in held:
                self.budget.release(owner)
            held.clear()
            await asyncio.sleep(.025)
            self.assertEqual(calls, {core.TRACE: 1, core.TARGET: 1})
        finally:
            for owner in held:
                self.budget.release(owner)

    async def test_retry_near_deadline_does_not_renew_it(self):
        calls, drained = Counter(), []
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await asyncio.sleep(.04)
                    return 97, '000', ''
                try:
                    await asyncio.Future()
                finally:
                    drained.append(url)
            return response(url)
        with timings(delay=1, deadline=.065), patch.object(core, 'curl', fetch):
            started = time.monotonic()
            report = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
            elapsed = time.monotonic() - started
        self.assertEqual(report['reason'], 'timeout')
        self.assertGreaterEqual(elapsed, .055)
        self.assertLess(elapsed, .105)
        self.assertEqual(calls[core.TRACE], 2)
        self.assertEqual(drained, [core.TRACE])

    async def test_immediate_retry_consumes_timer_allowance_while_pending(self):
        calls = Counter()
        release = asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    return 97, '000', ''
                await release.wait()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            task = self.start(inspect_proxy(A, COUNTRIES, True, extras=self.budget))
            try:
                await until(lambda: calls[core.TRACE] == 2 or task.done())
                await asyncio.sleep(.04)
                self.assertEqual(calls[core.TRACE], 2)
                release.set()
                self.assertTrue((await task)['ok'])
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)

    async def test_completed_hard_primary_dominates_simultaneous_extra_success(self):
        for answer, reason in [((60, '000', ''), 'tls'), ((0, '503', ''), 'http'),
                               ((0, '200', 'loc=US\nip=8.8.4.4'), 'country'),
                               ((0, '200', 'loc=EE\nip=127.0.0.1'), 'invalid_trace')]:
            calls = Counter()
            release = asyncio.Event()
            async def fetch(url, *_):
                calls[url] += 1
                if url == core.TRACE:
                    if calls[url] == 1:
                        await release.wait()
                        return answer
                    release.set()
                return response(url)
            with self.subTest(reason=reason), timings(), patch.object(core, 'curl', fetch):
                report = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
            self.assertFalse(report['ok'])
            self.assertEqual(report['reason'], reason)
            self.assertEqual(calls[core.TRACE], 2)

    async def test_hard_result_returned_during_loser_cleanup_dominates_success(self):
        calls = Counter()
        disposed = asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE and calls[url] == 1:
                try:
                    await asyncio.Future()
                except asyncio.CancelledError:
                    await asyncio.sleep(.002)
                    disposed.set()
                    return 60, '000', ''
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            report = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertFalse(report['ok'])
        self.assertEqual((report['reason'], report['code']), ('tls', 60))
        self.assertTrue(disposed.is_set())

    async def test_completed_non97_primary_failure_still_dominates_extra_success(self):
        calls = Counter()
        release = asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await release.wait()
                    return 7, '000', ''
                release.set()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            report = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertFalse(report['ok'])
        self.assertEqual((report['reason'], report['code']), ('connect', 7))

    async def test_hard_extra_during_cleanup_dominates_primary_success(self):
        calls = Counter()
        extra_entered = asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    await extra_entered.wait()
                else:
                    extra_entered.set()
                    try:
                        await asyncio.Future()
                    except asyncio.CancelledError:
                        await asyncio.sleep(.002)
                        return 60, '000', ''
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            report = await inspect_proxy(A, COUNTRIES, True, extras=self.budget)
        self.assertFalse(report['ok'])
        self.assertEqual((report['reason'], report['code']), ('tls', 60))

    async def test_cancellation_drains_retry_before_releasing_permit(self):
        calls = Counter()
        cleanup = asyncio.Event()
        disposed = asyncio.Event()
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE:
                if calls[url] == 1:
                    return 97, '000', ''
                try:
                    await asyncio.Future()
                finally:
                    await cleanup.wait()
                    disposed.set()
            return response(url)
        with timings(), patch.object(core, 'curl', fetch):
            task = self.start(inspect_proxy(A, COUNTRIES, True, extras=self.budget))
            try:
                await until(lambda: calls[core.TRACE] == 2 or task.done())
                self.assertFalse(task.done())
                task.cancel()
                await asyncio.sleep(.005)
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
        self.assertTrue(disposed.is_set())

    async def test_other_modes_and_primary_failures_keep_existing_contract(self):
        for scheme, slow, optional, code in [('http', True, True, 97), ('socks5', False, True, 97),
                                             ('socks5', True, False, 97), ('socks5', True, True, 7),
                                             ('socks5', True, True, 56), ('socks5', True, True, 60)]:
            calls = Counter()
            async def fetch(url, *_):
                calls[url] += 1
                return (code, '000', '') if url == core.TRACE else response(url)
            with self.subTest(scheme=scheme, slow=slow, optional=optional, code=code), timings(), patch.object(core, 'curl', fetch):
                report = await inspect_proxy(Candidate(scheme, A.host, A.port), COUNTRIES, slow,
                                             extras=self.budget if optional else None)
            self.assertFalse(report['ok'])
            self.assertEqual(calls[core.TRACE], 1)

    async def test_session_maintenance_renews_only_after_full_success_and_remembers_once(self):
        calls = Counter()
        async def discover(*_):
            return [], []
        async def fetch(url, *_):
            calls[url] += 1
            if url == core.TRACE and calls[url] == 1:
                return 97, '000', ''
            return response(url)
        session = Session(COUNTRIES, lambda _: None, discoverer=discover)
        await session.check_budget.set_active(True)
        now = [100.]
        session.pool.clock = lambda: now[0]
        old = dict(scheme=A.scheme, host=A.host, port=A.port, country='EE', exitIp='8.8.4.4',
                   latencyMs=1, checkedAt=1)
        self.assertTrue(session.pool.accept(old))
        now[0] += 30
        original = session.history.observe
        observations = []
        def observe(*args, **kwargs):
            observations.append((args, kwargs))
            return original(*args, **kwargs)
        try:
            with timings(), patch.object(core, 'curl', fetch), patch.object(session.history, 'observe', observe):
                await session.pool.refresh()
            self.assertIn(A.key, session.pool.entries)
            self.assertEqual(session.pool.entries[A.key][1], now[0])
            self.assertNotEqual(session.pool.entries[A.key][0]['checkedAt'], 1)
            self.assertEqual([args[1] for args, _ in observations], ['success'])
            self.assertTrue(session.history.eligible(A))
            self.assertEqual(list(session.pool.removals), [])
            self.assertEqual(session.diagnostics['attempts'], 1)
            self.assertEqual(calls, {core.TRACE: 2, core.TARGET: 1})
        finally:
            await session.check_budget.close()

    async def test_session_terminal_retry_failure_quarantines_once_and_does_not_renew(self):
        async def discover(*_):
            return [], []
        calls = Counter()
        async def fetch(url, *_):
            calls[url] += 1
            return (97, '000', '') if url == core.TRACE else response(url)
        session = Session(COUNTRIES, lambda _: None, discoverer=discover)
        await session.check_budget.set_active(True)
        old = dict(scheme=A.scheme, host=A.host, port=A.port, country='EE', exitIp='8.8.4.4',
                   latencyMs=1, checkedAt=1)
        self.assertTrue(session.pool.accept(old))
        original = session.history.observe
        observations = []
        def observe(*args, **kwargs):
            observations.append((args, kwargs))
            return original(*args, **kwargs)
        try:
            with timings(), patch.object(core, 'curl', fetch), patch.object(session.history, 'observe', observe):
                await session.pool.refresh()
            self.assertNotIn(A.key, session.pool.entries)
            self.assertEqual([args[1] for args, _ in observations], ['unknown'])
            self.assertFalse(session.history.eligible(A))
            self.assertEqual(len(session.pool.removals), 1)
            event = session.pool.removals[0]
            self.assertEqual((event['stage'], event['reason'], event['check']['code']),
                             ('maintenance', 'checkFailed', 97))
            self.assertEqual(session.diagnostics['attempts'], 1)
            self.assertEqual(calls, {core.TRACE: 2, core.TARGET: 1})
        finally:
            await session.check_budget.close()

    async def test_session_health_and_speculative_checks_do_not_gain_retries(self):
        async def discover(*_):
            return [], []
        session = Session(COUNTRIES, lambda _: None, discoverer=discover)
        await session.check_budget.set_active(True)
        try:
            for role in ('health', 'speculative'):
                calls = Counter()
                async def fetch(url, *_):
                    calls[url] += 1
                    return (97, '000', '') if url == core.TRACE else response(url)
                with self.subTest(role=role), timings(), patch.object(core, 'curl', fetch):
                    report = await session._budgeted(A, COUNTRIES, True, role)
                self.assertEqual(report['code'], 97)
                self.assertEqual(calls, {core.TRACE: 1, core.TARGET: 1})
                self.assertEqual(session.supplemental_budget.running, 0)
        finally:
            await session.check_budget.close()


if __name__ == '__main__':
    unittest.main()
