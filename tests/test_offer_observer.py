"""Regressions for attribution in the public acceptance helper. No network access."""
import asyncio
import json
from pathlib import Path
import sys
import time
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
sys.path.insert(0, str(ROOT / 'tests'))
from core import Candidate, Session
from offer_observer import OfferJournal, SessionObserver, ORIGIN_LIMIT


def proxy(item):
    return dict(scheme=item.scheme, host=item.host, port=item.port, country='AT',
                exitIp=item.host, latencyMs=10, checkedAt=123456)


def address(item):
    return dict(scheme=item.scheme, host=item.host, port=item.port)


class ObserverTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def read(self, serial=1):
        return json.loads((self.directory / f'offers-{serial:04d}.json').read_bytes())

    async def test_native_probe_belongs_to_exact_returned_reserve_report(self):
        a,b = Candidate('http','192.0.2.61',80),Candidate('http','198.51.100.62',80)
        session = Session(['AT','EE','NO'],lambda event:None)
        def proof(item):
            return {'version':1,'_startedNs':time.monotonic_ns(),'startedAtMs':100,
                    'elapsedMs':40,'limited':False,'host':'PRIVATE','controls':[{
                        'endpoint':'trace' if item==a else 'target','ordinal':2 if item==a else 1,
                        'startMs':1,'endMs':30,'outcome':'completed' if item==a else 'failed',
                        'curlCode':0 if item==a else 28,'httpStatus':200 if item==a else 0,
                        'connectStatus':200,'timingMs':None,'body':'PRIVATE'}]}
        async def raw(item,*args):
            record=proof(item)
            if item==a:await asyncio.sleep(.01)
            return {**({'ok':True,'proxy':proxy(item)} if item==a else {'ok':False,'reason':'timeout'}),
                    '_qaProbe':record}
        session._raw_report=raw
        OfferJournal(self.directory).attach(session)
        for item in (a,b):self.assertTrue(session.pool.accept(proxy(item)))
        self.assertIsNotNone(await session.pool.take())
        rows=self.read()['takes'][0]['rechecks']
        self.assertEqual(len(rows),2)
        by_outcome={row['outcome']:row['nativeProbe'] for row in rows}
        self.assertEqual(by_outcome['passed']['controls'][0]['ordinal'],2)
        self.assertEqual(by_outcome['failed']['controls'][0]['endpoint'],'target')
        self.assertEqual(by_outcome['failed']['controls'][0]['curlCode'],28)
        self.assertFalse(by_outcome['passed']['joinedEarlier'])
        text=json.dumps(self.read())
        for private in ('PRIVATE',a.host,b.host,'_startedNs'):self.assertNotIn(private,text)
        await session.check_budget.close()

    async def test_shared_earlier_physical_probe_has_no_invented_queue_wait(self):
        item=Candidate('http','192.0.2.63',80)
        session=Session('AT',lambda event:None)
        started,release=asyncio.Event(),asyncio.Event()
        async def raw(*args):
            record={'version':1,'_startedNs':time.monotonic_ns(),'startedAtMs':100,
                    'elapsedMs':40,'limited':False,'controls':[]}
            started.set();await release.wait()
            return {'ok':True,'proxy':proxy(item),'_qaProbe':record}
        session._raw_report=raw
        OfferJournal(self.directory).attach(session)
        earlier=asyncio.create_task(session._budgeted(item,'AT',True,'reserve'))
        await started.wait();await asyncio.sleep(.001)
        self.assertTrue(session.pool.accept(proxy(item)))
        promoted=asyncio.create_task(session.pool.take())
        await asyncio.sleep(.001);release.set()
        await asyncio.gather(earlier,promoted)
        [row]=self.read()['takes'][0]['rechecks']
        self.assertTrue(row['nativeProbe']['joinedEarlier'])
        self.assertIsNone(row['nativeProbe']['queueWaitMs'])
        await session.check_budget.close()

    async def test_cancelled_reserve_does_not_acquire_an_unreturned_probe(self):
        item=Candidate('http','192.0.2.64',80)
        session=Session('AT',lambda event:None)
        started=asyncio.Event()
        async def raw(*args):
            started.set();await asyncio.Future()
        session._raw_report=raw
        OfferJournal(self.directory).attach(session)
        self.assertTrue(session.pool.accept(proxy(item)))
        task=asyncio.create_task(session.pool.take())
        await started.wait();task.cancel();await asyncio.gather(task,return_exceptions=True)
        [row]=self.read()['takes'][0]['rechecks']
        self.assertEqual(row['outcome'],'cancelled')
        self.assertNotIn('nativeProbe',row)
        await session.check_budget.close()

    def test_origin_bound_retains_full_round_and_does_not_grow_unbounded(self):
        observer = SessionObserver(self.directory, 1)
        proxies = [proxy(Candidate('http', '192.0.2.1', port)) for port in range(1, ORIGIN_LIMIT+3)]
        for value in proxies:
            observer.remember_origin(value, 'discovery')
        self.assertEqual(len(observer.origins), ORIGIN_LIMIT)
        self.assertNotIn(id(proxies[0]), observer.origins)
        self.assertEqual(observer.origins[id(proxies[-1])], (proxies[-1], 'discovery', None))
        self.assertTrue(all(id(value) in observer.origins for value in proxies[-122:]))

    async def test_pool_rejection_keeps_exact_origin_and_stale_feedback_is_ignored(self):
        a, b = Candidate('http','192.0.2.1',80), Candidate('http','198.51.100.2',8080)
        events = asyncio.Queue()
        async def feed(_):
            return [a], []
        async def check(item, *args):
            return proxy(item)
        def emit(event):
            if event['phase'] == 'connected':
                events.put_nowait(event)
        session = Session(['AT','NO','EE'], emit, feed, check, interval=60)
        session.wait_for_browser = True
        OfferJournal(self.directory).attach(session)
        task = asyncio.create_task(session.run())
        try:
            first = await asyncio.wait_for(events.get(), 2)
            self.assertEqual(self.read()['offers'][0]['feedback'], 'pending')
            self.assertTrue(session.pool.accept(proxy(b), at=session.pool.clock()-3.0))
            session.qa_injected_health_fault(first['attempt'])
            self.assertTrue(session.browser_feedback('reject', first['attempt'], address(a), 'transport'))
            second = await asyncio.wait_for(events.get(), 2)
            self.assertFalse(session.browser_feedback('confirm', first['attempt'], address(a)))
            self.assertTrue(session.browser_feedback('confirm', second['attempt'], address(b)))
            self.assertTrue(session.browser_feedback('reject', second['attempt'], address(b), 'timeout'))
            data = self.read()
            self.assertEqual(data['offers'][1]['recheckRejection']['reason'], 'timeout')
            self.assertEqual(data['offers'][1]['recheckRejection']['checkedAt'],123456)
            self.assertIsNone(data['offers'][0]['recheckRejection'])
            self.assertEqual([(r['origin'],r['feedback'],r['injectedHealthFailures']) for r in data['offers']],
                             [('discovery','reject',1),('pool','confirm',0)])
            self.assertEqual(data['offers'][0]['reason'], 'transport')
            self.assertGreaterEqual(data['offers'][1]['reserveLeaseAgeMs'], 3000)
            self.assertEqual([r['checkedAt'] for r in data['offers']], [123456,123456])
            self.assertEqual(data['takes'][0]['rechecks'], [{'outcome':'passed','reason':None}])
            self.assertEqual(data['takes'][0]['result'], 'selected')
            for item in (a, b):
                self.assertNotIn(item.host, json.dumps(data))
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_failed_promotion_and_restart_have_independent_receipts(self):
        item = Candidate('http','192.0.2.2',8080)
        async def feed(_):
            return [], []
        async def check(*args):
            return None
        journal = OfferJournal(self.directory)
        first = journal.attach(Session('AT', lambda event: None, feed, check))
        self.assertTrue(first.pool.accept(proxy(item)))
        self.assertIsNone(await first.pool.take())
        second = OfferJournal(self.directory).attach(Session('AT', lambda event: None, feed, check))
        self.assertIsNotNone(second)
        data = self.read()
        self.assertEqual(data['session'],1)
        self.assertEqual(data['takes'][0]['result'],'noEligible')
        self.assertEqual(data['takes'][0]['rechecks'],[{'outcome':'failed','reason':'unavailable'}])
        self.assertEqual(self.read(2),dict(session=2, version=1, truncated=False, takes=[], offers=[], removals=[]))

    async def test_maintenance_reports_only_removed_leases_with_addressed_cause(self):
        item = Candidate('http','192.0.2.2',8080)
        outcomes = iter((proxy(item),None))
        async def feed(_):
            return [], []
        async def check(*args):
            return next(outcomes)
        session = OfferJournal(self.directory).attach(Session('AT', lambda event: None, feed, check))
        self.assertTrue(session.pool.accept(proxy(item)))
        await session.pool._start_refresh(item.key)
        self.assertEqual(self.read()['removals'],[])
        await session.pool._start_refresh(item.key)
        self.assertFalse(session.pool.entries)
        [drop] = self.read()['removals']
        self.assertEqual((drop['stage'],drop['reason']),('maintenance','checkFailed'))
        self.assertEqual(drop['check']['reason'], 'unavailable')
        await session.pool.take()
        self.assertEqual(self.read()['takes'],[])

    async def test_removals_are_copied_once_from_authoritative_snapshot(self):
        session = OfferJournal(self.directory).attach(Session('AT', lambda event: None))
        removal = {'id': 1, 'reserveId': 'a' * 32, 'atMs': 123456, 'ageMs': 4123,
                   'stage': 'maintenance', 'reason': 'checkFailed',
                   'check': {'reason': 'timeout', 'endpoint': 'trace', 'code': 28,
                             'latencyMs': 12001}}
        session.pool.diagnostic_snapshot = lambda _active: {'removals': [removal]}
        for _ in range(2):
            session.output({'phase': 'pool'})
        self.assertEqual(self.read()['removals'], [removal])
        self.assertFalse(self.read()['truncated'])
        removal['check']['code'] = 7
        self.assertEqual(self.read()['removals'][0]['check']['code'], 28)

    async def test_unknown_removal_is_not_assigned_an_unrelated_report(self):
        session = Session('AT', lambda event: None)
        async def unrelated(*args):
            return {'ok': False, 'reason': 'tls', 'endpoint': 'target', 'code': 35}
        session._budgeted = unrelated
        OfferJournal(self.directory).attach(session)
        await session._budgeted(Candidate('http', '192.0.2.88', 8080), 'AT', True, 'reserve')
        removal = {'id': 1, 'reserveId': 'b' * 32, 'atMs': 123456, 'ageMs': 70,
                   'stage': 'prune', 'reason': 'unknown'}
        session.pool.diagnostic_snapshot = lambda _active: {'removals': [removal]}
        session.output({'phase': 'pool'})
        self.assertEqual(self.read()['removals'], [removal])

    async def test_concurrent_refreshes_keep_each_leases_exact_check(self):
        a, b = Candidate('http', '192.0.2.11', 80), Candidate('http', '198.51.100.12', 80)
        started, release = asyncio.Event(), asyncio.Event()
        session = Session(['AT', 'EE', 'NO'], lambda event: None)
        reports = {a.key: {'ok': False, 'reason': 'timeout', 'endpoint': 'trace',
                           'code': 28, 'latencyMs': 12001},
                   b.key: {'ok': False, 'reason': 'http', 'endpoint': 'target',
                           'status': '503', 'latencyMs': 123}}
        async def raw(item, *args):
            if item == a:
                started.set()
                await release.wait()
            return dict(reports[item.key])
        session._raw_report = raw
        OfferJournal(self.directory).attach(session)
        for item in (a, b):
            self.assertTrue(session.pool.accept(proxy(item)))
        reserve_ids = dict(session.pool._reserve_ids)
        first = session.pool._start_refresh(a.key)
        try:
            await asyncio.wait_for(started.wait(), 1)
            await asyncio.wait_for(session.pool._start_refresh(b.key), 1)
            release.set()
            await asyncio.wait_for(first, 1)
        finally:
            release.set()
            await asyncio.gather(first, return_exceptions=True)
        records = self.read()['removals']
        self.assertEqual(len(records), 2)
        self.assertEqual([r['reserveId'] for r in records], [reserve_ids[b.key], reserve_ids[a.key]])
        for row, item in zip(records, (b, a)):
            self.assertEqual(row['stage'], 'maintenance')
            self.assertEqual(row['reason'], 'checkFailed')
            expected = {key: value for key, value in reports[item.key].items() if key != 'ok'}
            if 'status' in expected:
                expected['status'] = int(expected['status'])
            self.assertEqual(row['check'], expected)
        for item in (a, b):
            self.assertNotIn(item.host, json.dumps(records))

    async def test_removal_snapshot_gap_is_reported_as_incomplete(self):
        session = OfferJournal(self.directory).attach(Session('AT', lambda event: None))
        session.pool.diagnostic_snapshot = lambda _active: {'removals': [
            {'id': 3, 'reserveId': 'c' * 32, 'atMs': 123456, 'ageMs': 0,
             'stage': 'prune', 'reason': 'expired'}]}
        session.output({'phase': 'pool'})
        self.assertTrue(self.read()['truncated'])
        self.assertEqual([r['id'] for r in self.read()['removals']], [3])

    async def test_quarantine_before_refresh_callback_keeps_production_failure(self):
        item = Candidate('http', '192.0.2.13', 80)
        session = Session(['AT', 'EE', 'NO'], lambda event: None)
        async def report(*args):
            session.exclude(item, 60)
            return {'ok': False, 'reason': 'connect', 'endpoint': 'target', 'code': 7}
        session._raw_report = report
        OfferJournal(self.directory).attach(session)
        self.assertTrue(session.pool.accept(proxy(item)))
        await session.pool._start_refresh(item.key)
        [drop] = self.read()['removals']
        self.assertEqual((drop['stage'], drop['reason']), ('maintenance', 'checkFailed'))
        self.assertEqual(drop['check'], {'reason': 'connect', 'endpoint': 'target', 'code': 7})
        self.assertEqual(self.read()['removals'], session.pool.diagnostic_snapshot(False)['removals'])

    async def test_snapshot_projection_drops_unexpected_identifying_fields(self):
        session = OfferJournal(self.directory).attach(Session('AT', lambda event: None))
        private = 'https://192.0.2.14/private'
        session.pool.diagnostic_snapshot = lambda _active: {'removals': [
            {'id': 1, 'reserveId': 'd' * 32, 'atMs': 123456, 'ageMs': 0,
             'stage': 'prune', 'reason': 'unknown', 'host': private,
             'check': {'reason': private, 'url': private, 'endpoint': private}}]}
        session.output({'phase': 'pool'})
        data = self.read()
        self.assertNotIn(private, json.dumps(data))
        self.assertEqual(data['removals'][0]['check'], {'reason': 'unknown'})

    async def test_equal_proxy_copy_cannot_establish_provenance(self):
        item = Candidate('http','192.0.2.3',8080)
        session = Session('AT',lambda event:None)
        session.search.run_round = lambda: asyncio.sleep(0, result=(proxy(item), []))
        OfferJournal(self.directory).attach(session)
        candidate, _ = await session.search.run_round()
        session.output({'phase':'connected','attempt':1,'proxy':dict(candidate)})
        self.assertEqual(self.read()['offers'][0]['origin'],'unknown')

    async def test_parallel_branch_provenance_is_bound_to_returned_object(self):
        a = Candidate('http', '192.0.2.41', 8080)
        b = Candidate('http', '198.51.100.42', 8080)
        session = Session(['AT', 'NO', 'EE'], lambda event: None)
        reserve, discovered = proxy(a), proxy(b)
        session.pool.take = lambda: asyncio.sleep(0, result=reserve)
        session.search.run_round = lambda: asyncio.sleep(0, result=(discovered, []))
        self.assertTrue(session.pool.accept(reserve, at=session.pool.clock()-4))
        OfferJournal(self.directory).attach(session)
        # Both branches finish in child tasks. ContextVar writes in those tasks
        # never reach Session.run, and last completion need not be the winner.
        taken, found = await asyncio.gather(session.pool.take(), session.search.run_round())
        session.output({'phase': 'connected', 'attempt': 1, 'proxy': taken})
        row = self.read()['offers'][0]
        self.assertEqual(row['origin'], 'pool')
        self.assertGreaterEqual(row['reserveLeaseAgeMs'], 4000)
        # An unoffered runner-up is not provenance for a later unrelated offer.
        session.output({'phase': 'connected', 'attempt': 2, 'proxy': found[0]})
        self.assertEqual(self.read()['offers'][1]['origin'], 'unknown')
        data = json.dumps(self.read())
        self.assertNotIn(a.host, data)
        self.assertNotIn(b.host, data)

    async def test_parallel_discovery_winner_survives_later_pool_completion(self):
        a = Candidate('http', '192.0.2.43', 8080)
        b = Candidate('http', '198.51.100.44', 8080)
        session = Session(['AT', 'NO', 'EE'], lambda event: None)
        session.search.run_round = lambda: asyncio.sleep(0, result=(proxy(a), []))
        session.pool.take = lambda: asyncio.sleep(0.01, result=proxy(b))
        OfferJournal(self.directory).attach(session)
        found, _ = await asyncio.gather(session.search.run_round(), session.pool.take())
        session.output({'phase': 'connected', 'attempt': 1, 'proxy': found[0]})
        self.assertEqual(self.read()['offers'][0]['origin'], 'discovery')

    async def test_completed_success_keeps_origin_when_branch_cleanup_is_cancelled(self):
        item = Candidate('http', '192.0.2.45', 8080)
        for origin in ('pool', 'discovery'):
            with self.subTest(origin=origin):
                session = Session(['AT', 'NO', 'EE'], lambda event: None)
                completed = asyncio.Event()
                result = proxy(item)
                async def take(*, on_result):
                    on_result(result, session.pool.clock())
                    completed.set()
                    await asyncio.Future()
                async def search(*, on_terminal):
                    on_terminal(item, {}, {'ok': True, 'proxy': result})
                    completed.set()
                    await asyncio.Future()
                session.pool.take, session.search.run_round = take, search
                OfferJournal(self.directory).attach(session)
                coro = (session.pool.take(on_result=lambda *_: None) if origin == 'pool' else
                        session.search.run_round(on_terminal=lambda *_: None))
                task = asyncio.create_task(coro)
                await asyncio.wait_for(completed.wait(), 1)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                session.output({'phase': 'connected', 'attempt': 1, 'proxy': result})
                self.assertEqual(self.read(1 if origin == 'pool' else 2)['offers'][0]['origin'], origin)

    async def test_truncation_never_overwrites_earlier_receipt(self):
        with patch('offer_observer.SESSION_LIMIT', 1), patch('offer_observer.LIMIT', 1):
            first = OfferJournal(self.directory).attach(Session('AT',lambda event:None))
            for index in (1,2):
                first.output({'phase':'connected','attempt':index,'proxy':{}})
            before = self.read()
            self.assertTrue(before['truncated'])
            self.assertEqual(len(before['offers']),1)
            excess = OfferJournal(self.directory).attach(Session('AT',lambda event:None))
            excess.qa_injected_health_fault(1)
            self.assertTrue((self.directory/'offers-overflow').is_file())
            self.assertEqual(self.read(),before)
