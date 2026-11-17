"""Exercise the report through discovery, the native offer and browser feedback."""
import asyncio
from collections import Counter
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, Session
from sources import SourceBatch

LIVE = Candidate('http', '8.8.8.8', 8080)
PENDING = Candidate('http', '1.1.1.1', 8081)


class SessionReport(unittest.IsolatedAsyncioTestCase):
    async def test_mirrors_two_countries_cancelled_sibling_and_exact_browser_confirm(self):
        ready, connected = asyncio.Event(), asyncio.Event()
        completed = set()
        checks = Counter()

        async def sources(cc):
            for group, name in [('A','one'), ('A','mirror'), ('B','two')]:
                yield SourceBatch(group, name, (LIVE, PENDING), None, 1000, name != 'one')
            completed.add(cc)
            if len(completed) == 2:
                ready.set()

        async def checker(item, _, slow):
            checks[item] += 1
            if item == PENDING:
                await asyncio.Future()
            await ready.wait()
            return dict(scheme=item.scheme, host=item.host, port=item.port,
                        country='EE', exitIp=item.host, latencyMs=1)

        session = Session(['NO','EE'], lambda e: connected.set() if e['phase']=='connected' else None,
                          checker=checker, source_stream=sources, source_groups=('A','B'), interval=100)
        session.wait_for_browser = True
        task = asyncio.create_task(session.run())
        try:
            await asyncio.wait_for(connected.wait(), 2)
            before = session.source_report('NO')
            self.assertEqual(before['assessedNative'], 1)
            self.assertEqual(before['nativeWorking'], 1)
            self.assertEqual([g['nativeQualifiedShare'] for g in before['groups']], [.25,.25])
            self.assertEqual([g['browserConfirmedShare'] for g in before['groups']], [0,0])
            address = {k: session.active[k] for k in ('scheme','host','port')}
            self.assertFalse(session.browser_feedback('confirm',session.offer_attempt+1,address))
            for _ in range(2):
                self.assertTrue(session.browser_feedback('confirm',session.offer_attempt,address))
            for cc in ('NO','EE'):
                report = session.source_report(cc)
                self.assertEqual([g['browserConfirmedShare'] for g in report['groups']], [.25,.25])
            self.assertEqual(checks, {LIVE:1,PENDING:1})
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
