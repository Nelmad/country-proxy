import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, Session, inspect_proxy

A = Candidate('http', '8.8.8.8', 3128)
B = Candidate('http', '1.1.1.1', 3128)

def proxy(c, cc='EE'):
    return dict(scheme=c.scheme, host=c.host, port=c.port, country=cc,
                exitIp=c.host, latencyMs=1, checkedAt=123)

async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.001)

class Diagnostics(unittest.IsolatedAsyncioTestCase):
    async def test_transport_tls_http_and_country_are_distinguished(self):
        cases = [
            ((28, '000', ''), 'timeout'), ((60, '000', ''), 'tls'),
            ((7, '000', ''), 'connect'), ((56, '000', ''), 'transport'),
            ((0, '503', 'provider text'), 'http'), (TimeoutError(), 'timeout'),
            ((0, '200', 'loc=NO\nip=8.8.8.8'), 'country'),
            ((0, '200', 'loc=EE\nip=127.0.0.1'), 'invalid_trace'),
            ((0, '200', 'loc=EE\nip=224.0.0.1'), 'invalid_trace'),
            ((0, '200', 'loc=EE\nip=invalid'), 'invalid_trace'),
        ]
        for response, reason in cases:
            async def fetch(url, *args):
                if 'trace' not in url:
                    return 0, '204', ''
                if isinstance(response, Exception):
                    raise response
                return response
            with self.subTest(reason=reason), patch('core.curl', fetch):
                report = await inspect_proxy(A, 'EE')
                self.assertFalse(report['ok'])
                self.assertEqual(report['reason'], reason)
                self.assertNotIn('proxy', report)
                self.assertNotIn('provider text', str(report))

    async def test_country_alone_does_not_bypass_second_https_target(self):
        async def fetch(url, *args):
            return (0, '200', 'loc=EE\nip=8.8.8.8') if 'trace' in url else (0, '403', '')
        with patch('core.curl', fetch):
            report = await inspect_proxy(A, 'EE')
        self.assertEqual((report['reason'], report['endpoint']), ('http', 'target'))

    async def test_accepted_probe_has_verified_exit_and_country(self):
        async def fetch(url, *args):
            return (0, '200', 'loc=EE\nip=8.8.4.4') if 'trace' in url else (0, '204', '')
        with patch('core.curl', fetch):
            report = await inspect_proxy(A, 'EE')
        self.assertTrue(report['ok'])
        self.assertEqual(report['proxy']['exitIp'], '8.8.4.4')
        self.assertEqual(report['proxy']['country'], 'EE')

    async def test_session_publishes_detached_failure_counts(self):
        events = []
        async def sources(cc): return [A], []
        async def fetch(*args): return 28, '000', ''
        session = Session('EE', events.append, sources, interval=60, retry=60)
        with patch('core.curl', fetch):
            task = asyncio.create_task(session.run())
            try:
                await until(lambda: any(e['phase'] == 'empty' for e in events))
                snapshot = next(e['diagnostics'] for e in events if e['phase'] == 'empty')
                self.assertEqual(snapshot['reserve']['state'], 'noActive')
                self.assertEqual({k:v for k,v in snapshot.items() if k != 'reserve'}, {'attempts': 2, 'passed': 0, 'failures': {'timeout': 2}})
                await session.checked(A, 'EE')
                self.assertEqual(snapshot['failures']['timeout'], 2)
            finally:
                task.cancel(); await asyncio.gather(task, return_exceptions=True)

    async def test_transient_discovery_and_checker_errors_do_not_kill_session(self):
        events = []; discoveries = 0
        async def sources(cc):
            nonlocal discoveries
            discoveries += 1
            if discoveries == 1: raise RuntimeError('provider unavailable')
            return [A, B], []
        async def checker(c, cc, slow):
            if c == A: raise RuntimeError('one broken candidate')
            return proxy(c, cc)
        session = Session('EE', events.append, sources, checker, interval=60, retry=.001)
        task = asyncio.create_task(session.run())
        try:
            await until(lambda: session.active is not None)
            self.assertFalse(task.done())
            self.assertEqual(session.active['host'], B.host)
            self.assertTrue(any(e['phase'] == 'empty' for e in events))
            self.assertGreater(session.diagnostics['failures']['internal'], 0)
        finally:
            task.cancel(); await asyncio.gather(task, return_exceptions=True)

    async def test_browser_rejection_cancels_inflight_health_before_promotion(self):
        entered = asyncio.Event(); cancelled = asyncio.Event(); calls = 0; events = []
        async def sources(cc): return [A, B], []
        async def checker(c, cc, slow):
            nonlocal calls
            if c == A:
                calls += 1
                if calls > 1:
                    entered.set()
                    try: await asyncio.sleep(60)
                    finally: cancelled.set()
            else: await asyncio.sleep(.001)
            return proxy(c, cc)
        session = Session('EE', events.append, sources, checker, interval=60)
        task = asyncio.create_task(session.run())
        try:
            await until(lambda: len(session.pool.entries) == 1)
            session.nudge()
            await asyncio.wait_for(entered.wait(), 1)
            session.nudge(True)
            await until(lambda: session.active and session.active['host'] == B.host)
            self.assertTrue(cancelled.is_set())
            self.assertIn('reserve', [e['phase'] for e in events])
        finally:
            task.cancel(); await asyncio.gather(task, return_exceptions=True)
        self.assertIsNone(session.pool_task)
