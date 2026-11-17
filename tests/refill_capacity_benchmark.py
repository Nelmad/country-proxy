#!/usr/bin/env python3
"""Offline timing of actual Session reserve admission; fake checks are synthetic.

Run this SAME file with --root pointing at each preserved production snapshot.
No scheduler, pool, checker budget, concurrency or timeout is replaced. Only the
documented Session source/checker injection points provide deterministic input.
"""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time


CONFIG = {
    'schema': 1,
    'repeats': 20,
    'trial_deadline_s': 2.0,
    'cold_state': 'new Session, empty history/search/pool, active budget each trial',
    'source': {'country': 'SE', 'group': 'synthetic-fixed', 'fetched_at': 1700000000.0},
    'shuffle': 'identity via supported Session injection',
    'latency': 'pool._refill entry -> actual reserveCount admission event',
    'quantile': 'nearest rank, successful trials only',
    'comparison_tolerance': {'absolute_ms': 100, 'relative': 0.10},
    'scenarios': [
        {'name': 'queued_fast_valid', 'checks': [[100, False]] * 6 + [[10, True]]},
        {'name': 'queued_slow_valid', 'checks': [[100, False]] * 6 + [[140, True]]},
        {'name': 'front_slow_valid', 'checks': [[140, True]] + [[10, False]] * 6},
        # Both reserves fill, after all unavailable checks have naturally ended.
        {'name': 'queued_two_reserves', 'checks': [[100, False]] * 6 + [[110, True], [130, True]]},
    ],
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def no_network_audit(event, args):
    if event in {'socket.connect', 'socket.connect_ex', 'socket.getaddrinfo',
                 'socket.gethostbyname', 'socket.sendto', 'subprocess.Popen', 'os.system'}:
        raise RuntimeError(f'offline benchmark forbids {event}')


def latency_summary(values):
    ordered = sorted(values)
    def rank(q):
        return ordered[math.ceil(q * len(ordered)) - 1] if ordered else None
    return {'successful_n': len(ordered), 'p50_ms': rank(.50), 'p95_ms': rank(.95),
            'max_ms': ordered[-1] if ordered else None}


async def trial(Session, Candidate, SourceBatch, scenario, repeat):
    loop = asyncio.get_running_loop()
    items = [Candidate('http', f'192.0.2.{n + 1}', 8000 + n)
             for n in range(len(scenario['checks']))]
    plan = {item.key: spec for item, spec in zip(items, scenario['checks'])}
    expected = [item.key for item in items if plan[item.key][1]]
    started, finished, cancelled = [], [], []
    admissions = []
    snapshots = []
    session = None
    began = None

    def proxy(item, delay_ms):
        return {'scheme': item.scheme, 'host': item.host, 'port': item.port,
                'country': 'SE', 'exitIp': item.host, 'latencyMs': delay_ms,
                'checkedAt': 1700000000000}

    async def source(country):
        if country != 'SE':
            raise AssertionError('unexpected synthetic source country')
        yield SourceBatch(CONFIG['source']['group'], 'synthetic-no-network', tuple(items),
                          None, CONFIG['source']['fetched_at'], True)

    async def checker(item, country, slow):
        if country != 'SE' or slow is not True:
            raise AssertionError('refill must use actual slow-only check path')
        delay_ms, valid = plan[item.key]
        started.append(item.key)
        snapshots.append(session.check_budget.snapshot)
        try:
            await asyncio.sleep(delay_ms / 1000)
        except asyncio.CancelledError:
            cancelled.append(item.key)
            raise
        finished.append(item.key)
        return proxy(item, delay_ms) if valid else None

    def emit(event):
        if began is not None and event.get('phase') == 'pool':
            count = event.get('reserveCount', 0)
            if count > len(admissions):
                admissions.append({'count': count, 'latency_ms': (loop.time() - began) * 1000})

    session = Session('SE', emit, checker=checker, source_stream=source,
                      source_groups=(CONFIG['source']['group'],), shuffle=lambda values: None)
    session.active = proxy(Candidate('http', '198.51.100.250', 9000), 1)
    await session.check_budget.set_active(True)
    status = 'success'
    problem = None
    actual = []
    stats = {}
    counts = {}
    diagnostics = {}
    round_ms = None
    budget_final = None
    try:
        began = loop.time()
        try:
            async with asyncio.timeout(CONFIG['trial_deadline_s']):
                await session.pool._refill()
            round_ms = (loop.time() - began) * 1000
        except TimeoutError:
            status, problem = 'timeout', '>trial_deadline_s (right-censored)'
        actual = list(session.pool.entries)
        stats = dict(session.search.last_stats)
        counts = dict(session.pool.counts)
        diagnostics = dict(session.diagnostics)
        budget_final = session.check_budget.snapshot
        if status == 'success':
            obligations = {
                'actual_pool_entries_match_successes': actual == expected,
                'actual_admissions_observed': len(admissions) == len(expected),
                'pool_counts_actual_added': counts.get('added') == len(expected),
                'every_candidate_started_once_in_fixed_order': started == [item.key for item in items],
                'every_slow_candidate_completed': sorted(finished) == sorted(started),
                'no_check_cancelled': not cancelled and counts.get('cancelled', 0) == 0,
                'production_scheduler_admitted_all': stats.get('admissions') == len(items),
                'production_scheduler_slow_only': stats.get('slow') == len(items) and stats.get('fast') == 0,
                'actual_budget_active': all(s['active'] for s in snapshots),
                'total_check_cap': all(s['running'] <= 10 for s in snapshots),
                'speculative_lane_cap': all(s['roles']['speculative'] <= 7 for s in snapshots),
                'pool_capacity': len(actual) <= session.pool.LIMIT == 2,
                'drained_budget': budget_final['requests'] == budget_final['running'] == 0,
                'drained_pool_probes': not session.pool._probes,
                'physical_outcomes_exact': diagnostics == {
                    'attempts': len(items), 'passed': len(expected),
                    'failures': {'unavailable': len(items) - len(expected)}},
            }
            failed = [key for key, ok in obligations.items() if not ok]
            if failed:
                status, problem = 'failure', ', '.join(failed)
    except Exception as exc:
        status, problem = 'failure', f'{type(exc).__name__}: {exc}'
    finally:
        await session.check_budget.close()
        session.search.clear_pending()
    return {
        'repeat': repeat, 'status': status, 'problem': problem,
        'first_admission_ms': admissions[0]['latency_ms'] if status == 'success' else None,
        'last_admission_ms': admissions[-1]['latency_ms'] if status == 'success' else None,
        'round_ms': round_ms if status == 'success' else None,
        'admissions': admissions, 'actual_pool_keys': actual,
        'started_order': started, 'finished_order': finished, 'cancelled': cancelled,
        'peak_physical_checks': max((s['running'] for s in snapshots), default=0),
        'peak_speculative_checks': max((s['roles']['speculative'] for s in snapshots), default=0),
        'stream_stats': stats, 'pool_counts': counts,
        'physical_outcomes': diagnostics, 'final_budget': budget_final,
    }


async def benchmark(root):
    sys.path.insert(0, str(root / 'native'))
    from core import Candidate, Session
    from sources import SourceBatch
    results = []
    for scenario in CONFIG['scenarios']:
        runs = [await trial(Session, Candidate, SourceBatch, scenario, repeat)
                for repeat in range(1, CONFIG['repeats'] + 1)]
        successful = [run for run in runs if run['status'] == 'success']
        result = {
            'scenario': scenario['name'], 'attempted_n': len(runs),
            'failures': sum(run['status'] == 'failure' for run in runs),
            'timeouts': sum(run['status'] == 'timeout' for run in runs),
            'first_admission': latency_summary([run['first_admission_ms'] for run in successful]),
            'last_admission': latency_summary([run['last_admission_ms'] for run in successful]),
            'round_completion': latency_summary([run['round_ms'] for run in successful]),
            'expected_synthetic_endpoint_failures_per_trial': sum(not spec[1] for spec in scenario['checks']),
            'max_physical_checks': max(run['peak_physical_checks'] for run in runs),
            'max_speculative_checks': max(run['peak_speculative_checks'] for run in runs),
            'runs': runs,
        }
        results.append(result)
        print(json.dumps({key: value for key, value in result.items() if key != 'runs'}), flush=True)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    files = ['native/core.py', 'native/pool.py', 'native/stream_search.py',
             'native/check_budget.py', 'native/history.py', 'native/source_quality.py',
             'native/sources.py', 'extension/countries.json']
    source_hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}
    sys.addaudithook(no_network_audit)
    results = asyncio.run(benchmark(root))
    report = {
        'schema': 1, 'claim_scope': 'offline synthetic native reserve admission only; no HTTPS/Chrome claim',
        'root': str(root), 'harness_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'config_sha256': digest(CONFIG), 'source_hashes': source_hashes,
        'source_manifest_sha256': digest(source_hashes), 'config': CONFIG,
        'environment': {'python': sys.version, 'platform': tuple(os.uname()),
                        'monotonic': vars(time.get_clock_info('monotonic'))},
        'network_guard': 'Python audit blocks connect/name lookup/sendto/subprocess',
        'results': results,
    }
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    return int(any(result['failures'] or result['timeouts'] for result in results))


if __name__ == '__main__':
    raise SystemExit(main())
