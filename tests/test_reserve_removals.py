"""Removal causes belong to one lease and its completed check, never a global error."""
import asyncio
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, Session
from pool import ReservePool

A = Candidate('http', '8.8.8.8', 3128)
B = Candidate('socks5', '1.1.1.1', 1080)
ACTIVE = Candidate('http', '9.9.9.9', 8080)


def proxy(item, **extra):
    return dict(scheme=item.scheme, host=item.host, port=item.port, country='NO',
                exitIp=item.host, latencyMs=1, checkedAt=1, **extra)


class RemovalTests(unittest.IsolatedAsyncioTestCase):
    def make(self, report=None, checker=None):
        self.now = 10
        self.blocked = set()
        self.active = None
        async def discover(*_):
            return [], []
        async def legacy(item, *_):
            return proxy(item)
        pool = ReservePool(('NO', 'EE', 'AT'), discover, checker or legacy,
                           lambda: self.active, lambda item: item.key not in self.blocked,
                           lambda item, _: self.blocked.add(item.key), lambda _: None,
                           clock=lambda: self.now)
        pool.report_checker = report
        return pool

    def events(self, pool):
        return pool.diagnostic_snapshot(True)['removals']

    async def test_failure_quarantines_then_prune_keeps_exact_cause(self):
        async def report(item, *_):
            self.blocked.add(item.key)
            return {'ok': False, 'reason': 'tls', 'endpoint': 'trace', 'code': 35, 'latencyMs': 13}
        pool = self.make(report)
        pool.accept(proxy(A))
        reserve_id = pool._reserve_ids[A.key]
        await pool.refresh()
        self.assertEqual(self.events(pool), [dict(id=1, reserveId=reserve_id,
            atMs=self.events(pool)[0]['atMs'], ageMs=0, stage='maintenance', reason='checkFailed',
            check={'reason': 'tls', 'endpoint': 'trace', 'code': 35, 'latencyMs': 13})])

    async def test_concurrent_failures_keep_lease_and_endpoint_attribution(self):
        entered = set()
        both = asyncio.Event()
        async def report(item, *_):
            entered.add(item.key)
            if len(entered) == 2:
                both.set()
            await both.wait()
            self.blocked.add(item.key)
            return ({'ok': False, 'reason': 'http', 'endpoint': 'target', 'status': '503', 'latencyMs': 4}
                    if item == A else {'ok': False, 'reason': 'timeout', 'endpoint': 'trace', 'code': 28, 'latencyMs': 45})
        pool = self.make(report)
        pool.accept(proxy(A)); pool.accept(proxy(B))
        ids = dict(pool._reserve_ids)
        await pool.refresh()
        events = {e['reserveId']: e for e in self.events(pool)}
        self.assertEqual(events[ids[A.key]]['check'], {'reason': 'http', 'endpoint': 'target', 'status': 503, 'latencyMs': 4})
        self.assertEqual(events[ids[B.key]]['check'], {'reason': 'timeout', 'endpoint': 'trace', 'code': 28, 'latencyMs': 45})
        self.assertTrue(all(e['stage'] == 'maintenance' for e in events.values()))

    async def test_ttl_wins_over_late_failure_and_is_not_rewritten(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def report(*_):
            entered.set(); await finish.wait()
            return {'ok': False, 'reason': 'tls', 'endpoint': 'trace', 'code': 35}
        pool = self.make(report); pool.accept(proxy(A))
        task = asyncio.create_task(pool.refresh())
        await entered.wait()
        self.now += 91; pool.prune()
        before = self.events(pool)
        finish.set(); await task
        self.assertEqual(self.events(pool), before)
        self.assertEqual(before[0]['reason'], 'expired')
        self.assertEqual(before[0]['stage'], 'prune')
        self.assertNotIn('check', before[0])
        self.assertEqual(before[0]['ageMs'], 91000)

    async def test_successful_refresh_and_consumed_winner_are_not_removals(self):
        pool = self.make(); pool.accept(proxy(A))
        old_id = pool._reserve_ids[A.key]
        await pool.refresh()
        self.assertNotEqual(old_id, pool._reserve_ids[A.key])
        self.assertEqual((await pool.take())['host'], A.host)
        self.assertEqual(self.events(pool), [])

    async def test_cancelled_check_ignoring_cancel_has_no_failure_event(self):
        entered = asyncio.Event()
        async def report(*_):
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                return {'ok': False, 'reason': 'http', 'status': '503'}
        pool = self.make(report); pool.accept(proxy(A))
        task = asyncio.create_task(pool.refresh()); await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.events(pool), [])
        self.assertIn(A.key, pool.entries)

    async def test_replaced_lease_does_not_inherit_old_check_failure(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def report(*_):
            entered.set(); await finish.wait()
            return {'ok': False, 'reason': 'tls', 'code': 35}
        pool = self.make(report); pool.accept(proxy(A))
        task = asyncio.create_task(pool.refresh()); await entered.wait()
        old_id = pool._reserve_ids[A.key]
        pool._remove(A.key); pool.accept(proxy(A))
        new_id = pool._reserve_ids[A.key]
        finish.set(); await task
        self.assertNotEqual(old_id, new_id)
        self.assertEqual(self.events(pool), [])
        self.assertEqual(pool._reserve_ids[A.key], new_id)

    async def test_new_success_clears_aborted_owners_previous_failure(self):
        calls = 0
        async def report(item, *_):
            nonlocal calls
            calls += 1
            if calls == 1:
                # Complete the physical check, then cancel its lease owner before
                # it applies the verdict. A later check must replace that evidence.
                asyncio.get_running_loop().call_soon(first.cancel)
                return {'ok': False, 'reason': 'tls', 'endpoint': 'trace', 'code': 58}
            result = proxy(item); result['exitIp'] = B.host
            return {'ok': True, 'proxy': result}
        pool = self.make(report); pool.accept(proxy(A)); pool.accept(proxy(B))
        entry, token = pool.entries[A.key], pool._tokens[A.key]
        first = asyncio.create_task(pool._refresh_one(A.key, entry, token, pool._generation))
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertEqual(self.events(pool), [])
        self.assertIn(pool._reserve_ids[A.key], pool._lease_checks)
        await pool._refresh_one(A.key, entry, token, pool._generation)
        event = self.events(pool)[0]
        self.assertEqual((event['stage'], event['reason']), ('maintenance', 'sameExit'))
        self.assertNotIn('check', event)
        self.assertEqual(len(self.events(pool)), 1)

    async def test_old_generation_completion_does_not_attribute_a_failure(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def report(*_):
            entered.set(); await finish.wait()
            return {'ok': False, 'reason': 'tls', 'endpoint': 'trace', 'code': 35}
        pool = self.make(report); pool.accept(proxy(A))
        task = asyncio.create_task(pool.refresh()); await entered.wait()
        pool._generation += 1
        finish.set(); await task
        self.assertEqual(self.events(pool), [])
        self.assertFalse(pool._lease_checks)
        self.assertIn(A.key, pool.entries)

    async def test_promotion_finishing_after_ttl_reports_expiry_not_failed_check(self):
        async def report(*_):
            self.now += 91
            return {'ok': False, 'reason': 'timeout', 'endpoint': 'trace', 'code': 28}
        pool = self.make(report); pool.accept(proxy(A))
        self.assertIsNone(await pool.take())
        event = self.events(pool)[0]
        self.assertEqual((event['stage'], event['reason']), ('promotion', 'expired'))
        self.assertNotIn('check', event)

    async def test_changed_country_reports_actual_admission_failure(self):
        async def checker(item, *_):
            result = proxy(item); result['country'] = 'SE'
            return result
        for operation in ('refresh', 'take'):
            with self.subTest(operation=operation):
                pool = self.make(checker=checker); pool.accept(proxy(A))
                await getattr(pool, operation)()
                event = self.events(pool)[0]
                self.assertEqual(event['reason'], 'outsideGroup')
                self.assertNotIn('check', event)

    async def test_promotion_failure_preserves_original_error(self):
        async def report(item, *_):
            self.blocked.add(item.key)
            return {'ok': False, 'reason': 'connect', 'endpoint': 'target', 'code': 7}
        pool = self.make(report); pool.accept(proxy(A))
        self.assertIsNone(await pool.take())
        event = self.events(pool)[0]
        self.assertEqual((event['stage'], event['reason']), ('promotion', 'checkFailed'))
        self.assertEqual(event['check'], {'reason': 'connect', 'endpoint': 'target', 'code': 7})

    async def test_legacy_failure_stays_unknown(self):
        async def check(*_):
            return None
        pool = self.make(checker=check); pool.accept(proxy(A))
        await pool.take()
        event = self.events(pool)[0]
        self.assertEqual(event['reason'], 'unknown')
        self.assertNotIn('check', event)

    async def test_prune_classifies_independent_reasons(self):
        for expected in ('expired', 'outsideGroup', 'quarantined', 'sameHost', 'sameExit'):
            with self.subTest(reason=expected):
                pool = self.make(); pool.accept(proxy(A))
                if expected == 'expired': self.now += 91
                elif expected == 'outsideGroup': pool.entries[A.key][0]['country'] = 'SE'
                elif expected == 'quarantined': self.blocked.add(A.key)
                elif expected == 'sameHost': self.active = proxy(A)
                else:
                    self.active = proxy(ACTIVE); self.active['exitIp'] = A.host
                pool.prune()
                self.assertEqual(self.events(pool)[0]['reason'], expected)
                self.assertNotIn('check', self.events(pool)[0])

    async def test_identity_ring_bounds_and_snapshot_copy(self):
        pool = self.make()
        for _ in range(25):
            pool.accept(proxy(A)); self.now += 91; pool.prune()
        snapshot = pool.diagnostic_snapshot(True)
        self.assertTrue(snapshot['removalsLimited'])
        self.assertEqual([e['id'] for e in snapshot['removals']], list(range(6, 26)))
        self.assertEqual(len({e['reserveId'] for e in snapshot['removals']}), 20)
        for event in snapshot['removals']:
            self.assertRegex(event['reserveId'], r'^[0-9a-f]{32}$')
        text = json.dumps(snapshot['removals'])
        self.assertNotIn(A.host, text); self.assertNotIn('http://', text)
        snapshot['removals'][0]['reason'] = 'untrusted'
        self.assertEqual(self.events(pool)[0]['reason'], 'expired')
        self.assertFalse(pool._lease_checks); self.assertFalse(pool._reserve_ids)

    async def test_untrusted_check_fields_are_bounded_and_filtered(self):
        async def report(*_):
            return {'ok': False, 'reason': 'private.example', 'endpoint': 'https://secret/',
                    'code': 99999, 'status': '503\nsecret', 'latencyMs': float('inf'), 'body': 'secret'}
        pool = self.make(report); pool.accept(proxy(A)); await pool.take()
        self.assertEqual(self.events(pool)[0]['check'], {'reason': 'unknown'})
        self.assertNotIn('secret', json.dumps(self.events(pool)))

    async def test_session_production_channel_survives_history_quarantine(self):
        async def source(*_):
            return [], []
        session = Session(('NO', 'EE', 'AT'), lambda _: None, discoverer=source)
        session.pool.accept(proxy(A))
        async def inspect(*_, **_kwargs):
            return {'ok': False, 'reason': 'tls', 'endpoint': 'trace', 'code': 35, 'latencyMs': 8}
        try:
            with patch('core.inspect_proxy', inspect):
                await session.pool.refresh()
            event = self.events(session.pool)[0]
            self.assertFalse(session.history.eligible(A))
            self.assertEqual(event['reason'], 'checkFailed')
            self.assertEqual(event['check']['code'], 35)
        finally:
            await session.check_budget.close()


if __name__ == '__main__':
    unittest.main()
