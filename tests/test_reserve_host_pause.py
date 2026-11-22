"""Host cooldown survives endpoint history pruning; no network or curl subprocesses."""
import asyncio
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import core
from pool import ReservePool
from sources import SourceBatch

ACTIVE = core.Candidate('http', '1.1.1.1', 8000)
RESERVE = core.Candidate('http', '8.8.8.8', 8000)
OTHER = core.Candidate('http', '9.9.9.9', 8000)
HEALTHY = core.Candidate('http', '4.2.2.2', 8000)
SIBLINGS = tuple(core.Candidate('socks5', RESERVE.host, 8001 + i) for i in range(7))


def proxy(item, country='EE'):
    return dict(asdict(item), country=country, exitIp=item.host, latencyMs=3, checkedAt=1)


class SessionHostPauseTests(unittest.IsolatedAsyncioTestCase):
    async def run_failure(self, mode, *, prune_before_owner=False):
        calls, prune_states = [], []
        replaced = asyncio.Event()
        async def feed(country):
            yield SourceBatch('fixture', 'fixture', SIBLINGS + (HEALTHY,) if country == 'EE' else (),
                              None, 0, True)
        def emit(message):
            if message.get('phase') == 'pool' and session.pool.removals and len(session.pool.entries) == 2:
                replaced.set()
        session = core.Session(['NO', 'EE', 'AT'], emit, source_stream=feed,
                               source_groups=('fixture',), shuffle=lambda _: None)
        session.active = proxy(ACTIVE, 'AT')
        pool = session.pool
        pool.interval = .02
        self.assertTrue(pool.accept(proxy(RESERVE)))
        self.assertTrue(pool.accept(proxy(OTHER, 'NO')))
        reserve_id = pool._reserve_ids[RESERVE.key]
        old_entry, old_token = pool.entries[RESERVE.key], pool._tokens[RESERVE.key]
        exclusion_calls = []
        def exclude(item, seconds):
            exclusion_calls.append((item, seconds, time.monotonic()))
            session.exclude(item, seconds)
        pool.exclude = exclude
        def competing_prune():
            # A status/maintenance reader may prune between the physical check's
            # completion and its shield owner's resumption. The pause must exist now.
            prune_states.append((session.history.eligible(RESERVE), RESERVE.host in session.excluded))
            pool.prune()
        real_report = pool.report_checker
        async def report(item, *args):
            value = await real_report(item, *args)
            if item == RESERVE and prune_before_owner:
                asyncio.get_running_loop().call_soon(competing_prune)
            return value
        pool.report_checker = report
        async def transfer(url, item, slow):
            calls.append((item, url, pool._generation, pool._reserve_ids.get(item.key)))
            if item == RESERVE and mode == 'timeout':
                return 28, '000', ''
            if url == core.TRACE:
                country = 'DE' if item == RESERVE and mode == 'country' else 'NO' if item == OTHER else 'AT'
                return 0, '200', f'ip={item.host}\nloc={country}\n'
            return 0, '204', ''
        await session.check_budget.set_active(True)
        with patch.object(core, 'curl', transfer):
            task = asyncio.create_task(pool.run())
            try:
                await asyncio.wait_for(replaced.wait(), 2)
                generation = pool._generation
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await session.check_budget.close()
        self.assertEqual(session.countries, ('AT', 'EE', 'NO'))
        self.assertTrue(all(row[2] == generation for row in calls))
        self.assertTrue(all(row[3] == reserve_id for row in calls if row[0] == RESERVE))
        self.assertIsNot(pool.entries.get(RESERVE.key), old_entry)
        self.assertIsNot(pool._tokens.get(RESERVE.key), old_token)
        events = [event for event in pool.removals if event['reserveId'] == reserve_id]
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]['stage'], events[0]['reason']), ('maintenance', 'checkFailed'))
        self.assertEqual(events[0]['check']['reason'], mode)
        self.assertEqual(pool.counts['removed'], 1)
        self.assertIn(RESERVE.host, session.excluded)
        self.assertEqual([(item, seconds) for item, seconds, _ in exclusion_calls], [(RESERVE, 60)])
        self.assertFalse(session.eligible(SIBLINGS[0]))
        self.assertFalse(any(item in SIBLINGS for item, *_ in calls), calls)
        self.assertIn(HEALTHY.key, pool.entries)
        self.assertNotIn(OTHER.host, session.excluded)
        self.assertEqual(set(pool.entries), {OTHER.key, HEALTHY.key})
        if prune_before_owner:
            self.assertTrue(prune_states)
            self.assertEqual(prune_states[0], (False, True))
        record = session.history.get(RESERVE)
        self.assertEqual(record.last_outcome, mode)
        self.assertEqual(record.streak, 0)
        sibling_record = session.history.get(SIBLINGS[0])
        self.assertIsNotNone(sibling_record)  # Source sighting is not a completed check.
        self.assertIsNone(sibling_record.last_outcome)
        self.assertIsNone(sibling_record.cooldown_until)
        return session, exclusion_calls[0][2]

    async def test_stale_shared_waiter_cannot_mask_current_maintenance_failure(self):
        for stale_field in ('generation', 'token', 'entry'):
            for first_owner in ('maintenance', 'stale'):
                with self.subTest(stale_field=stale_field, first_owner=first_owner):
                    entered, release = asyncio.Event(), asyncio.Event()
                    session = core.Session(('AT', 'EE', 'NO'), lambda _: None)
                    pool = session.pool
                    self.assertTrue(pool.accept(proxy(RESERVE)))
                    entry, token, generation = pool.entries[RESERVE.key], pool._tokens[RESERVE.key], pool._generation
                    reserve_id = pool._reserve_ids[RESERVE.key]
                    stale_entry = (dict(entry[0]), entry[1]) if stale_field == 'entry' else entry
                    stale_token = object() if stale_field == 'token' else token
                    stale_generation = generation - 1 if stale_field == 'generation' else generation
                    stale_lease = (RESERVE.key, stale_entry, stale_token, stale_generation, 'promotion')
                    exclusions = []
                    def exclude(item, seconds):
                        exclusions.append((item, seconds))
                        session.exclude(item, seconds)
                    pool.exclude = exclude
                    async def transfer(*_):
                        entered.set()
                        await release.wait()
                        return 28, '000', ''
                    with patch.object(core, 'curl', transfer):
                        tasks = []
                        try:
                            if first_owner == 'maintenance':
                                tasks.append(pool._start_refresh(RESERVE.key))
                            else:
                                tasks.append(asyncio.create_task(pool.verify(RESERVE, lease=stale_lease)))
                            await asyncio.wait_for(entered.wait(), 1)
                            if first_owner == 'maintenance':
                                tasks.append(asyncio.create_task(pool.verify(RESERVE, lease=stale_lease)))
                            else:
                                tasks.append(pool._start_refresh(RESERVE.key))
                            async with asyncio.timeout(1):
                                while pool._probes[RESERVE.key]['owners'] != 2:
                                    await asyncio.sleep(0)
                            release.set()
                            await asyncio.wait_for(asyncio.gather(*tasks), 1)
                        finally:
                            release.set()
                            for task in tasks:
                                if not task.done():
                                    task.cancel()
                            await asyncio.gather(*tasks, return_exceptions=True)
                            await session.check_budget.close()
                    self.assertEqual(exclusions, [(RESERVE, 60)])
                    self.assertIn(RESERVE.host, session.excluded)
                    self.assertFalse(session.eligible(SIBLINGS[0]))
                    self.assertFalse(session.history.eligible(RESERVE))
                    self.assertEqual(len(pool.removals), 1)
                    event = pool.removals[0]
                    self.assertEqual(event['reserveId'], reserve_id)
                    self.assertEqual((event['stage'], event['reason']), ('maintenance', 'checkFailed'))
                    self.assertEqual(event['check']['reason'], 'timeout')
                    self.assertEqual(pool.counts['removed'], 1)

    async def test_timeout_excludes_all_ports_before_real_scheduler_refill(self):
        await self.run_failure('timeout')

    async def test_timeout_pause_precedes_competing_prune_and_refill(self):
        await self.run_failure('timeout', prune_before_owner=True)

    async def test_country_failure_retains_same_host_pause(self):
        await self.run_failure('country')

    async def test_host_returns_after_sixty_seconds_without_erasing_endpoint_history(self):
        session, failure_at = await self.run_failure('timeout')
        until = session.excluded[RESERVE.host]
        self.assertGreaterEqual(until, failure_at + 60)
        self.assertLess(until, failure_at + 60.1)
        record = session.history.get(RESERVE)
        saved = dict(vars(record))
        # Only Session's clock is changed, after all asyncio work was drained.
        # History keeps its independent clock/cooldown and its truthful record.
        with patch.object(core, 'time', SimpleNamespace(monotonic=lambda: until - .001)):
            self.assertFalse(session.eligible(SIBLINGS[0]))
        with patch.object(core, 'time', SimpleNamespace(monotonic=lambda: until)):
            self.assertTrue(session.eligible(SIBLINGS[0]))
            self.assertNotIn(RESERVE.host, session.excluded)
            self.assertFalse(session.eligible(RESERVE))  # Its endpoint cooldown remains separate.
        self.assertEqual(vars(session.history.get(RESERVE)), saved)
        session.history.clock = lambda: until + .001
        with patch.object(core, 'time', SimpleNamespace(monotonic=lambda: until + .001)):
            self.assertTrue(session.eligible(RESERVE))
        self.assertEqual(vars(session.history.get(RESERVE)), saved)


class LeaseHostPauseTests(unittest.IsolatedAsyncioTestCase):
    def make(self, report):
        self.blocked, self.exclusions = set(), []
        self.now = 0
        async def discover(*_):
            return [], []
        async def checker(*_):
            raise AssertionError('report checker should be used')
        def exclude(item, seconds):
            self.exclusions.append((item, seconds))
            self.blocked.add(item.key)
        pool = ReservePool(('AT', 'EE', 'NO'), discover, checker, lambda: None,
                           lambda item: item.key not in self.blocked, exclude, lambda _: None,
                           clock=lambda: self.now)
        pool.report_checker = report
        self.assertTrue(pool.accept(proxy(RESERVE)))
        return pool

    async def test_old_token_and_generation_cannot_pause_or_remove_replacement(self):
        for stale in ('token', 'entry', 'generation'):
            with self.subTest(stale=stale):
                entered, release = asyncio.Event(), asyncio.Event()
                async def report(*_):
                    entered.set()
                    await release.wait()
                    return {'ok': False, 'reason': 'timeout', 'code': 28}
                pool = self.make(report)
                snapshots = []
                pool.emit = snapshots.append
                task = pool._start_refresh(RESERVE.key)
                await asyncio.wait_for(entered.wait(), 1)
                if stale == 'token':
                    pool._tokens[RESERVE.key] = object()
                elif stale == 'entry':
                    pool._remove(RESERVE.key, wake_refill=False)
                    self.assertTrue(pool.accept(proxy(RESERVE)))
                else:
                    pool._generation += 1
                replacement, token, reserve_id = pool.entries[RESERVE.key], pool._tokens[RESERVE.key], pool._reserve_ids[RESERVE.key]
                snapshots.clear()
                release.set()
                await asyncio.wait_for(task, 1)
                self.assertEqual(self.exclusions, [])
                self.assertIs(pool.entries[RESERVE.key], replacement)
                self.assertIs(pool._tokens[RESERVE.key], token)
                self.assertEqual(pool._reserve_ids[RESERVE.key], reserve_id)
                self.assertEqual(list(pool.removals), [])
                self.assertFalse(pool._lease_checks)
                if stale == 'generation':
                    self.assertEqual(snapshots, [])  # An old session cannot publish into the new one.
                else:
                    self.assertTrue(all(row['reserveCount'] == 1 for row in snapshots))

    async def test_cancelled_checker_ignoring_cancel_never_pauses_host(self):
        entered, cleanup, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def report(*_):
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cleanup.set()
                await release.wait()
                return {'ok': False, 'reason': 'timeout', 'code': 28}
        pool = self.make(report)
        entry, reserve_id = pool.entries[RESERVE.key], pool._reserve_ids[RESERVE.key]
        task = pool._start_refresh(RESERVE.key)
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        await asyncio.wait_for(cleanup.wait(), 1)
        self.assertFalse(task.done())
        task.cancel()  # Repeated owner cancellation must still drain owned cleanup.
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        self.assertIs(pool.entries[RESERVE.key], entry)
        self.assertEqual(pool._reserve_ids[RESERVE.key], reserve_id)
        self.assertEqual(self.exclusions, [])
        self.assertEqual(list(pool.removals), [])
        self.assertFalse(pool._probes)
        self.assertFalse(pool._lease_checks)

    async def test_cancelled_maintenance_owner_of_shared_check_never_pauses_host(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def report(item, *_):
            entered.set()
            await release.wait()
            self.blocked.add(item.key)  # As Session endpoint history does.
            return {'ok': False, 'reason': 'timeout', 'code': 28}
        pool = self.make(report)
        task = pool._start_refresh(RESERVE.key)
        await asyncio.wait_for(entered.wait(), 1)
        other_owner = asyncio.create_task(pool.verify(RESERVE))
        while pool._probes[RESERVE.key]['owners'] != 2:
            await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        release.set()
        self.assertIsNone(await asyncio.wait_for(other_owner, 1))
        self.assertEqual(self.exclusions, [])
        self.assertFalse(pool._lease_checks)
        self.assertEqual(list(pool.removals), [])

    async def test_cancelled_maintenance_does_not_override_live_promotion_owner(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def report(item, *_):
            entered.set()
            await release.wait()
            self.blocked.add(item.key)
            return {'ok': False, 'reason': 'timeout', 'code': 28}
        pool = self.make(report)
        entry, token = pool.entries[RESERVE.key], pool._tokens[RESERVE.key]
        promotion = asyncio.create_task(pool.verify(RESERVE,
            lease=(RESERVE.key, entry, token, pool._generation, 'promotion')))
        await asyncio.wait_for(entered.wait(), 1)
        maintenance = pool._start_refresh(RESERVE.key)
        while pool._probes[RESERVE.key]['owners'] != 2:
            await asyncio.sleep(0)
        maintenance.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await maintenance
        release.set()
        self.assertIsNone(await asyncio.wait_for(promotion, 1))
        self.assertEqual(self.exclusions, [])
        pool.prune()
        self.assertEqual(len(pool.removals), 1)
        self.assertEqual(pool.removals[0]['stage'], 'promotion')
        self.assertEqual(pool.removals[0]['check']['reason'], 'timeout')

    async def test_expiry_or_active_conflict_keeps_own_reason_and_no_new_pause(self):
        for invalidation in ('expired', 'outsideGroup', 'sameHost', 'sameExit'):
            with self.subTest(invalidation=invalidation):
                async def report(*_):
                    if invalidation == 'expired':
                        self.now = 90
                    elif invalidation == 'outsideGroup':
                        pool.entries[RESERVE.key][0]['country'] = 'DE'
                    elif invalidation == 'sameHost':
                        pool.active = lambda: proxy(RESERVE)
                    else:
                        pool.active = lambda: proxy(ACTIVE, 'EE') | {'exitIp': RESERVE.host}
                    return {'ok': False, 'reason': 'timeout', 'code': 28}
                pool = self.make(report)
                await pool._start_refresh(RESERVE.key)
                self.assertEqual(self.exclusions, [])
                self.assertEqual(len(pool.removals), 1)
                self.assertEqual(pool.removals[0]['reason'], invalidation)
                self.assertNotIn('check', pool.removals[0])
                self.assertEqual(pool.counts['expired' if invalidation == 'expired' else 'removed'], 1)

    async def test_cancelled_completed_infrastructure_failure_can_be_replaced_by_success(self):
        calls = 0
        async def report(item, *_):
            nonlocal calls
            calls += 1
            if calls == 1:
                asyncio.get_running_loop().call_soon(first.cancel)
                return {'ok': False, 'reason': 'tls', 'endpoint': 'trace', 'code': 58}
            return {'ok': True, 'proxy': proxy(item, 'AT')}
        pool = self.make(report)
        entry, token, generation = pool.entries[RESERVE.key], pool._tokens[RESERVE.key], pool._generation
        first = asyncio.create_task(pool._refresh_one(RESERVE.key, entry, token, generation))
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertEqual(self.exclusions, [])
        self.assertIn(pool._reserve_ids[RESERVE.key], pool._lease_checks)
        await pool._refresh_one(RESERVE.key, entry, token, generation)
        self.assertEqual(pool.entries[RESERVE.key][0]['country'], 'AT')
        self.assertEqual(self.exclusions, [])
        self.assertEqual(list(pool.removals), [])

    async def test_success_with_unrelated_quarantine_does_not_create_failure_pause(self):
        async def report(item, *_):
            self.blocked.add(item.key)
            return {'ok': True, 'proxy': proxy(item)}
        pool = self.make(report)
        await pool._start_refresh(RESERVE.key)
        self.assertEqual(self.exclusions, [])
        self.assertEqual(len(pool.removals), 1)
        self.assertEqual(pool.removals[0]['reason'], 'quarantined')
        self.assertNotIn('check', pool.removals[0])

    async def test_failed_maintenance_publishes_pruned_snapshot_before_return(self):
        for competing_prune in (False, True):
            with self.subTest(competing_prune=competing_prune):
                async def report(item, *_):
                    self.blocked.add(item.key)
                    if competing_prune:
                        asyncio.get_running_loop().call_soon(pool.prune)
                    return {'ok': False, 'reason': 'timeout', 'code': 28}
                pool = self.make(report)
                snapshots = []
                pool.emit = snapshots.append
                reserve_id = pool._reserve_ids[RESERVE.key]
                await pool._start_refresh(RESERVE.key)
                self.assertNotIn(RESERVE.key, pool.entries)
                self.assertEqual(len(snapshots), 1)
                self.assertEqual(snapshots[-1]['reserveCount'], 0)
                self.assertEqual(pool.removals[0]['reserveId'], reserve_id)
                self.assertEqual(pool.counts['removed'], 1)
                self.assertEqual(self.exclusions, [(RESERVE, 60)])

    async def test_valid_success_refreshes_without_host_pause_or_removal(self):
        async def report(item, *_):
            return {'ok': True, 'proxy': proxy(item, 'NO')}
        pool = self.make(report)
        old_id = pool._reserve_ids[RESERVE.key]
        self.now = 30
        await pool._start_refresh(RESERVE.key)
        self.assertEqual(pool.entries[RESERVE.key], (proxy(RESERVE, 'NO'), 30))
        self.assertNotEqual(pool._reserve_ids[RESERVE.key], old_id)
        self.assertEqual(self.exclusions, [])
        self.assertEqual(list(pool.removals), [])


if __name__ == '__main__':
    unittest.main()
