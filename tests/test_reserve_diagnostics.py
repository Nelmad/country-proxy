import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, Session
from history import EndpointHistory
from pool import ReservePool
from sources import SourceBatch


def endpoint(index):
    return Candidate('http', f'192.0.2.{index}', 8080)


def verified(item, exit_ip=None, cc='NO'):
    return {'country': cc, 'scheme': item.scheme, 'host': item.host, 'port': item.port,
            'exitIp': exit_ip or item.host}


class ReserveDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    async def test_shared_stream_explains_duplicate_quarantine_timeout_and_one_independent_reserve(self):
        active, duplicate_exit, quarantine, timeout, wrong_country, independent = map(endpoint, range(1, 7))
        offers = [active, active, duplicate_exit, quarantine, timeout, wrong_country, independent]
        async def sources(cc):
            for feed in ('first', 'mirror'):
                yield SourceBatch('group', feed, tuple(offers), None, 10, feed == 'mirror')
        async def curl(url, item, slow):
            if item == timeout:
                return 28, '000', ''
            geo = 'PL' if item == wrong_country else 'EE'
            ip = '8.8.8.8' if item == duplicate_exit else '8.8.4.4'
            return (0, '200', f'ip={ip}\nloc={geo}') if '/trace' in url else (0, '204', '')
        events = []
        session = Session(['AT', 'NO', 'EE'], events.append, source_stream=sources, source_groups=('group',),
                          history=EndpointHistory(endpoint_validator=lambda address: str(address).startswith('192.0.2.')))
        session.active = verified(active, exit_ip='8.8.8.8')
        session.history.observe(quarantine, 'unknown', reason='timeout')
        with patch('core.curl', curl):
            await session.pool._refill()
        session.pool.publish()
        report = events[-1]['diagnostics']['reserve']
        for key, expected in {'rounds': 1, 'checked': 4, 'checkFailed': 2, 'qualified': 2,
                              'qualifiedUnique': 2, 'added': 1, 'sameHost': 1, 'sameExit': 1,
                              'quarantined': 1, 'unused': 0}.items():
            self.assertEqual(report['counts'].get(key, 0), expected, key)
        self.assertEqual(report['failures'], {'country': 1, 'timeout': 1})
        self.assertEqual(set(session.pool.entries), {independent.key})
        self.assertNotIn('192.0.2.', json.dumps(report))
        self.assertEqual(report['state'], 'waiting')
        session.active = None
        session.previous = verified(active)
        session.pool.publish()
        self.assertEqual(events[-1]['diagnostics']['reserve']['state'], 'noActive')
        self.assertEqual(report['state'], 'waiting')

    async def test_browser_gate_counts_offers_once_and_rejects_only_current_attempt(self):
        active = endpoint(1)
        events = []
        async def discover(cc): return [active], []
        async def check(item, cc, slow): return verified(item)
        session = Session(['AT', 'EE', 'NO'], events.append, discover, check, interval=60)
        session.wait_for_browser = True
        task = asyncio.create_task(session.run())
        try:
            async with asyncio.timeout(2):
                while not events or not any(e['phase'] == 'connected' for e in events):
                    await asyncio.sleep(.001)
            session.pool.publish()
            first = events[-1]['diagnostics']['reserve']
            self.assertEqual(first['state'], 'awaitingBrowser')
            self.assertEqual(first['counts'], {'offered': 1, 'confirmed': 0, 'rejected': 0})
            address = {'scheme': active.scheme, 'host': active.host, 'port': active.port}
            self.assertFalse(session.browser_feedback('confirm', 2, address))
            self.assertTrue(session.browser_feedback('confirm', 1, address))
            self.assertTrue(session.browser_feedback('confirm', 1, address))
            self.assertEqual(events[-1]['diagnostics']['reserve']['counts']['confirmed'], 1)
            self.assertNotEqual(events[-1]['diagnostics']['reserve']['state'], 'awaitingBrowser')
            self.assertTrue(session.browser_feedback('reject', 1, address, 'transport'))
            self.assertFalse(session.browser_feedback('reject', 1, address, 'transport'))
            session.pool.publish()
            self.assertEqual(events[-1]['diagnostics']['reserve']['counts']['rejected'], 1)
            self.assertEqual(first['counts']['confirmed'], 0)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_empty_filtered_and_partly_unavailable_sources(self):
        active, alternative = endpoint(1), endpoint(2)
        for streaming in (True, False):
            with self.subTest(streaming=streaming):
                rows, warnings = [], []
                async def discover(cc):
                    return rows, warnings
                async def check(item, cc, slow):
                    return verified(item)
                session = Session('NO', lambda _: None, discoverer=discover, checker=check)
                pool = session.pool
                session.active = verified(active)
                if not streaming:
                    pool.stream_round = None
                def totals():
                    keys = ('rounds', 'roundsWithoutChecks', 'roundsWithSourceWarnings', 'added')
                    return [pool.counts[k] for k in keys]
                await pool._refill()
                self.assertEqual(totals(), [1, 1, 0, 0])
                warnings.append('private-source-warning')
                await pool._refill()
                self.assertEqual(totals(), [2, 2, 1, 0])
                rows.append(active)
                await pool._refill()
                self.assertEqual(totals(), [3, 3, 2, 0])
                self.assertGreater(pool.counts['sameHost'], 0)
                rows.append(alternative)
                await pool._refill()
                self.assertEqual(totals(), [4, 3, 3, 1])
                self.assertNotIn('private-source-warning', json.dumps(pool.diagnostic_snapshot(True)))

    async def test_browser_feedback_with_a_pool_without_diagnostic_methods(self):
        class ExistingPool:
            def __init__(self, *args):
                self.refill_allowed = asyncio.Event()

        session = Session('NO', lambda _: None, pool_factory=ExistingPool)
        session.active = verified(endpoint(1))
        session.offer_attempt = 1
        session.wait_for_browser = True
        address = {k: session.active[k] for k in ('scheme', 'host', 'port')}
        self.assertTrue(session.browser_feedback('confirm', 1, address))
        self.assertTrue(session.pool.refill_allowed.is_set())
        self.assertTrue(session.browser_feedback('reject', 1, address, 'transport'))
        self.assertTrue(session.force_rotate)

    async def test_lease_maintenance_does_not_count_as_new_admission_and_expiry_once(self):
        active, alternative = endpoint(1), endpoint(2)
        now = [10]
        async def discover(cc): return [alternative], []
        async def check(item, cc, slow): return verified(item)
        pool = ReservePool('NO', discover, check, lambda: verified(active), lambda _: True,
                           lambda *_: None, lambda _: None, clock=lambda: now[0])
        await pool._refill()
        await pool.refresh()
        self.assertEqual(pool.counts['added'], 1)
        self.assertEqual(pool.counts['alreadyReserved'], 1)
        now[0] += pool.ttl
        pool.publish()
        pool.publish()
        self.assertEqual(pool.counts['expired'], 1)
        await pool._refill()
        self.assertEqual(pool.counts['qualified'], 2)
        self.assertEqual(pool.counts['qualifiedUnique'], 1)
        self.assertEqual(pool.counts['added'], 2)

    async def test_cancelling_refill_does_not_record_a_dead_endpoint(self):
        entered = asyncio.Event()
        async def discover(cc): return [endpoint(2)], []
        async def check(*args):
            entered.set()
            await asyncio.Future()
        pool = ReservePool('NO', discover, check, lambda: verified(endpoint(1)), lambda _: True,
                           lambda *_: None, lambda _: None)
        task = asyncio.create_task(pool._refill())
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertEqual((pool.counts['checked'], pool.counts['cancelled'], pool.counts['checkFailed']), (1, 1, 0))
