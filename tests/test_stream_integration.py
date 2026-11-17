"""Streaming across actual Session, pool, and subprocess ownership boundaries."""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, Session, process
from sources import SourceBatch

A = Candidate('http', '8.8.8.8', 8080)
B = Candidate('http', '1.1.1.1', 8081)


def proxy(item):
    return dict(scheme=item.scheme, host=item.host, port=item.port, country='EE',
                exitIp=item.host, checkedAt=1, latencyMs=1)


class Integration(unittest.IsolatedAsyncioTestCase):
    async def test_reserve_populated_while_another_source_never_finishes(self):
        refill = False
        waiting, ready = asyncio.Event(), asyncio.Event()
        closed=[]
        async def source(cc):
            nonlocal refill
            try:
                if not refill:
                    yield SourceBatch('quick','quick',(A,),None,1,True)
                else:
                    waiting.set()
                    yield SourceBatch('quick','quick',(B,),None,1,True)
                await asyncio.Future()
            finally: closed.append(cc)
        async def check(item, cc, slow):
            if item==B: self.assertTrue(waiting.is_set())
            return proxy(item)
        def emit(e):
            nonlocal refill
            if e['phase']=='connected': refill=True
            if e['phase']=='pool' and e['reserveCount']==1: ready.set()
        s=Session('EE',emit,checker=check,source_stream=source,source_groups=('slow','quick'),interval=60)
        task=asyncio.create_task(s.run())
        try:
            await asyncio.wait_for(ready.wait(),2)
            self.assertEqual(closed,['EE'])  # foreground drained, refill producer still awaiting slow input
            self.assertIn(B.key,s.pool.entries)
        finally:
            task.cancel(); await asyncio.gather(task,return_exceptions=True)
        self.assertEqual(closed,['EE','EE']); self.assertFalse(s.search.records); self.assertFalse(s.pool_task)

    async def test_cancellation_while_creating_child_reaps_exact_process(self):
        spawn=asyncio.create_subprocess_exec
        entered,release=asyncio.Event(),asyncio.Event();children=[]
        async def delayed(*args,**kwargs):
            child=await spawn(*args,**kwargs);children.append(child);entered.set()
            await release.wait();return child
        with patch('core.asyncio.create_subprocess_exec',delayed):
            task=asyncio.create_task(process([sys.executable,'-c','import time; time.sleep(60)'],5))
            try:
                await asyncio.wait_for(entered.wait(),3)
                task.cancel();await asyncio.sleep(0);task.cancel();await asyncio.sleep(0)
                self.assertFalse(task.done());release.set()
                with self.assertRaises(asyncio.CancelledError): await asyncio.wait_for(task,2)
                self.assertIsNotNone(children[0].returncode)
            finally:
                release.set()
                if not task.done(): task.cancel()
                await asyncio.gather(task,return_exceptions=True)
                for child in children:
                    if child.returncode is None: child.kill()
                    await child.wait()
