"""Checks that the observer cannot turn censored/failing trials into successful latency."""
import asyncio
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
MODULE = HERE / 'recovery_benchmark.py'
if not MODULE.is_file():
    MODULE = HERE.parent / 'scripts/recovery_benchmark.py'
spec = importlib.util.spec_from_file_location('recovery_benchmark', MODULE)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def trial(status='completed', elapsed=1, invariants=True):
    return {'status': status, 'elapsed_ms': elapsed, 'invariants_ok': invariants, 'metrics': {}}


class StatisticsTests(unittest.TestCase):
    def test_nearest_rank(self):
        values = list(range(1, 21))
        self.assertEqual(bench.percentile(values), 19)
        self.assertEqual(bench.percentile([]), None)

    def test_censored_tail_does_not_become_finite_p95(self):
        summary = bench.summarize([trial(elapsed=i) for i in range(18)] +
                                  [trial('timeout', 2000), trial('timeout', 2000)])
        self.assertEqual(summary['n_completed'], 18)
        self.assertEqual(summary['n_timeout'], 2)
        self.assertIsNone(summary['all_trial_p95_ms'])
        self.assertTrue(summary['all_trial_p95_censored_or_failed'])
        self.assertEqual(summary['completed_latency_ms']['n'], 18)
        self.assertLess(summary['completed_latency_ms']['p95_nearest_rank'], 2000)

    def test_one_timeout_is_counted_even_when_p95_finite(self):
        summary = bench.summarize([trial(elapsed=i) for i in range(1, 20)] + [trial('timeout', 2000)])
        self.assertEqual(summary['all_trial_p95_ms'], 19)
        self.assertEqual(summary['n_timeout'], 1)
        self.assertEqual(summary['n_total'], 20)

    def test_errors_and_invariant_failure_remain_visible(self):
        summary = bench.summarize([trial('error', 999), trial(invariants=False)])
        self.assertEqual(summary['n_error'], 1)
        self.assertEqual(summary['n_invariant_failure'], 1)
        self.assertEqual(summary['completed_latency_ms']['n'], 0)

    def test_repeated_invariant_cannot_erase_an_earlier_failure(self):
        recorder = bench.Recorder('invariant:1')
        recorder.require('coverage', True)
        recorder.require('coverage', False)
        recorder.require('coverage', True)
        self.assertFalse(recorder.invariants['coverage'])

    def test_wall_clock_does_not_define_elapsed(self):
        with patch.object(bench.time, 'time', side_effect=AssertionError('wall clock accessed')):
            recorder = bench.Recorder('clock:1')
            recorder.event('before')
            recorder.event('after')
        self.assertGreaterEqual(recorder.events[1]['at_ms'], recorder.events[0]['at_ms'])

    def test_metric_sample_sizes_are_separate(self):
        values = [trial(), trial()]
        values[0]['metrics'] = {'native_selected_ms': 10, 'browser_confirmed_ms': None}
        values[1]['metrics'] = {'browser_confirmed_ms': None}
        result = bench.summarize(values)
        self.assertEqual(result['metrics']['native_selected_ms']['n'], 1)
        self.assertNotIn('browser_confirmed_ms', result['metrics'])


class ObserverTests(unittest.IsolatedAsyncioTestCase):
    async def test_deadline_recorded_as_censored(self):
        class Stalled:
            async def run(self, name, rec):
                await asyncio.Event().wait()
        result = await bench.run_trial(Stalled(), 'stall', 0, .01)
        self.assertEqual(result['status'], 'timeout')
        self.assertEqual(result['timeout_lower_bound_ms'], 10)
        self.assertTrue(result['invariants_ok'])

    async def test_unowned_background_task_is_reported_and_cleaned(self):
        ended = asyncio.Event()
        async def child():
            try:
                await asyncio.Event().wait()
            finally:
                ended.set()
        class Leaky:
            async def run(self, name, rec):
                asyncio.create_task(child())
                await asyncio.sleep(0)
        result = await bench.run_trial(Leaky(), 'leak', 0, .2)
        self.assertEqual(result['leaked_task_count'], 1)
        self.assertFalse(result['invariants_ok'])
        self.assertTrue(ended.is_set())

    async def test_missed_phase_is_invalid_not_success(self):
        class Missed:
            async def run(self, name, rec):
                raise bench.InvalidTrial('missed phase')
        result = await bench.run_trial(Missed(), 'missed', 0, .2)
        self.assertEqual(result['status'], 'invalid')
        summary = bench.summarize([result])
        self.assertEqual(summary['n_invalid'], 1)
        self.assertEqual(summary['n_successful'], 0)
        self.assertIsNone(summary['all_trial_p95_ms'])

    async def test_error_not_coerced_into_completed(self):
        class Broken:
            async def run(self, name, rec):
                raise RuntimeError('fixture')
        result = await bench.run_trial(Broken(), 'broken', 0, .2)
        self.assertEqual(result['status'], 'error')
        self.assertIn('RuntimeError', result['error'])

    async def test_monotonic_events_and_attempt_identity(self):
        class Good:
            async def run(self, name, rec):
                rec.event('start')
                await asyncio.sleep(.001)
                rec.event('end')
        result = await bench.run_trial(Good(), 'good', 2, .2)
        self.assertEqual(result['attempt_id'], 'good:3')
        self.assertGreaterEqual(result['events'][1]['at_ms'], result['events'][0]['at_ms'])
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['leaked_task_count'], 0)


if __name__ == '__main__':
    unittest.main()
