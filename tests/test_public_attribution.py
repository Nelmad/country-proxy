"""No-network ownership/source/identity checks through the real public QA seams."""
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'native'), str(ROOT / 'tests')]
import public_refill_host as public
from public_probe_journal import ProbeAttribution, project_attribution
from sources import SourceBatch


def proxy(item):
    return dict(scheme=item.scheme, host=item.host, port=item.port, country='AT',
                exitIp=item.host, checkedAt=int(time.time()*1000), latencyMs=1)


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0)


class PublicAttributionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.patches = [patch.object(public.core, 'inspect_proxy', self.inspect),
                        patch.object(public.core, 'process', public.core.process),
                        patch.object(public.core.Session, '_budgeted', public.core.Session._budgeted),
                        patch.object(public.host, 'Session', public.host.Session)]
        for item in self.patches:
            item.start();self.addCleanup(item.stop)
        self.release, self.started = asyncio.Event(), asyncio.Event()
        self.cleanup_entered, self.cleanup_release = asyncio.Event(), asyncio.Event()
        self.cleanup_hold = False
        self.hold, self.fail_checks = False, False
        public.monitor(self.directory, 360)

    async def inspect(self, item, *_args, **_kwargs):
        self.started.set()
        if self.hold:
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                if self.cleanup_hold:
                    self.cleanup_entered.set()
                    await self.cleanup_release.wait()
                raise
        return {'ok': False, 'reason': 'connect', 'code': 97} if self.fail_checks else {'ok': True, 'proxy': proxy(item)}

    def session(self, **kwargs):
        async def feed(_):
            return [], []
        session = public.host.Session(['AT','EE','NO'], lambda _event: None,
                                      discoverer=feed, **kwargs)
        self.addAsyncCleanup(session.check_budget.close)
        item=public.core.Candidate('http','192.0.2.1',80)
        session.active, session.offer_attempt = proxy(item), 1
        session.emit({'phase':'connected','proxy':session.active})
        return session

    def records(self):
        return [json.loads(file.read_text()) for file in sorted(self.directory.glob('native-probe-*.json'))]

    async def test_late_coalesced_promotion_preserves_first_owner_and_exact_offer_identity(self):
        session=self.session();self.hold=True
        item=public.core.Candidate('socks4','192.0.2.2',1080)
        session.pool.accept(proxy(item),refill=True)
        original=asyncio.create_task(session.scan_report(item,session.country,True))
        promoted=None
        try:
            await self.started.wait()
            promoted=asyncio.create_task(session.pool.take(on_result=lambda *_a,**_kw:None))
            await until(lambda: session.check_budget._requests[(item.key,True)].owners==2)
            self.release.set()
            report,winner=await asyncio.gather(original,promoted)
            self.assertTrue(report['ok']);self.assertEqual(winner['host'],item.host)
        finally:
            self.release.set()
            for task in (original,promoted):
                if task is not None and not task.done():task.cancel()
            await asyncio.gather(*(task for task in (original,promoted) if task is not None),return_exceptions=True)
        [record]=self.records();a=record['attribution']
        self.assertEqual((a['firstOwner']['role'],a['firstOwner']['purpose']),('foreground','discovery'))
        self.assertEqual(a['laneRole'],'speculative')
        self.assertEqual([row['purpose'] for row in a['logicalCallers']],['discovery','promotion'])
        self.assertTrue(a['coalesced']);self.assertIsNotNone(a['exitId'])
        journal=json.loads((self.directory/'offers-0001.json').read_text())
        self.assertEqual(a['endpointId'],journal['admissions'][0]['endpointId'])
        self.assertNotEqual(a['endpointId'],a['firstOwner']['activeEndpointId'])
        self.assertNotIn(item.host,json.dumps(record));self.assertNotIn('"host":',json.dumps(journal))

    async def test_health_cancellation_keeps_role_offer_identity_and_unknown_observed_exit(self):
        session=self.session();self.hold=True
        item=public.core.Candidate(**{k:session.active[k] for k in ('scheme','host','port')})
        task=asyncio.create_task(session.health(item))
        await self.started.wait();task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        [record]=self.records();a=record['attribution']
        self.assertEqual(record['outcome'],'cancelled')
        self.assertEqual((a['laneRole'],a['firstOwner']['purpose']),('health','health'))
        self.assertEqual(a['endpointId'],a['firstOwner']['activeEndpointId'])
        self.assertIsNone(a['exitId']);self.assertIsNotNone(a['firstOwner']['activeExitId'])
        self.assertIsNone(record['nativeProbe'])
        self.assertIsNone(a['firstOwner']['searchRoundId'])

    async def test_queued_reserve_promotion_has_actual_lane_separate_from_first_requester(self):
        session=self.session();self.hold=True
        await session.check_budget.set_active(True)
        blockers=[asyncio.create_task(session.scan_report(public.core.Candidate('http',f'192.0.2.{n}',80),session.country,True)) for n in range(20,27)]
        pending=promoted=None
        item=public.core.Candidate('http','192.0.2.99',80)
        try:
            await until(lambda:session.check_budget.snapshot['running']==7)
            session.pool.accept(proxy(item),refill=True)
            pending=asyncio.create_task(session.scan_report(item,session.country,True))
            await until(lambda:(item.key,True) in session.check_budget._requests)
            self.assertFalse(session.check_budget._requests[(item.key,True)].started)
            promoted=asyncio.create_task(session.pool.take(on_result=lambda *_a,**_kw:None))
            await until(lambda:session.check_budget._requests[(item.key,True)].started)
            self.release.set();await asyncio.gather(*blockers,pending,promoted)
        finally:
            self.release.set()
            tasks=blockers+[task for task in (pending,promoted) if task is not None]
            for task in tasks:
                if not task.done():task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
        records=self.records();record=next(r for r in records if r['attribution']['laneRole']=='reserve')
        a=record['attribution'];self.assertEqual(a['firstOwner']['role'],'foreground')
        self.assertTrue(a['coalesced']);self.assertEqual(len(a['logicalCallers']),2)
        self.assertEqual({owner['purpose'] for owner in a['logicalCallers']},{'discovery','promotion'})

    async def test_abandoned_cleanup_does_not_attach_new_caller_to_old_physical_check(self):
        session=self.session();self.hold=True;self.cleanup_hold=True
        item=public.core.Candidate('socks4','192.0.2.77',1080)
        first=asyncio.create_task(session.scan_report(item,session.country,True));second=None
        try:
            await self.started.wait();first.cancel();await self.cleanup_entered.wait()
            second=asyncio.create_task(session.scan_report(item,session.country,True))
            await asyncio.sleep(0);await asyncio.sleep(0)
            self.assertEqual((self.directory/'started').read_text(),'1')
            self.cleanup_release.set();self.release.set()
            with self.assertRaises(asyncio.CancelledError):await first
            self.assertTrue((await second)['ok'])
        finally:
            self.cleanup_release.set();self.release.set()
            for task in (first,second):
                if task is not None and not task.done():task.cancel()
            await asyncio.gather(*(task for task in (first,second) if task is not None),return_exceptions=True)
        old,new=self.records()
        self.assertEqual((old['outcome'],new['outcome']),('cancelled','passed'))
        for record in (old,new):
            self.assertFalse(record['attribution']['coalesced'])
            self.assertEqual(len(record['attribution']['logicalCallers']),1)

    async def test_cancelled_queued_creator_keeps_context_while_remaining_owner_runs(self):
        session=self.session();self.hold=True;await session.check_budget.set_active(True)
        blockers=[asyncio.create_task(session.scan_report(public.core.Candidate('http',f'192.0.2.{n}',80),session.country,True)) for n in range(30,37)]
        item=public.core.Candidate('socks4','192.0.2.78',1080)
        first=second=None
        try:
            await until(lambda:session.check_budget.snapshot['running']==7)
            first=asyncio.create_task(session.scan_report(item,session.country,True))
            await until(lambda:(item.key,True) in session.check_budget._requests)
            second=asyncio.create_task(session.scan_report(item,session.country,True))
            await until(lambda:session.check_budget._requests[(item.key,True)].owners==2)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):await first
            self.assertFalse(session.check_budget._requests[(item.key,True)].started)
            self.release.set();await asyncio.gather(*blockers,second)
        finally:
            self.release.set();tasks=blockers+[task for task in (first,second) if task is not None]
            for task in tasks:
                if not task.done():task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
        record=next(row for row in self.records() if row['scheme']=='socks4')
        self.assertTrue(record['attribution']['coalesced'])
        self.assertEqual(len(record['attribution']['logicalCallers']),2)
        self.assertFalse((self.directory/'probe-journal-error').exists())

    async def test_callback_shape_and_instrumentation_failure_do_not_change_product_result(self):
        item=public.core.Candidate('http','192.0.2.111',80)
        async def producer(_cc):
            yield SourceBatch('GeoNode','GeoNode',(item,),None,time.time(),True)
        session=self.session(source_stream=producer,source_groups=('GeoNode',))
        observed=[]
        # Its terminal callback must still run exactly once, despite QA failure.
        with patch.object(ProbeAttribution,'sources',side_effect=RuntimeError('PRIVATE')):
            winner,_=await session.search.run_round(session.scan_report,on_terminal=lambda *args:observed.append(args))
        self.assertEqual(winner['host'],item.host);self.assertEqual(len(observed),1)
        self.assertTrue((self.directory/'probe-journal-error').exists())
        self.assertNotIn('PRIVATE',''.join(file.read_text() for file in self.directory.glob('*.json')))

    async def test_terminal_source_union_counts_unique_endpoints_hosts_and_protocols(self):
        http=public.core.Candidate('http','192.0.2.9',80)
        socks=public.core.Candidate('socks5','192.0.2.9',1080)
        async def producer(_cc):
            yield SourceBatch('GeoNode','GeoNode',(http,socks),None,time.time(),False)
            yield SourceBatch('ProxMint','ProxMint',(http,),None,time.time(),True)
        session=self.session(source_stream=producer,source_groups=('GeoNode','ProxMint'))
        self.fail_checks=True
        returned=[]
        await session.search.run_round(session.scan_report,on_terminal=lambda *args:returned.append(args))
        records=self.records()
        self.assertEqual(len(records),4)  # fast/slow for two protocols, not four unique addresses.
        self.assertEqual(len({r['attribution']['endpointId'] for r in records}),2)
        self.assertEqual(len({r['attribution']['hostId'] for r in records}),1)
        self.assertEqual({r['scheme'] for r in records},{'http','socks5'})
        self.assertEqual(len(returned),2)
        for record in records:
            a=record['attribution'];self.assertEqual(a['sourceMode'],'terminal_group_union')
            groups={row['group'] for row in a['sources']}
            self.assertIn('GeoNode',groups)
            if record['scheme']=='http':self.assertIn('ProxMint',groups)
            self.assertEqual(a['firstOwner']['searchRoundId'],1)
        # Exercise the same strict JS readback used by the actual public report.
        script=('import {readPublicProbes} from '+json.dumps((ROOT/'tests/refill-evidence.mjs').as_uri())+';'
                'const rows=await readPublicProbes(process.argv[1]);process.stdout.write(JSON.stringify(rows.map(x=>x.attribution)));')
        result=subprocess.run(['node','--input-type=module','-e',script,str(self.directory)],
                              capture_output=True,text=True,check=True,timeout=10)
        self.assertEqual(json.loads(result.stdout),[r['attribution'] for r in records])

    async def test_refill_purpose_and_maintenance_binding_use_actual_round_ids(self):
        session=self.session();item=public.core.Candidate('http','192.0.2.8',80)
        # The real refill observer captures its context around a production round.
        session.pool.stream_round=None
        async def feed(_):return [item],[]
        session.pool.discoverer=feed
        await session.pool._refill()
        entry=session.pool.entries[item.key]
        await session.pool._refresh_one(item.key,entry,session.pool._tokens[item.key],session.pool._generation)
        records=self.records();purposes=[r['attribution']['firstOwner']['purpose'] for r in records]
        self.assertEqual(purposes,['refill','maintenance'])
        self.assertEqual(records[0]['attribution']['firstOwner']['refillRoundId'],1)
        self.assertEqual(records[1]['attribution']['firstOwner']['maintenanceId'],1)
        self.assertEqual(records[0]['attribution']['endpointId'],records[1]['attribution']['endpointId'])

    def test_bounds_and_projection_never_copy_foreign_values(self):
        session=self.session();registry=ProbeAttribution(session,1,self.directory)
        for number in range(512):registry.identity(registry.hosts,str(number))
        self.assertIsNone(registry.identity(registry.hosts,'PRIVATE'))
        self.assertTrue(registry.limited);self.assertEqual(len(registry.hosts),512)
        with self.assertRaises(ValueError):project_attribution({'session':True})


if __name__=='__main__':unittest.main()
