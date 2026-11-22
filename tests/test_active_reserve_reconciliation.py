"""Active health changes reconcile the real reserve before publishing the offer."""
import asyncio
from collections import Counter
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import core
from core import Candidate, Session


class ActiveReserveReconciliation(unittest.IsolatedAsyncioTestCase):
    async def test_changed_healthy_exit_publishes_current_count_before_connected(self):
        for country in ('NO', 'EE', 'AT'):
            for independent in (False, True):
                with self.subTest(country=country, independent=independent):
                    await self.exercise_change(country, independent)

    async def exercise_change(self, country, independent):
        active = Candidate('http', '8.8.8.8', 8080)
        shared = Candidate('http', '1.1.1.1', 8080)
        other = Candidate('socks5', '9.9.9.9', 1080)
        exits = {active: '8.8.4.4', shared: '1.0.0.1', other: '9.9.9.10'}
        countries = {active: 'NO', shared: 'EE', other: 'AT'}
        calls, events, observed = Counter(), [], asyncio.Queue()
        session = None

        async def discover(_):
            return [active], []

        async def transport(url, item, slow):
            calls[item, url] += 1
            if url == core.TRACE:
                return 0, '200', f'ip={exits[item]}\nloc={countries[item]}'
            self.assertEqual(url, core.TARGET)
            return 0, '204', ''

        def emit(event):
            # Exercise serialization and freeze snapshots, as the host does.
            events.append(json.loads(json.dumps(event)))
            if event['phase'] == 'connected':
                observed.put_nowait((len(events) - 1, set(session.pool.entries)))

        session = Session(('NO', 'EE', 'AT'), emit, discoverer=discover, interval=3600)
        session.wait_for_browser = True
        session.pool.interval = 3600
        task = None
        with patch.object(core, 'curl', transport):
            try:
                task = asyncio.create_task(session.run())
                await asyncio.wait_for(observed.get(), 2)
                # Admission uses the real Session reserve checks and both HTTPS controls.
                for item in (shared, other) if independent else (shared,):
                    verified = await session.reserve_checked(item, session.country, True)
                    self.assertTrue(session.pool.accept(verified))
                    self.assertEqual((calls[item, core.TRACE], calls[item, core.TARGET]), (1, 1))
                prior = session.pool.diagnostic_snapshot(True)
                shared_id = session.pool._reserve_ids[shared.key]
                other_entry = session.pool.entries.get(other.key)
                generation = session.pool._generation
                before = len(events)
                exits[active], countries[active] = exits[shared], country
                active_calls = (calls[active, core.TRACE], calls[active, core.TARGET])
                session.nudge()
                index, current_entries = await asyncio.wait_for(observed.get(), 2)
                connected = events[index]
                expected = {other.key} if independent else set()
                self.assertEqual(current_entries, expected)
                self.assertEqual(connected['proxy']['exitIp'], exits[shared])
                self.assertEqual(connected['country'], country)
                self.assertEqual(connected['health'], {'ok': True})
                self.assertEqual(connected['attempt'], 1)
                self.assertEqual(connected['diagnostics']['failures'], {})
                self.assertEqual(connected['diagnostics']['reserve']['failures'], {})
                self.assertEqual(session.pool._generation, generation)
                if independent:
                    self.assertIs(session.pool.entries[other.key], other_entry)
                pool_events = [event for event in events[before:index] if event['phase'] == 'pool']
                self.assertTrue(pool_events, 'fresh count must precede the health connected event')
                self.assertEqual(pool_events[-1]['reserveCount'], len(expected))
                self.assertEqual(pool_events[-1]['country'], country)
                removal = connected['diagnostics']['reserve']['removals']
                self.assertEqual(len(removal), 1)
                self.assertEqual((removal[0]['reserveId'], removal[0]['stage'], removal[0]['reason']),
                                 (shared_id, 'prune', 'sameExit'))
                self.assertNotIn('check', removal[0])
                self.assertEqual(connected['diagnostics']['reserve']['counts']['removed'], 1)
                self.assertEqual(prior['removals'], [])
                self.assertEqual((calls[active, core.TRACE], calls[active, core.TARGET]),
                                 (active_calls[0] + 1, active_calls[1] + 1))

                # Neither identical health nor unrelated latency/checkedAt changes
                # should repeatedly prune/publish or restart discovery rounds.
                for _ in range(2):
                    with patch.object(session.pool, 'publish', wraps=session.pool.publish) as publish:
                        # Maintenance may finish its one wake from the real removal.
                        await asyncio.sleep(.01)
                        publish.reset_mock()
                        session.nudge()
                        repeated, entries = await asyncio.wait_for(observed.get(), 2)
                        self.assertEqual(entries, expected)
                        self.assertEqual(events[repeated]['diagnostics']['reserve']['removals'], removal)
                        self.assertEqual(events[repeated]['diagnostics']['reserve']['counts']['removed'], 1)
                        self.assertEqual(publish.call_count, 0)
                self.assertEqual(session.pool.counts['rounds'], 0)
                self.assertTrue(session.eligible(shared))
                self.assertEqual(session.excluded, {})
            finally:
                if task is not None:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(session.pool._probes)
        self.assertEqual(session.check_budget.snapshot['requests'], 0)
