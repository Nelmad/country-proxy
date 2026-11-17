#!/usr/bin/env python3
"""Paired offline actual-Session benchmark; injected checks never access a network."""
import argparse
import asyncio
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def quantiles(values):
    values = sorted(values)
    return {name: values[max(0, math.ceil(len(values) * fraction) - 1)]
            for name, fraction in [('p50', .5), ('p95', .95)]}


async def worker(root, repeats):
    sys.path.insert(0, str(root / 'native'))
    from core import Candidate, Session
    from sources import SourceBatch
    enabled = (root / 'native' / 'history.py').is_file()
    if enabled:
        from history import EndpointHistory
    attempts, recovery_ms, admitted = [], [], []
    successes = 0
    for _ in range(repeats):
        logical_clock = [1000.]
        # Twelve equally replayed stale endpoints; the first recovers only in
        # round four. Every repeat uses precisely the same source/check schedule.
        candidates = [Candidate('http', f'8.1.0.{i + 1}', 3128) for i in range(12)]
        round_number = [0]
        async def source(_):
            yield SourceBatch('fixture', 'fixture', tuple(candidates), None, 1000., True)
        async def check(candidate, cc, slow):
            await asyncio.sleep(0)
            if round_number[0] == 4 and candidate == candidates[0]:
                return {'scheme': candidate.scheme, 'host': candidate.host,
                        'port': candidate.port, 'country': 'NO', 'exitIp': '9.9.9.9',
                        'latencyMs': 1, 'checkedAt': 1061000}
        kwargs = {'history': EndpointHistory(clock=lambda: logical_clock[0],
                    wall_clock=lambda: logical_clock[0], jitter=lambda: 0)} if enabled else {}
        session = Session('NO', lambda _: None, checker=check, source_stream=source,
                          source_groups=['fixture'], shuffle=lambda _: None, **kwargs)
        session.search.cap = 12
        stages = []
        try:
            for number, timestamp in enumerate((1000., 1010., 1020., 1061.), 1):
                logical_clock[0] = timestamp
                round_number[0] = number
                started = time.monotonic()
                if enabled:
                    result, _ = await asyncio.wait_for(session.search.run_round(
                        session.scan_report, session.eligible, concurrency=1,
                        on_terminal=session.remember_check), 2)
                else:
                    result, _ = await asyncio.wait_for(session.search.run_round(
                        session.checked, session.eligible, concurrency=1), 2)
                elapsed = (time.monotonic() - started) * 1000
                stages.append(session.search.last_stats['admissions'])
                if number < 4:
                    assert result is None
                else:
                    assert result and result['country'] == 'NO' and result['host'] == candidates[0].host
                    assert elapsed < 2000
                    recovery_ms.append(elapsed)
                    successes += 1
            attempts.append(session.diagnostics['attempts'])
            admitted.append(stages)
            assert not session.excluded, 'scan history must not create host bans'
        finally:
            await session.check_budget.close()
            session.search.clear_pending()
    assert len(set(attempts)) == 1 and all(a == admitted[0] for a in admitted)
    return {'repeats': repeats, 'native_recovery_successes': successes,
            'recovery_deadline_ms': 2000, 'recovery_latency_ms': quantiles(recovery_ms),
            'physical_checks_per_repeat': attempts[0], 'physical_checks_total': sum(attempts),
            'admissions_per_round': admitted[0],
            'source_sha256': hashlib.sha256(''.join(
                path.name + ':' + digest(path) + '\n'
                for path in sorted((root / 'native').glob('*.py'))).encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--before', type=Path)
    parser.add_argument('--after', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path)
    parser.add_argument('--repeats', type=int, default=20)
    parser.add_argument('--worker-root', type=Path)
    args = parser.parse_args()
    if args.worker_root:
        print(json.dumps(asyncio.run(worker(args.worker_root.resolve(), args.repeats))))
        return
    if not args.before or not args.output:
        parser.error('--before and --output required')
    summaries = {}
    for label, root in [('before', args.before), ('after', args.after)]:
        completed = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()),
            '--worker-root', str(root.resolve()), '--repeats', str(args.repeats)],
            text=True, check=True, capture_output=True, timeout=60)
        summaries[label] = json.loads(completed.stdout)
    before, after = summaries['before'], summaries['after']
    assert after['physical_checks_total'] < before['physical_checks_total']
    assert after['native_recovery_successes'] == before['native_recovery_successes'] == args.repeats
    assert after['recovery_latency_ms']['p95'] <= before['recovery_latency_ms']['p95'] + 100
    result = {'schema_version': 1, 'harness_sha256': digest(Path(__file__)),
              'scenario': '3 repeated dead rounds, same endpoint recovers at logical t=61s',
              'conditions': 'offline injected checker; actual Session/StreamSearch/CheckBudget; concurrency=1; no Chrome/HTTPS claim',
              'quantile_method': 'nearest-rank, successful native latency only; failures asserted separately',
              **summaries, 'gate': 'PASS'}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
