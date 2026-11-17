"""Exercise the production scanner, strict HTTPS validator and shared history together."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import core
from core import Candidate, Session
from history import EndpointHistory

ITEM = Candidate('http', '8.8.8.8', 8080)


class SessionHistory(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = 0
        self.history = EndpointHistory(clock=lambda: self.now, jitter=lambda: 0)
        self.calls = []
        self.fast = self.slow = 'invalid'
        self.session = self.new_session('NO')

    def new_session(self, country):
        async def discover(_):
            return [ITEM], []
        return Session(country, lambda _: None, discoverer=discover, history=self.history)

    async def transport(self, url, candidate, slow=False):
        self.calls.append((url, candidate, slow))
        outcome = self.slow if slow else self.fast
        if isinstance(outcome, int):
            return outcome, '000', ''
        if outcome == 'http':
            return 0, '503', ''
        if url == core.TRACE:
            return 0, '200', 'ip=1.1.1.1\nloc=' + outcome
        return 0, '204', ''

    async def run_round(self, session=None):
        session = session or self.session
        with patch.object(core, 'curl', self.transport):
            proxy, _ = await session.search.run_round(
                session.scan_report, session.eligible, on_terminal=session.remember_check)
        return proxy

    async def test_fast_timeout_then_slow_success_uses_one_logical_result(self):
        self.fast, self.slow = 28, 'NO'
        self.assertEqual((await self.run_round())['country'], 'NO')
        self.assertEqual([slow for url, _, slow in self.calls if url == core.TRACE], [False, True])
        rec = self.history.get(ITEM)
        self.assertEqual((rec.streak, rec.last_outcome, rec.groups), (0, 'success', ('injected',)))

    async def test_final_failure_once_per_scan_and_each_expiry_allows_new_physical_check(self):
        for now, count, streak in ((0, 4, 1), (59, 4, 1), (60, 8, 2), (179, 8, 2)):
            self.now = now
            self.assertIsNone(await self.run_round())
            self.assertEqual((len(self.calls), self.history.get(ITEM).streak), (count, streak))
        self.assertTrue(self.session.eligible(Candidate(ITEM.scheme, ITEM.host, ITEM.port + 1)))
        self.now, self.fast = 180, 'NO'
        self.assertEqual((await self.run_round())['country'], 'NO')
        self.assertEqual((len(self.calls), self.history.get(ITEM).streak), (10, 0))

    async def test_infrastructure_and_country_are_not_terminal_endpoint_failures(self):
        for error, category in ((28, 'timeout'), (7, 'connect'), ('http', 'http'), (60, 'tls')):
            self.fast = self.slow = error
            self.assertIsNone(await self.run_round())
            rec = self.history.get(ITEM)
            self.assertEqual((rec.last_outcome, rec.cooldown_until, rec.streak), (category, self.now + 60, 0))
            self.now += 61
        self.fast = self.slow = 77
        self.assertIsNone(await self.run_round())
        self.assertTrue(self.history.eligible(ITEM))
        self.assertEqual(self.history.get(ITEM).last_outcome, 'tls')
        self.fast = self.slow = 'EE'
        self.assertIsNone(await self.run_round())
        self.assertEqual(self.history.get(ITEM).country_hint, 'EE')
        self.assertTrue(self.history.eligible(ITEM))
        before = len(self.calls)
        self.assertEqual((await self.run_round(self.new_session('EE')))['country'], 'EE')
        self.assertEqual(len(self.calls) - before, 2)

    async def test_missing_curl_or_local_permission_error_does_not_penalize_endpoint(self):
        for error in (FileNotFoundError, PermissionError):
            async def denied(*_):
                raise error()
            with patch.object(core, 'curl', denied):
                result, _ = await self.session.search.run_round(self.session.scan_report, self.session.eligible,
                                                                on_terminal=self.session.remember_check)
            self.assertIsNone(result)
            self.assertTrue(self.history.eligible(ITEM))
            self.assertIsNone(self.history.get(ITEM).last_outcome)

    async def test_cancel_before_slow_finishes_creates_no_cooldown(self):
        entered = asyncio.Event()
        async def interrupted(url, item, slow=False):
            if slow:
                entered.set()
                await asyncio.Future()
            return 28, '000', ''
        with patch.object(core, 'curl', interrupted):
            task = asyncio.create_task(self.session.search.run_round(
                self.session.scan_report, self.session.eligible, on_terminal=self.session.remember_check))
            await asyncio.wait_for(entered.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(self.history.eligible(ITEM))
        self.assertIsNone(self.history.get(ITEM).last_outcome)
        self.assertFalse(self.session.check_budget.snapshot['requests'])
