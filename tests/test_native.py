import asyncio
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'native'))
from core import COUNTRIES, Candidate, Session, check, country_code, inspect_proxy, parse_candidates, process, scan
from host import encode, receive

A = Candidate('http', '8.8.8.8', 3128)
B = Candidate('socks5', '1.1.1.1', 1080)
def result(c=A, cc='SE'):
    return {'scheme':c.scheme, 'host':c.host, 'port':c.port, 'country':cc, 'exitIp':c.host,
            'latencyMs':1, 'checkedAt':123}

class Parsing(unittest.TestCase):
    def test_configurable_countries(self):
        for cc in sorted(COUNTRIES):
            with self.subTest(country=cc):
                self.assertEqual(country_code(cc), cc)
                self.assertEqual(country_code(cc.lower()), cc)
        for cc in ['XX', 'ZZ', '', '../../AT', 'NO,EE', None]:
            with self.assertRaises(ValueError): country_code(cc)
    def test_untrusted_list(self):
        bad='224.0.0.1:80\n127.0.0.1:80\n10.0.0.1:80\n169.254.169.254:80\n8.8.8.8:65536\nhttp://user@8.8.8.8:80\n8.8.8.8:0\n8.8.8.8:80/evil\n'
        self.assertEqual(parse_candidates(bad),[])
        good=parse_candidates('8.8.8.8:3128\nhttp://8.8.8.8:3128\nsocks5://1.1.1.1:1080')
        self.assertEqual(len(good),4)
        self.assertEqual(good[-1].url,'socks5h://1.1.1.1:1080')

class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_frame_unicode_and_bounds(self):
        message={'country':'NO','text':'Проверка'}
        reader=asyncio.StreamReader();reader.feed_data(encode(message));reader.feed_eof()
        self.assertEqual(await receive(reader),message)
        reader=asyncio.StreamReader();reader.feed_data(struct.pack('=I',65537))
        with self.assertRaises(ValueError): await receive(reader)
    async def test_country_and_https_required(self):
        async def fake(url,*args):
            return (0,'200','ip=8.8.8.8\nloc=SE') if 'trace' in url else (0,'204','')
        with patch('core.curl',fake):
            self.assertIsNotNone(await check(A,'SE'))
            self.assertIsNone(await check(A,'NO'))
    async def test_definitive_failure_cancels_and_drains_the_other_https_request(self):
        # The sibling cannot complete on its own. Only cancellation can release its checker slot.
        for terminal, answer, expected in [
            ('target', (7, '000', ''), 'connect'),
            ('trace', (0, '200', 'loc=PL\nip=8.8.4.4'), 'country'),
        ]:
            with self.subTest(terminal=terminal):
                started = asyncio.Event()
                drained = asyncio.Event()

                async def fetch(url, *_):
                    endpoint = 'trace' if '/trace' in url else 'target'
                    if endpoint == terminal:
                        await started.wait()
                        return answer
                    started.set()
                    try:
                        await asyncio.Future()
                    finally:
                        await asyncio.sleep(0)
                        drained.set()

                with patch('core.curl', fetch):
                    async with asyncio.timeout(0.5):
                        report = await inspect_proxy(A, ['AT', 'EE', 'NO'], slow=True)
                self.assertEqual((report['reason'], report['endpoint']), (expected, terminal))
                self.assertTrue(drained.is_set())

    async def test_slow_retry_for_arbitrary_country(self):
        calls=[]
        async def fake(c,cc,slow):
            calls.append((cc,slow));return result(c,cc) if slow else None
        found=await scan([A],'SE',lambda *x:None,checker=fake)
        self.assertEqual(found['country'],'SE');self.assertEqual(calls,[('SE',False),('SE',True)])
    async def test_scan_cancels_other_probes(self):
        cancelled=asyncio.Event()
        async def fake(c,*args):
            if c == A:
                await asyncio.sleep(.02); return result()
            try: await asyncio.sleep(60)
            finally: cancelled.set()
        self.assertIsNotNone(await scan([A,B],'SE',lambda *x:None,checker=fake))
        self.assertTrue(cancelled.is_set())
    async def test_active_failover(self):
        events=[];calls=0
        async def discoverer(cc): return [A,B],[]
        async def checker(c,cc,slow):
            nonlocal calls
            if c == A:
                calls+=1
                return result(c,cc) if calls==1 else None
            await asyncio.sleep(.005)
            return result(c,cc)
        session=Session('SE',events.append,discoverer,checker,interval=.01,retry=.01)
        task=asyncio.create_task(session.run())
        try:
            for _ in range(100):
                if any(e.get('proxy',{}).get('host')==B.host for e in events if e.get('proxy')): break
                await asyncio.sleep(.01)
            self.assertIn('confirming',[e['phase'] for e in events])
            self.assertIn('replacing',[e['phase'] for e in events])
            self.assertEqual(session.active['host'],B.host)
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True)
    async def test_no_candidates_never_connected(self):
        events=[]
        async def empty(cc): return [],['source unavailable']
        s=Session('NO',events.append,empty,interval=.01,retry=.01)
        task=asyncio.create_task(s.run());await asyncio.sleep(.025);task.cancel()
        await asyncio.gather(task,return_exceptions=True)
        self.assertIn('empty',[e['phase'] for e in events]);self.assertNotIn('connected',[e['phase'] for e in events])
    async def test_process_cancel_stops_child(self):
        launched=asyncio.Event()
        child=None
        launch_task=None
        create_subprocess=asyncio.create_subprocess_exec
        async def capture_child(*args,**kwargs):
            nonlocal child,launch_task
            launch_task=asyncio.create_task(create_subprocess(*args,**kwargs))
            child=await asyncio.shield(launch_task)
            launched.set()
            return child
        with patch('core.asyncio.create_subprocess_exec',capture_child):
            task=asyncio.create_task(process([sys.executable,'-c','import time;time.sleep(60)'],65))
            try:
                await asyncio.wait_for(launched.wait(),5)
                self.assertIsNone(child.returncode)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(asyncio.shield(task),2)
                # Check before test cleanup can kill or reap a leaked child.
                self.assertIsNotNone(child.returncode)
                await asyncio.wait_for(child.wait(),2)
            finally:
                # Recover even a child whose launch outlasted the launch timeout.
                if launch_task is not None:
                    child=await launch_task
                if child is not None:
                    if child.returncode is None:
                        child.kill()
                    await child.wait()
                if not task.done():
                    task.cancel()
                await asyncio.wait_for(asyncio.gather(task,return_exceptions=True),2)

if __name__=='__main__': unittest.main()
