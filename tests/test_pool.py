import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, Session
from pool import ReservePool

A = Candidate('http', '8.8.8.8', 3128)
B = Candidate('http', '1.1.1.1', 3128)
C = Candidate('socks5', '9.9.9.9', 1080)
D = Candidate('http', '4.2.2.2', 80)

def result(c, cc='SE', exit_ip=None):
    return dict(scheme=c.scheme, host=c.host, port=c.port, country=cc,
                exitIp=exit_ip or c.host, latencyMs=1, checkedAt=123)

async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.001)

class PoolTests(unittest.IsolatedAsyncioTestCase):
    def make(self, checker=None, candidates=None):
        self.now=10;self.blocked=set();self.events=[];self.calls=[]
        async def check(c, cc, slow):
            self.calls.append(c);return result(c,cc)
        async def discover(cc):return candidates or [B,C,D],[]
        p=ReservePool('SE',discover,checker or check,lambda:result(A),
                      lambda c:c.host not in self.blocked,
                      lambda c,seconds:self.blocked.add(c.host),self.events.append,
                      clock=lambda:self.now,ttl=90,interval=.01,budget=.05)
        return p

    async def test_limit_and_distinct_host_and_exit(self):
        p=self.make(candidates=[A,B,C,D]);await p.refresh()
        self.assertEqual(len(p.entries),2)
        self.assertTrue(all(v[0]['host']!=A.host for v in p.entries.values()))
        p.entries.clear();self.assertTrue(p.accept(result(B)))
        self.assertFalse(p.accept(result(C,exit_ip=B.host)))
        self.assertFalse(p.accept(result(C,exit_ip=A.host)))
        self.assertFalse(p.accept(result(Candidate('socks5',B.host,1080))))

    async def test_fresh_reserve_rechecked_before_use(self):
        p=self.make();p.accept(result(B));self.calls.clear()
        selected=await p.take();self.assertEqual(selected['host'],B.host)
        self.assertEqual(self.calls,[B]);self.assertFalse(p.entries)
        self.assertIn('reserve',[e['phase'] for e in self.events])

    async def test_expired_reserve_cannot_be_promoted(self):
        p=self.make();p.accept(result(B));self.now+=91
        self.assertIsNone(await p.take());self.assertEqual(self.calls,[])
        p.publish();self.assertEqual(self.events[-1]['reserveCount'],0)

    async def test_dead_reserve_skipped_for_next(self):
        async def check(c,*args):return None if c==B else result(c)
        p=self.make(check);p.accept(result(B));p.accept(result(C))
        self.assertEqual((await p.take())['host'],C.host);self.assertIn(B.host,self.blocked)

    async def test_changed_country_or_egress_not_promoted(self):
        for changed in [result(B,'NO'), result(B,exit_ip=A.host)]:
            async def check(*args):return changed
            p=self.make(check);p.accept(result(B))
            self.assertIsNone(await p.take());self.assertIn(B.host,self.blocked)

    async def test_maintenance_removes_failed_reserve(self):
        async def check(*args):return None
        p=self.make(check);p.accept(result(B));await p.refresh()
        self.assertFalse(p.entries);self.assertIn(B.host,self.blocked)

    async def test_round_is_bounded_and_cancels_checks(self):
        live=peak=cancelled=0
        async def check(*args):
            nonlocal live,peak,cancelled
            live+=1;peak=max(peak,live)
            try:await asyncio.sleep(60)
            finally:live-=1;cancelled+=1
        p=self.make(check,candidates=[B,C,D,Candidate('http','8.8.4.4',80)])
        await asyncio.wait_for(p.refresh(),.2)
        self.assertEqual(live,0);self.assertLessEqual(peak,3);self.assertEqual(cancelled,3)

    async def test_source_failure_does_not_stop_maintenance(self):
        p=self.make()
        async def broken(cc):raise RuntimeError('offline')
        p.discoverer=broken;task=asyncio.create_task(p.run())
        try:
            await until(lambda:len(self.events)>=4)
            self.assertFalse(task.done());self.assertEqual(self.events[-1]['reserveCount'],0)
        finally:task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_recheck_refreshes_ttl_and_exclusion_prunes(self):
        p=self.make(candidates=[B]);p.accept(result(B));self.now+=80
        await p.refresh();self.now+=20;p.prune();self.assertEqual(len(p.entries),1)
        self.blocked.add(B.host);p.publish();self.assertFalse(p.entries)

class SessionPoolTests(unittest.IsolatedAsyncioTestCase):
    async def test_promotes_ready_reserve_without_new_discovery(self):
        events=[];discovery=0;at_connected=[]
        async def discover(cc):
            nonlocal discovery
            discovery+=1;return [A,B,C],[]
        async def check(c,cc,slow):
            if c!=A:await asyncio.sleep(.002)
            return result(c,cc)
        def emit(e):
            events.append(e)
            if e['phase']=='connected':at_connected.append(discovery)
        s=Session('SE',emit,discover,check,interval=60);task=asyncio.create_task(s.run())
        try:
            await until(lambda:len(s.pool.entries)==2);before=discovery;s.nudge(True)
            await until(lambda:s.active is not None and s.active['host']!=A.host)
            self.assertEqual(at_connected[-1],before)
            self.assertIn('reserve',[e['phase'] for e in events]);self.assertFalse(s.eligible(A))
            self.assertFalse(s.eligible(Candidate('socks5',A.host,9999)))
        finally:task.cancel();await asyncio.gather(task,return_exceptions=True)
        self.assertIsNone(s.pool_task);self.assertFalse(s.pool.entries)

    async def test_browser_rotate_wins_over_inflight_healthy_result(self):
        entered=asyncio.Event();release=asyncio.Event();calls=0
        async def discover(cc):return [A,B],[]
        async def check(c,cc,slow):
            nonlocal calls
            if c==A:
                calls+=1
                if calls>1:entered.set();await release.wait()
            else:await asyncio.sleep(.001)
            return result(c,cc)
        s=Session('SE',lambda e:None,discover,check,interval=60);task=asyncio.create_task(s.run())
        try:
            await until(lambda:len(s.pool.entries)==1);s.nudge();await asyncio.wait_for(entered.wait(),1)
            s.nudge(True);release.set();await until(lambda:s.active and s.active['host']==B.host)
            self.assertFalse(s.eligible(A))
        finally:release.set();task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_stop_cancels_background_probe(self):
        entered=asyncio.Event();cancelled=asyncio.Event()
        async def discover(cc):return [A,B],[]
        async def check(c,cc,slow):
            if c==A:return result(c,cc)
            entered.set()
            try:await asyncio.sleep(60)
            finally:cancelled.set()
        s=Session('NO',lambda e:None,discover,check,interval=60);task=asyncio.create_task(s.run())
        await asyncio.wait_for(entered.wait(),1);task.cancel();await asyncio.gather(task,return_exceptions=True)
        self.assertTrue(cancelled.is_set());self.assertIsNone(s.pool_task);self.assertFalse(s.pool.entries)
