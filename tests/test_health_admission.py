"""Active health reports retain current failure evidence, separate from counters."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import core


class HealthAdmission(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, country, failure, repeat_failure=False):
        events = asyncio.Queue()
        mode = None
        item = core.Candidate('http', '8.8.8.8', 3128)
        async def discover(_):
            return [item], []
        async def curl(url, candidate, slow=False):
            if mode == 'timeout':
                return 28, '', ''
            if url == core.TRACE:
                return 0, '200', f'loc={"JP" if mode == "country" else country}\nip=9.9.9.9'
            return 0, '204', ''
        def emit(event):
            if event['phase'] in ('connected', 'confirming', 'replacing'):
                events.put_nowait(event)
        with patch.object(core, 'curl', curl):
            session = core.Session(['AT', 'EE', 'NO'], emit, discoverer=discover, interval=60)
            session.wait_for_browser = True
            owner = asyncio.create_task(session.run())
            try:
                first = await asyncio.wait_for(events.get(), 2)
                address = {k: first['proxy'][k] for k in ('scheme', 'host', 'port')}
                self.assertTrue(session.browser_feedback('confirm', first['attempt'], address))
                mode = failure
                session.nudge()
                negative = await asyncio.wait_for(events.get(), 2)
                self.assertEqual(negative['phase'], 'confirming')
                self.assertEqual(negative['attempt'], first['attempt'])
                self.assertEqual(negative['proxy'], first['proxy'])
                self.assertEqual(negative['health']['ok'], False)
                self.assertEqual(negative['health']['reason'], failure)
                if failure == 'country':
                    self.assertEqual(negative['health']['country'], 'JP')
                    self.assertEqual(negative['health']['endpoint'], 'trace')
                if repeat_failure:
                    session.nudge()
                    withdrawn = await asyncio.wait_for(events.get(), 2)
                    self.assertEqual(withdrawn['phase'], 'replacing')
                    self.assertEqual(withdrawn['attempt'], first['attempt'])
                    self.assertEqual(withdrawn['health']['reason'], failure)
                    return
                # One transient failure keeps the offer; the next success is
                # evidence for this same attempt, not a historical counter delta.
                mode = None
                session.nudge()
                recovered = await asyncio.wait_for(events.get(), 2)
                self.assertEqual(recovered['attempt'], first['attempt'])
                self.assertEqual(recovered['health'], {'ok': True})
                self.assertTrue(session.eligible(item))
            finally:
                owner.cancel()
                await asyncio.gather(owner, return_exceptions=True)

    async def test_country_failure_for_each_equal_allowed_exit(self):
        for country in ('AT', 'EE', 'NO'):
            with self.subTest(country=country):
                await self.exercise(country, 'country')

    async def test_transient_transport_failure_keeps_offer(self):
        await self.exercise('NO', 'timeout')

    async def test_two_transport_failures_still_replace_offer(self):
        await self.exercise('NO', 'timeout', repeat_failure=True)

    async def test_country_negative_after_timeout_is_withdrawn_before_pool_cleanup(self):
        events = asyncio.Queue()
        cleanup_entered, cleanup_release = asyncio.Event(), asyncio.Event()
        item = core.Candidate('http', '8.8.8.8', 3128)
        mode = None
        async def discover(_):
            return [item], []
        async def curl(url, candidate, slow=False):
            if mode == 'timeout':
                return 28, '', ''
            if url == core.TRACE:
                return 0, '200', f'loc={"JP" if mode == "country" else "NO"}\nip=9.9.9.9'
            return 0, '204', ''
        def emit(event):
            if event['phase'] in ('connected', 'confirming', 'replacing'):
                events.put_nowait(event)
        with patch.object(core, 'curl', curl):
            session = core.Session(['AT', 'EE', 'NO'], emit, discoverer=discover, interval=60)
            session.wait_for_browser = True
            stop_pool = session.stop_pool
            async def held_stop_pool():
                cleanup_entered.set()
                await cleanup_release.wait()
                await stop_pool()
            session.stop_pool = held_stop_pool
            owner = asyncio.create_task(session.run())
            try:
                first = await asyncio.wait_for(events.get(), 2)
                address = {key: first['proxy'][key] for key in ('scheme', 'host', 'port')}
                self.assertTrue(session.browser_feedback('confirm', first['attempt'], address))
                mode = 'timeout'; session.nudge()
                warning = await asyncio.wait_for(events.get(), 2)
                self.assertEqual(warning['health']['reason'], 'timeout')
                mode = 'country'; session.nudge()
                await asyncio.wait_for(cleanup_entered.wait(), 2)
                self.assertFalse(events.empty(), 'withdrawal must precede waiting for pool cleanup')
                withdrawn = events.get_nowait()
                self.assertEqual((withdrawn['phase'], withdrawn['attempt']), ('replacing', first['attempt']))
                self.assertEqual(withdrawn['health']['reason'], 'country')
                self.assertEqual(withdrawn['health']['country'], 'JP')
                self.assertFalse(session.browser_feedback('confirm', first['attempt'], address))
                self.assertTrue(events.empty(), 'no new offer before cleanup completes')
            finally:
                cleanup_release.set()
                owner.cancel()
                await asyncio.gather(owner, return_exceptions=True)
