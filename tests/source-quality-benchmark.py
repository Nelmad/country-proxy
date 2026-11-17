#!/usr/bin/env python3
"""Offline Session/StreamSearch experiment. Never imports experimental policy into runtime.

The manifest is fixed before training; holdout outcomes never update scores. Worker
processes prevent before/after module contamination. Checks are synthetic, not
HTTPS or Chrome evidence. No-data is reported as absent opportunity, not failure.
"""
import argparse
import asyncio
from collections import Counter
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import random
import socket
import subprocess
import sys
import time
from unittest.mock import patch

GROUPS = ['alpha', 'beta', 'gamma', 'delta']
MANIFEST = {
    'schema': 1, 'cap': 48, 'concurrency': 4, 'deadline_s': 2,
    'discovery_budget_s': .03, 'repeats': 20, 'late_source_event_loop_yields': 12,
    'train': ['train_alpha', 'train_alpha_mirror'],
    'holdout': ['stationary', 'junk_mirrors', 'rare_country', 'quality_changed',
                'source_recovery', 'late_source', 'zero_data'],
    'variants': ['original', 'reversed', 'iso_renamed'],
    'score_scope': 'per requested country role: unique native-qualified return / physical checks; experimental yield, distinct from displayed fair endpoint shares',
    'candidate': 'alternate normal provider tickets: uniform / frozen training-best; preserve country and every-fifth exploration tickets',
    'alternative': 'uniform tickets; try training-best ready provider first, with native exploration unchanged',
    'good_indices': {
        'train_alpha': {'alpha': list(range(16)), 'beta': [0]},
        'train_alpha_mirror': {'alpha': list(range(16)), 'beta': [0]},
        'stationary': {'alpha': list(range(16)), 'beta': [0]},
        'junk_mirrors': {'alpha': list(range(16))},
        'rare_country': {'alpha': list(range(16)), 'delta': [3]},
        'quality_changed': {'gamma': list(range(16))},
        'source_recovery': {'delta': [3, 4]},
        'late_source': {'beta': list(range(16))},
        'zero_data': {},
    },
    'size': 40,
    'gate': 'reject if ANY paired holdout loses native-qualified endpoint or country coverage, exploration, adds physical checks before first detection, or introduces timeout/invariant failure; no-data is neutral',
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def quantiles(values):
    values = sorted(values)
    if not values:
        return {'n': 0, 'p50': None, 'p95': None}
    import math
    return {'n': len(values), 'p50': values[math.ceil(len(values) * .5) - 1],
            'p95': values[math.ceil(len(values) * .95) - 1]}


async def worker(root, repeats):
    loaded_source_sha256 = digest({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((root / 'native').glob('*.py'))})
    sys.path.insert(0, str(root / 'native'))
    from core import Candidate, Session
    from history import EndpointHistory
    from sources import SourceBatch
    import stream_search as module
    original_grant = module._Round._grant
    original_next = module._Round._next

    async def trial(case, seed, variant, policy, best):
        # Semantic country roles are invariant under ISO rename and user reversal.
        labels = ['EE', 'NO'] if variant != 'iso_renamed' else ['JP', 'BR']
        role = {cc: i for i, cc in enumerate(labels)}
        selected = labels[::-1] if variant == 'reversed' else labels[:]
        rng = random.Random(seed)
        country_order = [0, 1]
        group_order = GROUPS[:]
        rng.shuffle(country_order)
        rng.shuffle(group_order)
        def shuffle(values):
            values[:] = (sorted(values, key=lambda cc: country_order.index(role[cc]))
                         if values and values[0] in role else group_order[:])
        lookup = {}
        items = {}
        for ci, cc in enumerate(labels):
            for gi, group in enumerate(GROUPS):
                row = []
                for index in range(MANIFEST['size']):
                    candidate = Candidate('http', f'8.{ci + 1}.{gi + 1}.{index + 1}', 3128)
                    row.append(candidate)
                    lookup[candidate.key] = (ci, group, index)
                items[cc, group] = row
        async def source(cc):
            for group in GROUPS:
                if case == 'zero_data':
                    row = []
                else:
                    row = items[cc, group]
                if case == 'late_source' and group == 'beta':
                    for _ in range(MANIFEST['late_source_event_loop_yields']):
                        await asyncio.sleep(0)
                # Mirrors carry the same provider identity and duplicate keys.
                if case in ('junk_mirrors', 'train_alpha_mirror') and group == 'alpha':
                    yield SourceBatch(group, 'mirror-one', tuple(row * 3), None, 1000., False)
                    yield SourceBatch(group, 'mirror-two', tuple(row), None, 1000., True)
                else:
                    yield SourceBatch(group, group, tuple(row), None, 1000., True)
        physical = []
        detections = []
        active = set()
        peak = 0
        started = time.monotonic()
        async def checker(item, countries, slow):
            nonlocal peak
            assert item.key not in active, 'overlapping physical endpoint check'
            active.add(item.key)
            peak = max(peak, len(active))
            ci, group, index = lookup[item.key]
            physical.append((ci, group, index, slow))
            physical_ordinal = len(physical)
            try:
                await asyncio.sleep(0)
                good = index in MANIFEST['good_indices'][case].get(group, [])
                if case == 'rare_country' and ci == 1:
                    good = group == 'delta' and index == 3
                if good:
                    detections.append({'role': ci, 'group': group, 'index': index,
                                       'physical_ordinal': physical_ordinal,
                                       'at_ms': (time.monotonic() - started) * 1000})
                    return {'scheme': item.scheme, 'host': item.host, 'port': item.port,
                            'country': labels[ci], 'exitIp': item.host,
                            'latencyMs': 1, 'checkedAt': 1000000}
            finally:
                active.remove(item.key)
        history = EndpointHistory(clock=lambda: 1000., wall_clock=lambda: 1000., jitter=lambda: 0)
        session = Session(selected, lambda _: None, checker=checker, source_stream=source,
                          source_groups=GROUPS, shuffle=shuffle, history=history)
        session.search.cap = MANIFEST['cap']
        session.search.discovery_budget = MANIFEST['discovery_budget_s']
        def grant(round_, cc):
            s = round_.s
            # Native uniform grant advances country/exploration counters first.
            before = dict(round_.credits[cc])
            cursor = s.group_credit_cursor[cc]
            original_grant(round_, cc)
            changed = next((g for g in s.groups if round_.credits[cc][g] > before[g]), None)
            if changed is not None:
                turns = getattr(round_, '_experimental_turns', Counter())
                turns[cc] += 1
                round_._experimental_turns = turns
                if turns[cc] % 2 == 0:
                    round_.credits[cc][changed] -= 1
                    round_.credits[cc][best[role[cc]]] += 1
                    # The continuing UNIFORM ring advances only on uniform turns.
                    s.group_credit_cursor[cc] = cursor
        def next_probe(round_):
            for cc in round_.s.countries:
                round_.s.group_cursor[cc] = round_.s.groups.index(best[role[cc]])
            return original_next(round_)
        timed_out = False
        error = None
        with ExitStack() as stack:
            if policy == 'weighted':
                stack.enter_context(patch.object(module._Round, '_grant', grant))
            if policy == 'probe_order':
                stack.enter_context(patch.object(module._Round, '_next', next_probe))
            try:
                await asyncio.wait_for(session.search.run_round(session.scan_report,
                    session.eligible, on_result=lambda _: False,
                    concurrency=MANIFEST['concurrency'], on_terminal=session.remember_check),
                    MANIFEST['deadline_s'])
            except asyncio.TimeoutError:
                timed_out = True
            except Exception as exc:
                error = type(exc).__name__ + ': ' + str(exc)
            finally:
                await session.check_budget.close()
        observations = session.search.last_observations
        admissions = Counter(o['requestedCountry'] for o in observations)
        providers = Counter(g for ci, g, index, slow in physical if not slow)
        terminals = Counter((ci, group, index) for ci, group, index, slow in physical)
        unique_successes = {(d['role'], d['group'], d['index']) for d in detections}
        invariant = (not active and peak <= MANIFEST['concurrency'] and
                     len(observations) <= MANIFEST['cap'] and
                     len(terminals) == len(observations) and
                     all(count <= 2 for count in terminals.values()) and
                     len(set(admissions.values())) <= 1 and
                     sum(session.diagnostics['failures'].values()) + session.diagnostics['passed'] == len(physical))
        result = {'case': case, 'seed': seed, 'variant': variant, 'policy': policy,
                  'timeout': timed_out, 'error': error, 'invariants_ok': invariant,
                  'admissions': {str(role[cc]): admissions[cc] for cc in labels},
                  'provider_checks': dict(providers), 'physical_checks': len(physical),
                  'detected': [list(x) for x in sorted(unique_successes)],
                  'coverage': sorted({d[0] for d in unique_successes}),
                  'first_detection_ms': detections[0]['at_ms'] if detections else None,
                  'first_detection_physical_ordinal': detections[0]['physical_ordinal'] if detections else None,
                  'success_by_provider': dict(Counter(d[1] for d in unique_successes)),
                  'physical_by_provider': dict(Counter(g for _, g, _, _ in physical)),
                  'success_by_country_provider': {str(ci): dict(Counter(g for c, g, _ in unique_successes if c == ci)) for ci in (0, 1)},
                  'physical_by_country_provider': {str(ci): dict(Counter(g for c, g, _, _ in physical if c == ci)) for ci in (0, 1)},
                  'opportunity': case != 'zero_data',
                  'exploration_admissions': len(observations),
                  'native_stats': session.search.last_stats}
        # All endpoints are initially new: every admitted endpoint is exploration
        # eligible. Native reserved exploration logic is executed unchanged in all modes.
        session.search.clear_pending()
        return result

    training = []
    for case in MANIFEST['train']:
        for seed in range(repeats):
            training.append(await trial(case, seed, 'original', 'uniform', 'alpha'))
    scores, best = {}, {}
    for ci in (0, 1):
        success, checks = Counter(), Counter()
        for row in training:
            success.update(row['success_by_country_provider'][str(ci)])
            checks.update(row['physical_by_country_provider'][str(ci)])
        scores[ci] = {g: success[g] / checks[g] if checks[g] else None for g in GROUPS}
        best[ci] = max(GROUPS, key=lambda g: scores[ci][g] if scores[ci][g] is not None else -1)
    rows = []
    for case in MANIFEST['holdout']:
        for seed in range(repeats):
            for variant in MANIFEST['variants']:
                for policy in ('uniform', 'weighted', 'probe_order'):
                    rows.append(await trial(case, seed, variant, policy, best))
    paired = {(r['case'], r['seed'], r['variant'], r['policy']): r for r in rows}
    harms = {p: [] for p in ('weighted', 'probe_order')}
    benefits = {p: [] for p in harms}
    for row in rows:
        if row['policy'] == 'uniform':
            continue
        before = paired[row['case'], row['seed'], row['variant'], 'uniform']
        lost = set(map(tuple, before['detected'])) - set(map(tuple, row['detected']))
        gained = set(map(tuple, row['detected'])) - set(map(tuple, before['detected']))
        reasons = []
        if lost:
            reasons.append('lost_native_qualified_endpoints')
        if set(before['coverage']) - set(row['coverage']):
            reasons.append('lost_country_coverage')
        if (row['first_detection_physical_ordinal'] is not None and
                before['first_detection_physical_ordinal'] is not None and
                row['first_detection_physical_ordinal'] > before['first_detection_physical_ordinal']):
            reasons.append('extra_physical_work_before_first_detection')
        if (row['timeout'] and not before['timeout']) or row['error'] or not row['invariants_ok']:
            reasons.append('timeout_error_or_invariant')
        if reasons:
            harms[row['policy']].append({'case': row['case'], 'seed': row['seed'], 'variant': row['variant'],
                                         'reasons': reasons, 'lost': len(lost), 'gained': len(gained)})
        if gained:
            benefits[row['policy']].append({'case': row['case'], 'seed': row['seed'], 'variant': row['variant'],
                                            'gained': len(gained), 'lost': len(lost)})
    metamorphic = []
    for row in rows:
        original = paired[row['case'], row['seed'], 'original', row['policy']]
        fields = ('admissions', 'provider_checks', 'physical_checks', 'detected', 'coverage')
        if any(row[k] != original[k] for k in fields):
            metamorphic.append({k: row[k] for k in ('case', 'seed', 'variant', 'policy')})
    summary = {}
    for case in MANIFEST['holdout']:
        summary[case] = {}
        for policy in ('uniform', 'weighted', 'probe_order'):
            subset = [r for r in rows if r['case'] == case and r['policy'] == policy]
            summary[case][policy] = {'trials': len(subset),
                'detected_total': sum(len(r['detected']) for r in subset),
                'covered_country_total': sum(len(r['coverage']) for r in subset),
                'physical_checks_total': sum(r['physical_checks'] for r in subset),
                'timeouts': sum(r['timeout'] for r in subset),
                'invariant_failures': sum(not r['invariants_ok'] or bool(r['error']) for r in subset),
                'first_detection_physical_ordinal': quantiles([r['first_detection_physical_ordinal'] for r in subset if r['first_detection_physical_ordinal'] is not None]),
                'first_detection_ms': quantiles([r['first_detection_ms'] for r in subset if r['first_detection_ms'] is not None])}
    final_source_sha256 = digest({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((root / 'native').glob('*.py'))})
    assert loaded_source_sha256 == final_source_sha256, 'native sources changed during measurement; rerun stable snapshot'
    return {'manifest_sha256': digest(MANIFEST), 'scores': scores, 'training_best': best,
            'summary': summary, 'harmful_pairs': harms, 'beneficial_pairs': benefits,
            'metamorphic_failures': metamorphic,
            'decision': {p: 'uniform' if harms[p] or metamorphic else p for p in harms},
            'rows': rows,
            'source_sha256': loaded_source_sha256}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path)
    parser.add_argument('--after', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path)
    parser.add_argument('--worker-root', type=Path)
    parser.add_argument('--repeats', type=int, default=MANIFEST['repeats'])
    args = parser.parse_args()
    if args.worker_root:
        # Fail closed if accidental fixture changes try to reach a network.
        def deny(*a, **kw):
            raise AssertionError('network forbidden in source-quality benchmark')
        with patch.object(socket.socket, 'connect', deny), patch.object(socket, 'create_connection', deny):
            print(json.dumps(asyncio.run(worker(args.worker_root.resolve(), args.repeats))))
        return
    if not args.before or not args.output:
        parser.error('--before and --output required')
    # Write a frozen schedule receipt BEFORE running either training or holdout.
    receipt = args.output.with_suffix('.manifest.json')
    receipt.write_text(json.dumps({'manifest': MANIFEST, 'sha256': digest(MANIFEST),
        'harness_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}, indent=2) + '\n')
    results = {}
    for label, root in [('before', args.before), ('after', args.after)]:
        proc = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()),
            '--worker-root', str(root.resolve()), '--repeats', str(args.repeats)],
            text=True, capture_output=True, check=True, timeout=120)
        results[label] = json.loads(proc.stdout)
    before_uniform = [r for r in results['before']['rows'] if r['policy'] == 'uniform']
    after_uniform = [r for r in results['after']['rows'] if r['policy'] == 'uniform']
    fields = ('case', 'seed', 'variant', 'timeout', 'error', 'invariants_ok', 'admissions',
              'provider_checks', 'physical_checks', 'detected', 'coverage')
    parity = all(all(a[k] == b[k] for k in fields) for a, b in zip(before_uniform, after_uniform))
    result = {'schema': 1, 'harness_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'manifest_sha256': digest(MANIFEST), 'actual_repeats': args.repeats,
              'conditions': 'actual Session/StreamSearch/CheckBudget, injected offline source/checker; full-round detection; no HTTPS/Chrome performance claim',
              'uniform_before_after_parity': parity, **results}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    assert parity and len(before_uniform) == len(after_uniform), 'selected uniform before/after parity failed'
    assert all(not r['timeout'] and not r['error'] and r['invariants_ok'] for r in before_uniform + after_uniform), 'selected uniform baseline/candidate failed'
    assert all(not any(r['policy'] == 'uniform' for r in results[label]['metamorphic_failures']) for label in ('before', 'after')), 'selected uniform metamorphic counterexample'
    print(json.dumps({k: v for k, v in result.items() if k not in ('before', 'after')}, indent=2))
    for label, value in results.items():
        print(label, json.dumps({'decision': value['decision'], 'harmful_pairs': {p: len(x) for p, x in value['harmful_pairs'].items()}, 'metamorphic_failures': len(value['metamorphic_failures'])}))


if __name__ == '__main__':
    main()
