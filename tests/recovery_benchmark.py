#!/usr/bin/env python3
"""Offline timing observer for actual Country Proxy APIs; never performs network I/O.

Run the identical harness and contract against --root baseline/candidate snapshots.
Changing a product seam requires a reviewed adapter change, rerunning BOTH snapshots,
and reporting that the old timing series is not comparable. This is not a proxy checker.
"""
import argparse
import asyncio
from contextlib import ExitStack
from datetime import datetime, timezone
import hashlib
import importlib
import json
import math
from pathlib import Path
import platform
import random
import socket
import statistics
import sys
import time
from unittest.mock import patch

SCHEMA = 1


class InvalidTrial(Exception):
    """Fixture schedule missed its declared phase; cannot enter paired latency stats."""


MODULES = ('core', 'pool', 'sources')
CASE_NAMES = (
    'feed_cold', 'feed_warm', 'country_session', 'reserve_starvation',
    'reserve_hanging_first', 'fast_timeout_slow_success', 'repeated_dead_scan',
    'discovery_cancel', 'scan_bounds', 'idle_failure_after_health',
    'idle_failure_mid_interval', 'idle_failure_before_health',
)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_product(root):
    """Only one product tree per process; refuse accidentally cached foreign modules."""
    native = root / 'native'
    if not (native / 'core.py').is_file():
        raise ValueError('root must contain native/core.py')
    for name in MODULES:
        if name in sys.modules:
            location = Path(sys.modules[name].__file__).resolve()
            if location.parent != native.resolve():
                raise ValueError('Product module already loaded from a different root')
    sys.path.insert(0, str(native))
    return tuple(importlib.import_module(name) for name in MODULES)


def validate_contract(contract):
    if contract.get('schema') != SCHEMA or set(contract['cases']) - set(CASE_NAMES):
        raise ValueError('Unsupported contract schema/cases')
    if not contract['cases'] or len(set(contract['cases'])) != len(contract['cases']):
        raise ValueError('Cases must be nonempty and unique')
    for key, value in contract['timing'].items():
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= 10:
            raise ValueError('Invalid fixture timing: ' + key)
    if not 0 < contract['trial_deadline_s'] <= 30:
        raise ValueError('Invalid trial deadline')
    if any(type(n) is not int or not 1 <= n <= 1000 for n in contract['counts'].values()):
        raise ValueError('Invalid fixture count')


def percentile(values, probability=0.95):
    return sorted(values)[math.ceil(len(values) * probability) - 1] if values else None


def summarize(trials):
    completed = [trial for trial in trials if trial['status'] == 'completed' and trial['invariants_ok']]
    times = [trial['elapsed_ms'] for trial in completed]
    rank = math.ceil(len(trials) * .95)
    metric_names = sorted({key for trial in completed for key, value in trial['metrics'].items()
                           if key.endswith('_ms') and type(value) in (int, float)})
    return {
        'n_total': len(trials), 'n_completed': sum(t['status'] == 'completed' for t in trials),
        'n_successful': len(completed),
        'n_timeout': sum(t['status'] == 'timeout' for t in trials),
        'n_error': sum(t['status'] == 'error' for t in trials),
        'n_invalid': sum(t['status'] == 'invalid' for t in trials),
        'n_invariant_failure': sum(not t['invariants_ok'] for t in trials),
        'completed_latency_ms': {'n': len(times), 'median': statistics.median(times) if times else None,
                                 'p95_nearest_rank': percentile(times)},
        # Timeouts are censored, errors are not successful recoveries. Never substitute a deadline.
        'all_trial_p95_ms': sorted(times)[rank - 1] if rank and rank <= len(times) else None,
        'all_trial_p95_censored_or_failed': bool(rank > len(times)),
        'metrics': {name: metric_summary([t['metrics'][name] for t in completed
                                         if type(t['metrics'].get(name)) in (int, float)])
                    for name in metric_names},
    }


def metric_summary(values):
    return {'n': len(values), 'median': statistics.median(values) if values else None,
            'p95_nearest_rank': percentile(values)}


class Recorder:
    def __init__(self, attempt_id):
        self.attempt_id = attempt_id
        self.origin = time.monotonic()
        self.events = []
        self.metrics = {}
        self.invariants = {}
        self.counts = {}

    def now_ms(self):
        return (time.monotonic() - self.origin) * 1000

    def event(self, name, **fields):
        if len(self.events) >= 2000:
            raise AssertionError('Fixture event bound exceeded')
        self.events.append({'event': name, 'at_ms': self.now_ms(), **fields})

    def count(self, name, amount=1):
        self.counts[name] = self.counts.get(name, 0) + amount

    def require(self, name, condition):
        self.invariants[name] = self.invariants.get(name, True) and bool(condition)


class Fixtures:
    def __init__(self, core, pool, sources, contract):
        self.core, self.pool_module, self.sources = core, pool, sources
        self.contract, self.t = contract, contract['timing']
        self.a = core.Candidate('http', '8.8.8.1', 8001)
        self.b = core.Candidate('socks5', '9.9.9.2', 8002)
        self.c = core.Candidate('http', '1.1.1.3', 8003)

    def proxy(self, item, country='NO', latency=1):
        return {'scheme': item.scheme, 'host': item.host, 'port': item.port,
                'country': country, 'exitIp': item.host, 'latencyMs': latency,
                'checkedAt': 1_700_000_000_000}

    def pool(self, checker, discoverer, rec, **overrides):
        return self.pool_module.ReservePool(
            ('EE', 'NO'), discoverer, checker, lambda: self.proxy(self.c),
            lambda _: True, lambda *args: rec.count('excluded'), lambda _: None,
            ttl=self.t['pool_ttl_s'], interval=self.t['pool_interval_s'],
            budget=self.t['pool_refill_budget_s'], **overrides)

    async def feed(self, rec, warm):
        """Component observation; does NOT force Session through collect on a future API."""
        cache = self.sources.SourceCache()
        feeds = (self.sources.Source('fixture-fast', 'https://fixture.invalid/fast/{country}'),
                 self.sources.Source('fixture-slow', 'https://fixture.invalid/slow/{country}'))
        measuring = False
        component_start_ms = 0
        async def fetch(url):
            fast = '/fast/' in url
            if measuring:
                rec.count('feed_fetches')
                rec.event('feed_started', feed='fast' if fast else 'slow')
            await asyncio.sleep(self.t['fast_feed_s' if fast else 'slow_feed_s'])
            if measuring:
                rec.event('feed_ready', feed='fast' if fast else 'slow')
                if fast:
                    rec.metrics['first_feed_ready_ms'] = rec.now_ms() - component_start_ms
            item = self.a if fast else self.b
            return 0, '200', item.key
        async def library():
            if measuring:
                rec.count('library_calls')
            return []
        if warm:
            await self.sources.collect('NO', fetch, self.core.parse_candidates, library,
                                       sources=feeds, cache=cache)
        # Priming is outside component latency, but inside whole-trial deadline/elapsed.
        component_start_ms = rec.now_ms()
        rec.metrics['source_cache_priming_ms'] = component_start_ms
        measuring = True
        candidates, errors = await self.sources.collect('NO', fetch, self.core.parse_candidates,
                                                         library, sources=feeds, cache=cache)
        rec.metrics['collect_return_ms'] = rec.now_ms() - component_start_ms
        rec.metrics['cache_entries'] = len(cache.entries)
        rec.metrics['returned_candidates'] = len(candidates)
        rec.metrics['cache_state'] = 'warm source cache' if warm else 'cold source cache'
        rec.metrics['scope'] = 'collect component; browser and streaming end-to-end unmeasured'
        rec.require('both_candidates_preserved', set(candidates) == {self.a, self.b})
        rec.require('no_feed_errors', not errors)
        rec.require('cache_within_bound', len(cache.entries) <= cache.limit)
        rec.require('fetch_count', rec.counts.get('feed_fetches', 0) == (0 if warm else 2))

    async def country_session(self, rec):
        connected = asyncio.Event()
        country_delays = {'EE': self.t['fast_feed_s'], 'NO': self.t['slow_feed_s'],
                          'AT': self.t['medium_country_s']}
        values = {'EE': self.a, 'NO': self.b, 'AT': self.c}
        country_active = 0
        country_max = 0
        async def discovery(cc):
            nonlocal country_active, country_max
            country_active += 1
            country_max = max(country_max, country_active)
            rec.event('country_discovery_started', country=cc)
            try:
                await asyncio.sleep(country_delays[cc])
                rec.event('country_ready', country=cc)
                rec.metrics.setdefault('first_country_ready_ms', rec.now_ms())
                return [values[cc]], []
            except asyncio.CancelledError:
                rec.count('country_cancelled')
                raise
            finally:
                country_active -= 1
        async def checker(item, countries, slow=False):
            rec.count('checks_started')
            rec.metrics.setdefault('first_checker_start_ms', rec.now_ms())
            await asyncio.sleep(self.t['checker_s'])
            actual = next(cc for cc, value in values.items() if value == item)
            return self.proxy(item, actual)
        def emit(event):
            if event['phase'] == 'connected':
                rec.metrics.setdefault('native_connected_ms', rec.now_ms())
                rec.metrics.setdefault('connected_country', event['proxy']['country'])
                connected.set()
        session = self.core.Session(('EE', 'NO', 'AT'), emit, discovery, checker)
        rng = random.Random(self.contract['seed'])
        # Neutral deterministic injection at the existing randomized-order boundary.
        with patch.object(self.core.random, 'SystemRandom', return_value=rng):
            task = asyncio.create_task(session.run())
            try:
                await connected.wait()
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        rec.metrics['max_country_jobs'] = country_max
        rec.metrics['browser_confirmed_ms'] = None
        rec.require('country_jobs_bounded', country_max <= self.core.DISCOVERY_CONCURRENCY)
        rec.require('selected_country_preserved', rec.metrics['connected_country'] in ('EE', 'NO', 'AT'))
        rec.require('country_jobs_cleaned', country_active == 0)

    async def reserve_starvation(self, rec):
        refill_started = asyncio.Event()
        refresh_starts = []
        async def checker(item, countries, slow=False):
            refresh_starts.append(rec.now_ms())
            rec.event('reserve_checker_started')
            await asyncio.sleep(self.t['checker_s'])
            return self.proxy(item)
        async def discoverer(_):
            rec.event('refill_started')
            refill_started.set()
            try:
                await asyncio.sleep(self.t['blocked_refill_s'])
                return [], []
            except asyncio.CancelledError:
                rec.count('refill_cancelled')
                raise
        pool = self.pool(checker, discoverer, rec)
        pool.accept(self.proxy(self.a))
        task = asyncio.create_task(pool.run())
        try:
            await refill_started.wait()
            await asyncio.sleep(self.t['pool_observe_s'])
            now = pool.clock()
            ages = [(now - at) * 1000 for _, at in pool.entries.values()]
            rec.metrics.update({
                'reserve_check_count_before_observation': len(refresh_starts),
                'last_success_age_at_observation_ms': max(ages, default=None),
                'expired_stored_entries_at_observation': sum(age >= pool.ttl * 1000 for age in ages),
                'fresh_entries_at_observation': sum(age < pool.ttl * 1000 for age in ages),
                'refresh_start_gaps_ms': [b - a for a, b in zip(refresh_starts, refresh_starts[1:])],
                'observation_ms': rec.now_ms(),
            })
            # This check uses the existing public pruning operation only AFTER observing.
            pool.prune()
            rec.require('expired_entries_never_ready_after_prune', all(
                pool.clock() - at < pool.ttl for _, at in pool.entries.values()))
            rec.require('pool_capacity', len(pool.entries) <= pool.LIMIT)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        rec.metrics['checker_start_times_ms'] = refresh_starts
        rec.metrics['refill_cancelled'] = rec.counts.get('refill_cancelled', 0)

    async def reserve_hanging_first(self, rec):
        active_checks = max_checks = 0
        async def checker(item, countries, slow=False):
            nonlocal active_checks, max_checks
            active_checks += 1
            max_checks = max(active_checks, max_checks)
            rec.event('reserve_probe_started', endpoint='A' if item == self.a else 'B')
            try:
                await asyncio.sleep(self.t['hanging_reserve_s' if item == self.a else 'fast_reserve_s'])
                return None if item == self.a else self.proxy(item, 'EE')
            except asyncio.CancelledError:
                rec.count('probe_cancelled')
                raise
            finally:
                active_checks -= 1
        async def discoverer(_):
            rec.count('discoveries')
            return [], []
        # TTL must span the intentionally hanging probe, otherwise B expires before it can run.
        pool = self.pool(checker, discoverer, rec)
        pool.ttl = self.t['promotion_ttl_s']
        pool.accept(self.proxy(self.a, latency=1))
        pool.accept(self.proxy(self.b, 'EE', latency=2))
        result = await pool.take()
        rec.metrics.update({'native_selected_ms': rec.now_ms(), 'max_probe_concurrency': max_checks,
                            'browser_confirmed_ms': None})
        rec.require('B_returned', bool(result and result['host'] == self.b.host))
        rec.require('no_new_discovery', rec.counts.get('discoveries', 0) == 0)
        rec.require('probes_cleaned', active_checks == 0)
        rec.require('probe_concurrency_bounded', max_checks <= 2)

    async def fast_timeout_slow_success(self, rec):
        phases = []
        async def checker(item, countries, slow=False):
            phases.append('slow' if slow else 'fast')
            rec.event('checker_started', stage=phases[-1])
            await asyncio.sleep(self.t['slow_success_s' if slow else 'fast_timeout_s'])
            return self.proxy(item) if slow else None
        result = await self.core.scan([self.a], 'NO', lambda *_: None, checker=checker)
        rec.metrics.update({'native_selected_ms': rec.now_ms(), 'checker_phases': phases})
        rec.require('slow_retry_retained', phases == ['fast', 'slow'])
        rec.require('slow_success_found', bool(result and result['host'] == self.a.host))

    async def repeated_dead_scan(self, rec):
        candidates = [self.core.Candidate('http', '8.8.4.' + str(i + 1), 8000 + i)
                      for i in range(self.contract['counts']['dead_candidates'])]
        rounds = self.contract['counts']['dead_rounds']
        active = max_active = 0
        async def checker(item, countries, slow=False):
            nonlocal active, max_active
            rec.count('slow_checks' if slow else 'fast_checks')
            active += 1
            max_active = max(active, max_active)
            try:
                await asyncio.sleep(self.t['checker_s'])
                return None
            finally:
                active -= 1
        results = []
        for _ in range(rounds):
            before = sum(rec.counts.values())
            result = await self.core.scan(candidates, 'NO', lambda *_: None, checker=checker)
            results.append(sum(rec.counts.values()) - before)
            rec.require('all_dead_remain_rejected', result is None)
        rec.metrics.update({'repeated_scan_ms': rec.now_ms(), 'checks_per_round': results,
                            'max_probe_concurrency': max_active,
                            'history_warm_state': 'unsupported by scan API; no history injected'})
        rec.require('probes_cleaned', active == 0)
        rec.require('probe_concurrency_bounded', max_active <= self.core.SCAN_CONCURRENCY)

    async def discovery_cancel(self, rec):
        active = max_active = 0
        async def discovery(cc):
            nonlocal active, max_active
            active += 1
            max_active = max(active, max_active)
            try:
                rec.count('jobs_started')
                if cc == 'AT':
                    await asyncio.sleep(self.t['fast_feed_s'])
                    return [self.a], []
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                rec.count('jobs_cancelled')
                raise
            finally:
                active -= 1
        values, warnings = await self.core.discover_selection(
            ('AT', 'EE', 'NO'), discovery, shuffle=lambda values: None,
            budget=self.t['discovery_deadline_s'])
        rec.metrics.update({'discovery_return_ms': rec.now_ms(), 'warning_count': len(warnings),
                            'max_country_jobs': max_active})
        rec.require('completed_candidate_preserved', values == [self.a])
        rec.require('unfinished_jobs_cancelled', rec.counts.get('jobs_cancelled') == 2)
        rec.require('all_jobs_cleaned', active == 0)

    async def scan_bounds(self, rec):
        candidates = [self.core.Candidate('http', '8.8.' + str(i // 250) + '.' + str(i % 250 + 1), 8000)
                      for i in range(self.contract['counts']['scan_bound_candidates'])]
        active = maximum = 0
        seen = set()
        async def checker(item, country, slow=False):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            seen.add(item)
            rec.count('checks_started')
            try:
                await asyncio.sleep(self.t['checker_s'])
                return None
            finally:
                active -= 1
        await self.core.scan(candidates + candidates, 'NO', lambda *_: None, checker=checker, concurrency=100)
        rec.metrics.update({'scan_return_ms': rec.now_ms(), 'max_probe_concurrency': maximum,
                            'unique_candidates_checked': len(seen)})
        rec.require('cap_preserved', len(seen) <= self.core.CANDIDATE_LIMIT)
        rec.require('max_two_passes', rec.counts['checks_started'] <= 2 * self.core.CANDIDATE_LIMIT)
        rec.require('probe_concurrency_bounded', maximum <= self.core.SCAN_CONCURRENCY)
        rec.require('probes_cleaned', active == 0)

    async def idle_failure(self, rec, offset):
        """Native-only failure at a validated idle phase; no nudge/browser request."""
        first_health = asyncio.Event()
        recovered = asyncio.Event()
        failed = False
        connections = 0
        health_inflight = 0
        health_starts = 0
        session = None
        interval = self.t['session_health_interval_s']
        async def discovery(_):
            rec.count('discoveries')
            return [self.a], []
        async def checker(item, countries, slow=False):
            nonlocal health_inflight, health_starts
            rec.count('checks_started')
            is_health = item == self.a and connections > 0
            if is_health:
                health_inflight += 1
                health_starts += 1
            rec.event('checker_started', endpoint='active' if item == self.a else 'reserve',
                      stage='slow' if slow else 'fast', health=is_health,
                      available_at_start=not (failed and item == self.a))
            if is_health:
                rec.event('active_health_started', sequence=health_starts)
            try:
                await asyncio.sleep(self.t['checker_s'])
                unavailable = failed and item == self.a
                rec.event('checker_completed', endpoint='active' if item == self.a else 'reserve',
                          health=is_health, available=not unavailable)
                if unavailable:
                    rec.metrics.setdefault('first_failed_check_ms', rec.now_ms())
                    return None
                return self.proxy(item)
            except asyncio.CancelledError:
                rec.event('checker_cancelled', endpoint='active' if item == self.a else 'reserve',
                          health=is_health)
                raise
            finally:
                if is_health:
                    health_inflight -= 1
        def emit(event):
            nonlocal connections
            phase = event['phase']
            if phase == 'replacing':
                rec.metrics.setdefault('replacement_started_ms', rec.now_ms())
            if phase != 'connected':
                return
            connections += 1
            if connections == 1:
                session.pool.accept(self.proxy(self.b, latency=2))
                session.pool.accept(self.proxy(self.c, latency=3))
            elif event['proxy']['host'] == self.a.host and not failed:
                rec.metrics.setdefault('first_healthy_completion_ms', rec.now_ms())
                rec.metrics.setdefault('anchor_health_start_count', health_starts)
                rec.count('healthy_completions_before_failure')
                first_health.set()
            elif failed and event['proxy']['host'] != self.a.host:
                rec.metrics['native_connected_ms'] = rec.now_ms()
                recovered.set()
        def factory(*args):
            return self.pool_module.ReservePool(*args, ttl=self.t['idle_pool_ttl_s'],
                                               interval=interval, budget=self.t['idle_pool_budget_s'])
        session = self.core.Session('NO', emit, discovery, checker, interval=interval, pool_factory=factory)
        task = asyncio.create_task(session.run())
        try:
            await first_health.wait()
            anchor = rec.metrics['first_healthy_completion_ms']
            # Target a fixed point relative to the observed first healthy completion,
            # rather than sleeping a whole offset after arbitrary scheduler latency.
            target_ms = anchor + interval * offset * 1000
            await asyncio.sleep(max(0, (target_ms - rec.now_ms()) / 1000))
            injection_at = rec.now_ms()
            actual_offset = (injection_at - anchor) / (interval * 1000)
            lower, upper = self.contract['idle_phase_windows'][str(offset)]
            phase_valid = (lower <= actual_offset < upper and health_inflight == 0
                           and health_starts == rec.metrics['anchor_health_start_count']
                           and rec.counts.get('healthy_completions_before_failure') == 1)
            rec.metrics.update({'actual_failure_offset_fraction': actual_offset,
                                'health_inflight_at_injection': health_inflight,
                                'health_starts_at_injection': health_starts,
                                'phase_valid': phase_valid})
            rec.require('declared_idle_phase_observed', phase_valid)
            if not phase_valid:
                raise InvalidTrial('idle injection missed its frozen interval phase')
            failed = True
            rec.metrics['failure_injected_ms'] = injection_at
            rec.event('fixture_active_unavailable')
            await recovered.wait()
            rec.metrics['native_recovery_after_injection_ms'] = (
                rec.metrics['native_connected_ms'] - rec.metrics['failure_injected_ms'])
            rec.metrics['detection_after_injection_ms'] = (
                rec.metrics['first_failed_check_ms'] - rec.metrics['failure_injected_ms'])
            rec.metrics['native_selection_after_detection_ms'] = (
                rec.metrics['native_connected_ms'] - rec.metrics['first_failed_check_ms'])
            rec.metrics['confirmation_after_detection_ms'] = (
                rec.metrics['replacement_started_ms'] - rec.metrics['first_failed_check_ms'])
            rec.metrics['native_selection_after_replacement_ms'] = (
                rec.metrics['native_connected_ms'] - rec.metrics['replacement_started_ms'])
            rec.require('replacement_stays_selected_country', session.active['country'] == 'NO')
            rec.require('actual_replacement', session.active['host'] != self.a.host)
            rec.require('no_discovery_for_warm_reserve', rec.counts.get('discoveries') == 1)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        rec.metrics['failure_offset_fraction'] = offset
        rec.metrics['browser_confirmed_ms'] = None
        rec.require('pool_task_cleaned', session.pool_task is None)

    async def run(self, name, rec):
        if name in ('feed_cold', 'feed_warm'):
            return await self.feed(rec, name == 'feed_warm')
        offsets = {'idle_failure_after_health': 0, 'idle_failure_mid_interval': .5,
                   'idle_failure_before_health': .95}
        if name in offsets:
            return await self.idle_failure(rec, offsets[name])
        return await getattr(self, name)(rec)


async def run_trial(fixtures, name, index, deadline):
    rec = Recorder(name + ':' + str(index + 1))
    existing = asyncio.all_tasks()
    status, error = 'completed', None
    try:
        await asyncio.wait_for(fixtures.run(name, rec), deadline)
    except TimeoutError:
        status = 'timeout'
    except InvalidTrial as exc:
        status, error = 'invalid', str(exc)
    except Exception as exc:
        status, error = 'error', type(exc).__name__ + ': ' + str(exc)
    elapsed = rec.now_ms()
    # A completed API must leave no owned background task. Clean up even failing trials.
    leaked = [task for task in asyncio.all_tasks() - existing if not task.done()]
    rec.require('no_leaked_tasks', not leaked)
    for task in leaked:
        task.cancel()
    await asyncio.gather(*leaked, return_exceptions=True)
    return {'attempt_id': rec.attempt_id, 'status': status, 'error': error,
            'elapsed_ms': elapsed, 'timeout_lower_bound_ms': deadline * 1000 if status == 'timeout' else None,
            'invariants_ok': all(rec.invariants.values()), 'invariants': rec.invariants,
            'metrics': rec.metrics, 'counts': rec.counts, 'events': rec.events,
            'leaked_task_count': len(leaked)}


def forbidden(*args, **kwargs):
    raise AssertionError('Network/subprocess access is forbidden in the offline benchmark')


async def benchmark(root, contract, repeats, selected):
    core, pool, sources = load_product(root)
    fixtures = Fixtures(core, pool, sources, contract)
    results = {}
    # Guard AFTER the event loop creates its local wakeup socket. No real request may escape.
    with ExitStack() as stack:
        for obj, name in ((core, 'curl'), (core, 'process'), (asyncio, 'create_subprocess_exec'),
                          (asyncio, 'create_subprocess_shell'), (socket.socket, 'connect'),
                          (socket.socket, 'connect_ex'), (socket, 'create_connection')):
            stack.enter_context(patch.object(obj, name, forbidden))
        for name in selected:
            trials = [await run_trial(fixtures, name, n, contract['trial_deadline_s']) for n in range(repeats)]
            results[name] = {'summary': summarize(trials), 'trials': trials}
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--contract', required=True, type=Path)
    parser.add_argument('--repeats', type=int, default=20)
    parser.add_argument('--case', action='append', choices=CASE_NAMES)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    if not 1 <= args.repeats <= 100:
        parser.error('--repeats must be 1..100')
    contract = json.loads(args.contract.read_text())
    validate_contract(contract)
    if args.repeats >= 20 and contract.get('frozen') is not True:
        parser.error('Freeze the contract before a full baseline run')
    root = args.root.resolve()
    source_paths = ['native/core.py', 'native/pool.py', 'native/sources.py', 'extension/countries.json']
    before = {name: sha256(root / name) for name in source_paths}
    cases = args.case or contract['cases']
    results = asyncio.run(benchmark(root, contract, args.repeats, cases))
    after = {name: sha256(root / name) for name in source_paths}
    report = {
        'schema': SCHEMA, 'created_at_utc': datetime.now(timezone.utc).isoformat(),
        'scope': contract['scope'], 'root': str(root), 'source_hashes': before,
        'source_unchanged': before == after, 'harness_sha256': sha256(Path(__file__)),
        'contract_sha256': sha256(args.contract), 'contract': contract,
        'runtime': {'python': platform.python_version(), 'platform': platform.platform(),
                    'clock': 'time.monotonic; one process', 'machine': platform.machine()},
        'repeats': args.repeats, 'cases': results,
        'unsupported_metrics': contract['unsupported'],
        'functional_acceptance': 'not assessed; this is a synthetic baseline observer',
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    failed = any(value['summary']['n_error'] or value['summary']['n_timeout'] or value['summary']['n_invalid'] or
                 value['summary']['n_invariant_failure'] for value in results.values())
    print(json.dumps({'output': str(args.output), 'cases': len(results), 'repeats': args.repeats,
                      'source_unchanged': before == after, 'harness_checks_ok': not failed}))
    return 1 if failed or before != after else 0


if __name__ == '__main__':
    sys.exit(main())
