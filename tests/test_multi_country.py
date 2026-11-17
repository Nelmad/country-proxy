"""Equal-priority country selections, bounded work and cross-country failover."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import (COUNTRIES, Candidate, Session, country_codes, discover_selection,
                  inspect_proxy, scan)
from host import start_selection, status_message
from pool import ReservePool

SELECTED = ('EE', 'NO', 'PL')
A = Candidate('http', '8.8.8.8', 3128)
B = Candidate('http', '1.1.1.1', 3128)
C = Candidate('socks5', '9.9.9.9', 1080)
D = Candidate('http', '4.2.2.2', 80)
LOCS = {A: 'EE', B: 'NO', C: 'PL', D: 'EE'}


def proxy(item, country=None, latency=1):
    return dict(scheme=item.scheme, host=item.host, port=item.port,
                country=country or LOCS[item], exitIp=item.host,
                latencyMs=latency, checkedAt=123)


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.001)


class SelectionContract(unittest.TestCase):
    def test_selection_is_set_not_order_and_legacy_single_remains(self):
        self.assertEqual(country_codes(['pl', 'EE', 'NO', 'ee']), SELECTED)
        self.assertEqual(country_codes(['NO', 'PL', 'EE']), SELECTED)
        self.assertEqual(start_selection({'country': 'pl'}), ('PL',))
        self.assertEqual(start_selection({'countries': ['PL', 'NO', 'EE']}), SELECTED)
        self.assertEqual(len(country_codes(sorted(COUNTRIES))), 249)
        for value in ([], ['NO', 'XX'], [None], None, {}, True, ['NO'] * 250):
            with self.subTest(value=value), self.assertRaises(ValueError):
                country_codes(value)
        for value in ('NO', None, {}, []):
            with self.subTest(message=value), self.assertRaises(ValueError):
                start_selection({'countries': value})

    def test_native_events_bind_selection_and_actual_location(self):
        searching = status_message('generation', SELECTED, {'phase': 'searching', 'proxy': None})
        self.assertEqual(searching['countries'], list(SELECTED))
        self.assertIsNone(searching['country'])
        connected = status_message('generation', SELECTED, {'phase': 'connected', 'proxy': proxy(B)})
        self.assertEqual(connected['country'], 'NO')
        self.assertEqual(connected['id'], 'generation')
        self.assertEqual(status_message('old', ('PL',), {'phase': 'searching'})['country'], 'PL')


class MultiDiscovery(unittest.IsolatedAsyncioTestCase):
    async def test_fair_cap_and_input_order_independence(self):
        async def source(cc):
            index = SELECTED.index(cc) + 1
            return [Candidate('http', f'8.{index}.0.{n}', 80) for n in range(1, 121)], []
        shuffle = lambda values: values.reverse()
        one, _ = await discover_selection(['PL', 'EE', 'NO'], source, shuffle=shuffle)
        two, _ = await discover_selection(['NO', 'PL', 'EE'], source, shuffle=shuffle)
        self.assertEqual(one, two)
        self.assertEqual(len(one), 120)
        self.assertEqual([item.host.split('.')[1] for item in one[:6]], ['3', '2', '1'] * 2)
        self.assertEqual({i: sum(item.host.split('.')[1] == str(i) for item in one) for i in (1, 2, 3)},
                         {1: 40, 2: 40, 3: 40})

    async def test_duplicate_endpoints_and_empty_feeds_do_not_waste_budget(self):
        async def source(cc):
            return ([A, A, B] if cc == 'EE' else [A, C] if cc == 'NO' else []), []
        found, errors = await discover_selection(SELECTED, source, shuffle=lambda _: None)
        self.assertEqual(found, [A, B, C])
        self.assertFalse(errors)

    async def test_country_jobs_are_bounded_and_caller_cancel_propagates(self):
        live = peak = cancelled = 0
        ready = asyncio.Event()
        async def source(cc):
            nonlocal live, peak, cancelled
            live += 1; peak = max(peak, live)
            if live == 3: ready.set()
            try:
                await asyncio.sleep(60)
            finally:
                live -= 1; cancelled += 1
        task = asyncio.create_task(discover_selection(sorted(COUNTRIES), source))
        await asyncio.wait_for(ready.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        self.assertEqual((live, peak, cancelled), (0, 3, 3))

    async def test_global_deadline_keeps_completed_results_and_cancels_inflight(self):
        live = peak = cancelled = 0
        async def source(cc):
            nonlocal live, peak, cancelled
            if cc == 'EE': return [A], []
            live += 1; peak = max(peak, live)
            try:
                await asyncio.sleep(60)
            finally:
                live -= 1; cancelled += 1
        found, errors = await asyncio.wait_for(
            discover_selection(['EE', 'NO', 'PL', 'SE', 'US'], source,
                               shuffle=lambda _: None, budget=.025), .3)
        self.assertEqual(found, [A])
        self.assertEqual((live, peak, cancelled), (0, 3, 3))
        self.assertTrue(any('4 стран' in warning for warning in errors))

    async def test_one_broken_country_does_not_hide_other_results_and_warnings_bounded(self):
        async def source(cc):
            if cc == 'EE': raise RuntimeError('offline')
            return [B], ['unavailable'] * 30
        found, errors = await discover_selection(SELECTED, source, shuffle=lambda _: None)
        self.assertEqual(found, [B])
        self.assertLessEqual(len(errors), 13)
        self.assertTrue(any('EE:' in warning for warning in errors))

    async def test_invalid_selection_does_not_start_sources(self):
        calls = []
        async def source(cc): calls.append(cc); return [], []
        with self.assertRaises(ValueError):
            await discover_selection(['NO', 'invalid'], source)
        self.assertFalse(calls)


class MultiChecks(unittest.IsolatedAsyncioTestCase):
    async def test_every_selected_actual_country_accepted_and_other_rejected(self):
        for location in (*SELECTED, 'SE'):
            async def fetch(url, *args):
                return (0, '200', f'ip=8.8.8.8\nloc={location}') if 'trace' in url else (0, '204', '')
            with self.subTest(country=location), patch('core.curl', fetch):
                report = await inspect_proxy(A, SELECTED)
                self.assertEqual(report['ok'], location in SELECTED)
                if report['ok']:
                    self.assertEqual(report['proxy']['country'], location)
                else:
                    self.assertEqual(report['reason'], 'country')

    async def test_scan_has_one_global_candidate_and_concurrency_budget(self):
        candidates = [Candidate('http', f'8.1.{n // 250}.{n % 250 + 1}', 80) for n in range(300)]
        live = peak = 0; calls = []
        async def checker(item, countries, slow):
            nonlocal live, peak
            self.assertEqual(countries, SELECTED)
            calls.append(item); live += 1; peak = max(peak, live)
            try: await asyncio.sleep(0)
            finally: live -= 1
            return None
        self.assertIsNone(await scan(candidates, SELECTED, lambda *args: None, checker, concurrency=100))
        self.assertEqual((live, peak), (0, 10))
        self.assertEqual(len(calls), 240)  # Two passes over one 120-candidate budget.
        self.assertEqual(len(set(calls)), 120)

    async def test_reserve_other_country_beats_slower_current_country(self):
        async def source(cc): return [], []
        started = set()
        async def checker(item, countries, slow):
            self.assertEqual(countries, SELECTED)
            started.add(item)
            if item == D:
                await asyncio.Event().wait()
            await asyncio.sleep(.01)
            self.assertEqual(started, {D, B})
            return proxy(item, latency=1 if item == B else 20)
        pool = ReservePool(SELECTED, source, checker, lambda: proxy(A),
                           lambda _: True, lambda *args: None, lambda _: None)
        self.assertTrue(pool.accept(proxy(D, latency=20)))  # Current location's reserve first.
        self.assertTrue(pool.accept(proxy(B, latency=1)))
        self.assertFalse(pool.accept(proxy(C)))  # Global limit, not two per country.
        self.assertEqual((await pool.take())['country'], 'NO')
        self.assertEqual(len(pool.entries), 1)

    async def test_reserve_changed_to_other_selected_country_is_valid_not_outside(self):
        async def source(cc): return [], []
        location = 'PL'
        async def checker(*args): return proxy(B, location)
        pool = ReservePool(SELECTED, source, checker, lambda: proxy(A),
                           lambda _: True, lambda *args: None, lambda _: None)
        pool.accept(proxy(B))
        self.assertEqual((await pool.take())['country'], 'PL')
        location = 'SE'; pool.accept(proxy(B))
        self.assertIsNone(await pool.take())
        self.assertFalse(pool.accept(proxy(C, 'SE')))

    async def test_session_cross_country_reserve_and_fresh_search(self):
        events = []; discoveries = []; at_connected = []; only = None
        async def source(cc):
            discoveries.append(cc)
            return [item for item in [A, B, C] if LOCS[item] == cc and (only is None or item == only)], []
        async def checker(item, countries, slow):
            self.assertEqual(countries, SELECTED)
            # Establish the intended EE → NO → PL path by actual completion.
            # A cached latency field cannot decide a concurrent reserve race.
            if not at_connected and item != A:
                await asyncio.Event().wait()
            if item == C and at_connected and session.active is None and only is None:
                await asyncio.Event().wait()
            return proxy(item, latency=1 if item == B else 2)
        def emit(event):
            events.append(event)
            if event['phase'] == 'connected':
                at_connected.append(len(discoveries))
        session = Session(['PL', 'EE', 'NO'], emit, source, checker, interval=60)
        task = asyncio.create_task(session.run())
        try:
            await until(lambda: session.active is not None and len(session.pool.entries) == 2)
            self.assertEqual(session.active['country'], 'EE')
            before = len(discoveries); transition_start = len(events); session.nudge(True)
            await until(lambda: session.active is not None and session.active['country'] == 'NO')
            # One equal-country discovery round overlaps the reserve rechecks.
            self.assertGreaterEqual(at_connected[-1], before)
            self.assertLessEqual(at_connected[-1], before + 3)
            transition = events[transition_start:]
            connected_index = next(i for i, event in enumerate(transition) if event['phase'] == 'connected')
            self.assertTrue(any(e['phase'] == 'searching' for e in transition[:connected_index]))
            await session.stop_pool(); session.pool.entries.clear(); only = C
            before_search = len(discoveries)
            session.nudge(True)
            await until(lambda: session.active is not None and session.active['country'] == 'PL')
            self.assertGreater(at_connected[-1], before_search)
            self.assertTrue(all(event['countries'] == list(SELECTED) for event in events))
            connected = [event for event in events if event['phase'] == 'connected']
            self.assertEqual([event['country'] for event in connected[:3]], ['EE', 'NO', 'PL'])
            self.assertFalse(session.eligible(A)); self.assertFalse(session.eligible(B))
        finally:
            task.cancel(); await asyncio.gather(task, return_exceptions=True)
        self.assertIsNone(session.pool_task); self.assertFalse(session.pool.entries)

    async def test_healthy_active_stays_put_and_allowed_geo_change_is_reported(self):
        location = 'EE'; events = []; calls = 0
        async def source(cc): return ([A] if cc == 'EE' else []), []
        async def checker(item, countries, slow):
            nonlocal calls
            calls += 1
            return proxy(item, location)
        session = Session(SELECTED, events.append, source, checker, interval=60)
        task = asyncio.create_task(session.run())
        try:
            await until(lambda: session.active is not None)
            location = 'NO'; session.nudge()
            await until(lambda: session.active['country'] == 'NO')
            self.assertEqual(session.active['host'], A.host)
            self.assertNotIn('replacing', [event['phase'] for event in events])
            self.assertEqual([event for event in events if event['phase'] == 'connected'][-1]['country'], 'NO')
        finally:
            task.cancel(); await asyncio.gather(task, return_exceptions=True)

    async def test_custom_checker_cannot_return_unselected_country(self):
        async def source(cc): return [], []
        async def checker(*args): return proxy(A, 'SE')
        session = Session(SELECTED, lambda _: None, source, checker)
        self.assertIsNone(await session.checked(A, SELECTED))
        self.assertEqual(session.diagnostics['failures'], {'country': 1})


if __name__ == '__main__':
    unittest.main()
