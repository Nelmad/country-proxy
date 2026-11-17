"""Automatic browser feedback belongs to one native offer on one session."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import host
from core import Candidate, Session


def endpoint(proxy):
    return {name: proxy[name] for name in ('scheme', 'host', 'port')}


class Feedback(unittest.IsolatedAsyncioTestCase):
    async def test_single_native_health_failure_keeps_confirmed_offer(self):
        item = Candidate('http', '8.8.8.8', 8080)
        events, samples = asyncio.Queue(), iter((True, False, True))
        async def discover(_):
            return [item], []
        async def check(candidate, country, slow):
            if next(samples):
                return dict(scheme=item.scheme, host=item.host, port=item.port, country='NO',
                            exitIp=item.host, latencyMs=1, checkedAt=0)
        def emit(event):
            if event['phase'] in ('connected', 'confirming', 'replacing'):
                events.put_nowait(event)
        session = Session('NO', emit, discover, check, interval=60)
        session.wait_for_browser = True
        task = asyncio.create_task(session.run())
        try:
            first = await asyncio.wait_for(events.get(), 1)
            self.assertTrue(session.browser_feedback('confirm', first['attempt'], endpoint(first['proxy'])))
            for phase in ('confirming', 'connected'):
                session.nudge()
                event = await asyncio.wait_for(events.get(), 1)
                self.assertEqual((event['phase'], event['attempt']), (phase, first['attempt']))
                self.assertTrue(session.eligible(item))
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_rejecting_first_reserve_reuses_other_and_ignores_old_feedback(self):
        active = Candidate('http', '8.8.8.8', 8080)
        first = Candidate('socks5', '1.1.1.1', 1080)
        second = Candidate('http', '9.9.9.9', 8080)
        discoveries, offers = [], asyncio.Queue()
        second_started = asyncio.Event()
        async def discover(cc):
            discoveries.append(cc)
            return [active], []
        def result(item, cc='EE'):
            return dict(scheme=item.scheme, host=item.host, port=item.port, country=cc,
                        exitIp=item.host, latencyMs=1, checkedAt=0)
        async def check(item, selected, slow):
            if item == first:
                await second_started.wait()
            elif item == second and not second_started.is_set():
                second_started.set()
                await asyncio.Event().wait()  # cancelled when first wins
            return result(item)
        def emit(status):
            if status['phase'] == 'connected':
                offers.put_nowait(status)
        session = Session(['EE','NO'], emit, discover, check, interval=60)
        session.wait_for_browser = True
        task = asyncio.create_task(session.run())
        async def offer(): return await asyncio.wait_for(offers.get(), 2)
        try:
            initial = await offer()
            self.assertTrue(session.pool.accept(result(first)))
            self.assertTrue(session.pool.accept(result(second, 'NO')))
            initial_fetches = tuple(discoveries)
            self.assertTrue(session.browser_feedback('reject', initial['attempt'], endpoint(initial['proxy']), 'timeout'))
            a = await offer()
            self.assertEqual(a['proxy']['host'], first.host)
            self.assertGreater(a['attempt'], initial['attempt'])
            self.assertFalse(session.pool.refill_allowed.is_set())
            self.assertTrue(second_started.is_set())
            self.assertIn(second.key, session.pool.entries)
            self.assertTrue(session.browser_feedback('reject', a['attempt'], endpoint(a['proxy']), 'transport'))
            b = await offer()
            self.assertEqual(b['proxy']['host'], second.host)
            self.assertGreater(b['attempt'], a['attempt'])
            self.assertGreaterEqual(len(discoveries), len(initial_fetches))
            self.assertLessEqual(len(discoveries), len(initial_fetches) + 4)
            self.assertFalse(session.pool.refill_allowed.is_set())
            for attempt, proxy in [(a['attempt'], a['proxy']), (a['attempt'], b['proxy']),
                                   (b['attempt'], a['proxy']), (True, b['proxy'])]:
                self.assertFalse(session.browser_feedback('reject', attempt, endpoint(proxy), 'transport'))
                self.assertFalse(session.browser_feedback('confirm', attempt, endpoint(proxy)))
            self.assertFalse(session.browser_feedback('reject', b['attempt'], endpoint(b['proxy']), 'cancelled'))
            self.assertTrue(session.eligible(second))
            self.assertFalse(session.force_rotate)
            self.assertTrue(session.browser_feedback('confirm', b['attempt'], endpoint(b['proxy'])))
            self.assertTrue(session.pool.refill_allowed.is_set())
            session.nudge()
            refreshed = await offer()
            self.assertEqual((refreshed['attempt'], refreshed['proxy']['host']), (b['attempt'], second.host))
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(session.check_budget.snapshot['requests'])

    async def test_host_requires_matching_protocol_and_generation(self):
        sessions, sent = [], []
        class Recorder:
            def __init__(self, _, emit):
                self.commands = []
                sessions.append(self)
            async def run(self):
                await asyncio.Event().wait()
            def nudge(self, rotate):
                self.commands.append(('nudge', rotate))
            def browser_feedback(self, *args):
                self.commands.append(args)
        messages = [dict(command='start', id='old', country='NO'),
                    dict(command='start', id='bool', country='EE', feedbackProtocol=True),
                    dict(command='start', id='now', countries=['NO','EE'], feedbackProtocol=1)]
        address = dict(scheme='socks5', host='1.1.1.1', port=1080)
        for generation in ['old', 'now']:
            for command in ['reject', 'confirm', 'rotate', 'check']:
                messages.append(dict(command=command, id=generation, proxy=address, attempt=3, reason='http'))
        messages.append(dict(command='stop'))
        messages.append(asyncio.IncompleteReadError(b'', 4))
        loop = asyncio.get_running_loop()
        with patch.object(loop, 'connect_read_pipe', new=AsyncMock()), \
             patch.object(host, 'Session', Recorder), patch.object(host, 'send', sent.append), \
             patch.object(host, 'receive', new=AsyncMock(side_effect=messages)):
            await host.main()
        self.assertEqual(sent[0]['feedbackProtocol'], 1)
        self.assertEqual([x['id'] for x in sent if x.get('phase') == 'error'], ['old','bool'])
        self.assertEqual(len(sessions), 1)
        self.assertTrue(sessions[0].wait_for_browser)
        self.assertEqual(sessions[0].commands, [('reject',3,address,'http'), ('confirm',3,address,'http'),
                                                ('nudge',True), ('nudge',False)])

