"""Contract tests for the pre-implementation fairness specification."""
import itertools
import math
import unittest

from fairness_model import (
    CAP, DISCOVERY_SECONDS, JOBS, SLOTS, Candidate, FairModel, Feed, Producer,
    discovery_bound, probe_bound,
)


COUNTS = (1, 2, 3, 120, 121, 249)


def countries(n):
    # Opaque labels: the model deliberately has no ISO lexicographic policy.
    return tuple(f'country-{index}' for index in range(n))


class FairnessModelTests(unittest.TestCase):
    def assert_limits(self, model):
        self.assertLessEqual(model.high_water['jobs'], JOBS)
        self.assertLessEqual(model.high_water['checks'], SLOTS)
        self.assertLessEqual(model.high_water['pending'], CAP * model.n)
        for round_number in range(1, model.round + 1):
            starts = model.starts(round_number=round_number)
            self.assertLessEqual(len(starts), CAP)
            self.assertEqual(len(starts), len({event['endpoint'] for event in starts}))
            all_starts = [event for event in model.events
                          if event['round'] == round_number and
                          event['kind'] == 'checker_start']
            self.assertLessEqual(len(all_starts), 2 * CAP)

    def test_bounds_have_explicit_large_selection_values(self):
        self.assertEqual([probe_bound(n) for n in COUNTS], [2, 2, 2, 2, 3, 4])
        self.assertEqual([discovery_bound(n) for n in COUNTS], [1, 1, 1, 40, 41, 83])
        for invalid in (0, 250):
            with self.assertRaises(ValueError):
                probe_bound(invalid)

    def test_all_ready_countries_get_actual_checker_starts(self):
        for n in COUNTS:
            for cursor in set((0, 1 % n, n - 1)):
                with self.subTest(n=n, credit_cursor=cursor):
                    order = countries(n)
                    model = FairModel(order, order, credit_cursor=cursor)
                    for country in order:
                        model.offer(country, Candidate(country))
                    for _ in range(math.ceil(n / CAP)):
                        model.run_round()
                    served = {cc for event in model.starts() for cc in event['owners']}
                    self.assertEqual(served, set(order))
                    self.assert_limits(model)

    def test_partial_ready_round_bound_is_tight_under_saturated_competition(self):
        # A target consumes its whole initial share, then yields a late fresh
        # endpoint. Other queues remain saturated: no donated credit can mask
        # a cursor error. N=249 must wait until inclusive round 4, not round 2.
        for n in COUNTS:
            with self.subTest(n=n):
                order = countries(n)
                target_index = min(n, CAP) - 1
                target = order[target_index]
                model = FairModel(order, order, discovery_cursor=target_index)
                target_share = CAP // n + (target_index < CAP % n)
                for country in order:
                    count = target_share if country == target else CAP
                    for index in range(count):
                        model.offer(country, Candidate(f'{country}/initial/{index}'))
                late_key = 'late-target'
                model.run_round({target: Producer(feeds=(
                    Feed(44.9, (Candidate(late_key),)),
                ))})
                self.assertFalse(any(event['endpoint'] == late_key
                                     for event in model.starts()))
                ready = next(event for event in model.events
                             if event['kind'] == 'ready' and event['endpoint'] == late_key)
                for _ in range(probe_bound(n) - 1):
                    model.run_round()
                start = next(event for event in model.starts()
                             if event['endpoint'] == late_key)
                self.assertEqual(start['round'] - ready['round'] + 1, probe_bound(n))
                self.assert_limits(model)

    def test_hanging_discovery_advances_only_started_jobs_and_covers_all(self):
        for n in COUNTS:
            with self.subTest(n=n):
                order = countries(n)
                model = FairModel(order, order)
                for _ in range(discovery_bound(n)):
                    model.run_round()  # Every started producer hangs until 45s.
                starts = [event for event in model.events
                          if event['kind'] == 'discovery_start']
                self.assertEqual([event['country'] for event in starts[:n]], list(order))
                self.assertEqual({event['country'] for event in starts}, set(order))
                self.assertEqual(model.discovery_cursor, len(starts) % n)
                self.assertEqual(model.now, DISCOVERY_SECONDS * discovery_bound(n))
                self.assertEqual(model.starts(), [])  # Discovery is not a probe.
                self.assert_limits(model)

    def test_fast_completed_jobs_allow_more_than_three_starts_not_three_at_once(self):
        order = countries(249)
        model = FairModel(order, order)
        model.run_round({country: Producer(finish=0.1) for country in order})
        starts = [event for event in model.events if event['kind'] == 'discovery_start']
        self.assertEqual(len(starts), 249)
        self.assertLess(max(event['time'] for event in starts), 45)
        self.assert_limits(model)

    def test_fast_a_cannot_borrow_late_b_share_before_completion(self):
        model = FairModel(('NO', 'EE'), ('NO', 'EE'))
        model.run_round({
            'NO': Producer(finish=0.2, feeds=(Feed(0, tuple(
                Candidate(f'a/{index}') for index in range(CAP))),)),
            'EE': Producer(finish=44.9, feeds=(Feed(44.9, (Candidate('b'),)),)),
        })
        early_a = [event for event in model.events if event['kind'] == 'admit'
                   and event['country'] == 'NO' and event['time'] < 44.9]
        self.assertEqual(len(early_a), 60)
        self.assertEqual(model.starts(country='EE')[0]['time'], 44.9)
        self.assertEqual(model.starts()[0]['time'], 0)
        self.assertEqual(len(model.starts()), CAP)
        self.assert_limits(model)

    def test_saturated_slots_use_real_dispatch_and_discovery_does_not_kill_checks(self):
        model = FairModel(('NO', 'EE'), ('NO', 'EE'))
        model.run_round({
            'NO': Producer(feeds=(Feed(0, tuple(
                Candidate(f'a/{index}', fast_seconds=47, slow_seconds=47)
                for index in range(60))),)),
            'EE': Producer(feeds=(Feed(44.9, (Candidate('b', fast_seconds=47),)),)),
        })
        admission = next(event for event in model.events
                         if event['kind'] == 'admit' and event['endpoint'] == 'b')
        start = model.starts(country='EE')[0]
        self.assertEqual(admission['time'], 44.9)
        self.assertGreater(start['time'], DISCOVERY_SECONDS)
        self.assertEqual(start['round'], 1)
        self.assertGreater(model.now, start['time'])
        self.assertEqual(model.high_water['checks'], SLOTS)
        self.assertEqual(len(model.starts(phase='slow')), 60)
        self.assert_limits(model)

    def test_pending_ready_without_credit_survives_round_and_incoming_overflow(self):
        order = countries(249)
        target = order[248]
        model = FairModel(order, order)
        for country in order[:120]:
            model.offer(country, Candidate(country))
        model.offer(target, Candidate('keep-me'))
        model.run_round()
        self.assertFalse(model.starts(country=target))
        for index in range(CAP - 1):
            self.assertTrue(model.offer(target, Candidate(f'extra/{index}')))
        self.assertFalse(model.offer(target, Candidate('overflow')))
        self.assertEqual(model.pending[target][0], 'keep-me')
        # No source-cache object is needed after admission to the pending queue.
        for _ in range(probe_bound(249) - 1):
            model.run_round()
        self.assertTrue(any(event['endpoint'] == 'keep-me' for event in model.starts()))
        self.assert_limits(model)

    def test_permuting_selection_does_not_change_schedule(self):
        order = ('NO', 'EE', 'AT')
        traces = []
        for selected in itertools.permutations(order):
            model = FairModel(selected, order)
            model.run_round({
                'NO': Producer(feeds=(Feed(0, (Candidate('n'),)),)),
                'EE': Producer(feeds=(Feed(44.9, (Candidate('e'),)),)),
                'AT': Producer(feeds=(Feed(1.0, (Candidate('a'),)),)),
            })
            traces.append(model.events)
        self.assertTrue(all(trace == traces[0] for trace in traces))

    def test_iso_renaming_preserves_equal_quality_tie_schedule(self):
        order = ('NO', 'EE', 'AT')
        rename = {'NO': 'AU', 'EE': 'JP', 'AT': 'DE'}
        inverse = {value: key for key, value in rename.items()}
        left = FairModel(order, order)
        right = FairModel(tuple(reversed(tuple(rename.values()))),
                          tuple(rename[cc] for cc in order))
        for model, transform in ((left, lambda cc: cc), (right, rename.__getitem__)):
            for country in order:
                model.offer(transform(country), Candidate(country + '/same-quality'))
            model.run_round()
        converted = []
        for original in right.events:
            event = dict(original)
            if 'country' in event:
                event['country'] = inverse[event['country']]
            if 'owners' in event:
                event['owners'] = tuple(inverse[cc] for cc in event['owners'])
            if 'credits' in event:
                event['credits'] = {inverse[cc]: count for cc, count in event['credits'].items()}
            converted.append(event)
        self.assertEqual(converted, left.events)

    def test_duplicate_endpoint_is_one_admission_serving_known_country_owners(self):
        model = FairModel(('NO', 'EE'), ('NO', 'EE'))
        candidate = Candidate('shared')
        model.offer('NO', candidate)
        model.offer('EE', candidate)
        model.run_round()
        self.assertEqual(len(model.starts()), 1)
        self.assertEqual(set(model.starts()[0]['owners']), {'NO', 'EE'})
        self.assertEqual(len(model.starts(country='NO')), 1)
        self.assertEqual(len(model.starts(country='EE')), 1)
        self.assert_limits(model)

    def test_full_fast_slow_budget_is_240_actual_starts(self):
        model = FairModel(('NO',), ('NO',))
        for index in range(CAP):
            model.offer('NO', Candidate(str(index), slow_seconds=0.2))
        model.run_round()
        self.assertEqual(len(model.starts()), CAP)
        self.assertEqual(len(model.starts(phase='slow')), CAP)
        self.assert_limits(model)

    def test_nonfinite_checker_cannot_undermine_bound_premise(self):
        for duration in (float('inf'), float('nan'), -1, 0, 48):
            with self.assertRaises(ValueError):
                Candidate('bad', fast_seconds=duration)


if __name__ == '__main__':
    unittest.main()
