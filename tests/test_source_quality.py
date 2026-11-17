"""Synthetic source attribution model contract. No network or browser required."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate
from source_quality import SourceQuality, WINDOW_SECONDS

A = Candidate('http', '8.8.8.8', 8080)
B = Candidate('https', '8.8.8.8', 8080)
C = Candidate('http', '8.8.8.8', 8081)


def report(cc='US', item=A):
    return {'ok': True, 'proxy': {'country': cc, 'scheme': item.scheme,
                                  'host': item.host, 'port': item.port}}


class SourceQualityTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000.
        self.q = SourceQuality(['US', 'DE'], ['alpha', 'beta', 'zero'], clock=lambda: self.now)

    def row(self, cc='US', group='alpha'):
        return next(r for r in self.q.summary(cc)['groups'] if r['group'] == group)

    def test_mirrors_retries_health_and_repeated_confirmation_share_one_vote(self):
        for _ in range(10):
            self.q.observe(A, 'US', 'alpha')
            self.q.terminal(A, report())
            self.assertTrue(self.q.native_offer(A, 'attempt1'))
            self.assertTrue(self.q.confirm(A, 'attempt1'))
        r = self.row()
        self.assertEqual((r['assessedShare'], r['nativeQualifiedShare'], r['browserConfirmedShare']), (1, 1, 1))
        self.assertEqual((r['assessedNative'], r['nativeWorking']), (1, 1))
        self.assertEqual(self.q.summary('US')['nativeWorking'], 1)
        self.assertEqual(self.row(group='zero')['assessedShare'], 0)

    def test_late_group_redistributes_both_native_and_browser_evidence(self):
        self.q.observe(A, 'US', 'alpha')
        self.q.terminal(A, report())
        self.q.native_offer(A, 1)
        self.q.confirm(A, 1)
        self.q.observe(A, 'US', 'beta')
        for group in ['alpha', 'beta']:
            row = self.row(group=group)
            self.assertEqual(row['nativeQualifiedShare'], .5)
            self.assertEqual(row['browserConfirmedShare'], .5)
        self.assertEqual(self.q.summary('US')['nativeWorking'], 1)

    def test_country_observation_split_is_per_group_not_flat_pairs(self):
        self.q.observe(A, 'US', 'alpha')
        self.q.observe(A, 'DE', 'alpha')
        self.q.observe(A, 'US', 'beta')
        self.q.terminal(A, report('DE'))
        self.assertEqual(self.row()['nativeQualifiedShare'], .25)
        self.assertEqual(self.row('DE')['nativeQualifiedShare'], .25)
        self.assertEqual(self.row(group='beta')['nativeQualifiedShare'], .5)
        self.assertEqual(self.row('DE', 'beta')['nativeQualifiedShare'], 0)
        total = sum(r['nativeQualifiedShare'] for cc in ['US', 'DE'] for r in self.q.summary(cc)['groups'])
        self.assertEqual(total, 1)

    def test_scheme_and_port_are_independent_endpoints(self):
        for item in [A, B, C]:
            self.q.observe(item, 'US', 'alpha')
            self.q.terminal(item, report(item=item))
        self.assertEqual(self.row()['nativeQualifiedShare'], 3)
        self.assertEqual(self.q.summary('US')['nativeWorking'], 3)

    def test_outside_selection_and_source_label_do_not_win(self):
        self.q.observe(A, 'DE', 'alpha')
        self.assertFalse(self.q.confirm(A, 1))
        self.assertFalse(self.q.native_offer(A, 1))
        self.assertFalse(self.q.terminal(A, report('FR')))
        self.assertEqual(self.row('DE')['assessedShare'], 1)
        self.assertEqual(self.row('DE')['nativeQualifiedShare'], 0)
        self.assertFalse(self.q.native_offer(A, 1))
        self.q.terminal(A, report('US'))
        self.assertEqual(self.row('DE')['nativeQualifiedShare'], 1)

    def test_browser_requires_current_exact_native_offer_and_retains_no_extra_unit(self):
        for item in [A, B]:
            self.q.observe(item, 'US', 'alpha')
            self.q.terminal(item, report(item=item))
        self.q.native_offer(A, 1)
        self.q.native_offer(B, 2)
        self.assertFalse(self.q.confirm(A, 1))
        self.assertFalse(self.q.confirm(B, 1))
        self.assertTrue(self.q.confirm(B, 2))
        self.assertTrue(self.q.confirm(B, 2))
        self.assertEqual(self.row()['browserConfirmedShare'], 1)
        self.q.terminal(A, {'ok': False, 'reason': 'unavailable'})
        self.assertFalse(self.q.native_offer(A, 3))

    def test_window_fixed_from_first_assessment_not_probes_discovery_or_confirm(self):
        self.assertEqual(WINDOW_SECONDS, 300)
        self.q.observe(A, 'US', 'alpha')
        self.now += 299
        self.q.terminal(A, report())
        self.now += 299
        self.q.observe(A, 'US', 'beta')
        self.q.terminal(A, report())
        self.q.native_offer(A, 1)
        self.q.confirm(A, 1)
        self.assertEqual(self.row()['nativeQualifiedShare'], .5)
        self.now += 1
        self.assertEqual(self.q.summary('US')['nativeWorking'], 0)
        self.assertFalse(self.q.confirm(A, 1))
        self.assertEqual(self.q.summary('US')['retainedEndpoints'], 0)
        self.q.observe(A, 'US', 'alpha')
        self.q.terminal(A, report())
        self.assertEqual(self.row()['nativeQualifiedShare'], 1)

    def test_expiry_order_after_first_terminal_and_neutral_not_assessed(self):
        self.q.observe(A, 'US', 'alpha')
        self.now += 10
        self.q.observe(B, 'US', 'beta')
        self.q.terminal(B, {'ok': False, 'reason': 'neutral'})
        self.now += 10
        self.q.terminal(A, report())
        self.now = 1310
        self.assertEqual(self.q.summary('US')['retainedEndpoints'], 1)
        self.assertEqual(self.row()['nativeWorking'], 1)
        self.assertEqual(self.row(group='beta')['assessedNative'], 0)
        self.now = 1320
        self.assertEqual(self.q.summary('US')['retainedEndpoints'], 0)

    def test_fifo_cap_removes_earned_credit_and_exact_offer(self):
        self.q = SourceQuality(['US'], ['alpha'], clock=lambda: self.now, max_entries=2)
        for idx, item in enumerate([A, B]):
            self.q.observe(item, 'US', 'alpha')
            self.q.terminal(item, report(item=item))
            self.now += 1
        self.q.native_offer(A, 1)
        self.q.observe(C, 'US', 'alpha')
        self.assertEqual(self.q.summary('US')['retainedEndpoints'], 2)
        self.assertTrue(self.q.summary('US')['capacityLimited'])
        self.assertEqual(self.row()['nativeWorking'], 1)
        self.assertFalse(self.q.confirm(A, 1))
        self.assertFalse(self.q.terminal(A, report()))

    def test_unknown_inputs_rejected_and_no_provenance_reconstructed_from_success(self):
        self.assertFalse(self.q.terminal(A, report()))
        self.assertEqual(self.q.summary('US')['retainedEndpoints'], 0)
        for cc, group in [('FR', 'alpha'), ('US', 'mirror-url')]:
            with self.assertRaises(ValueError):
                self.q.observe(A, cc, group)
        with self.assertRaises(ValueError):
            self.q.summary('FR')
        with self.assertRaises(ValueError):
            SourceQuality(['US'], ['alpha'], max_entries=5001)
        with self.assertRaises(ValueError):
            SourceQuality(['US'], ['alpha'], max_entries=True)

    def test_neutral_local_errors_do_not_erase_existing_native_offer(self):
        self.q.observe(A, 'US', 'alpha')
        self.q.terminal(A, report())
        self.q.native_offer(A, 1)
        for reason in ['internal', 'neutral', 'cancel', 'cancelled']:
            self.assertFalse(self.q.terminal(A, {'ok': False, 'reason': reason}))
            self.assertTrue(self.q.confirm(A, 1))
        for code in [58, 59, 77, 82]:
            self.assertFalse(self.q.terminal(A, {'ok': False, 'reason': 'tls', 'code': code}))
            self.assertTrue(self.q.confirm(A, 1))
        self.assertEqual(self.row()['assessedShare'], 1)
        self.assertEqual(self.row()['browserConfirmedShare'], 1)

    def test_neutral_local_errors_never_create_assessment(self):
        self.q.observe(A, 'US', 'alpha')
        self.q.terminal(A, {'ok': False, 'reason': 'tls', 'code': 77})
        self.assertEqual(self.row()['assessedNative'], 0)

    def test_report_must_match_checked_scheme_host_and_port(self):
        self.q.observe(A, 'US', 'alpha')
        for item in [B, C, Candidate('http', '1.1.1.1', A.port)]:
            self.assertFalse(self.q.terminal(A, report(item=item)))
        self.assertEqual(self.row()['nativeQualifiedShare'], 0)
        self.assertTrue(self.q.terminal(A, report()))
        self.assertEqual(self.row()['nativeQualifiedShare'], 1)

    def test_confirmation_token_does_not_accept_bool_float_aliases(self):
        self.q.observe(A, 'US', 'alpha')
        self.q.terminal(A, report())
        self.q.native_offer(A, 1)
        for alias in [True, 1.0, '1']:
            self.assertFalse(self.q.confirm(A, alias))
        self.assertTrue(self.q.confirm(A, 1))

    def test_duplicate_terminal_flags_do_not_rebuild_aggregates(self):
        self.q.observe(A, 'US', 'alpha')
        self.q.terminal(A, report())
        def must_not_apply(*_):
            raise AssertionError('duplicate terminal rebuilt country/group aggregates')
        self.q._apply = must_not_apply
        for _ in range(100):
            self.assertTrue(self.q.terminal(A, report()))
            self.assertFalse(self.q.terminal(A, {'ok': False, 'reason': 'unavailable'}))
        self.assertEqual(self.row()['nativeQualifiedShare'], 1)

    def test_capacity_limit_flag_is_session_sticky_and_expiry_does_not_set_it(self):
        q = SourceQuality(['US'], ['alpha'], clock=lambda: self.now, max_entries=1)
        q.observe(A, 'US', 'alpha')
        self.now += WINDOW_SECONDS
        self.assertFalse(q.summary('US')['capacityLimited'])
        q.observe(B, 'US', 'alpha')
        self.assertFalse(q.summary('US')['capacityLimited'])
        q.observe(C, 'US', 'alpha')
        self.assertTrue(q.summary('US')['capacityLimited'])
        self.now += WINDOW_SECONDS
        self.assertEqual(q.summary('US')['retainedEndpoints'], 0)
        self.assertTrue(q.summary('US')['capacityLimited'])
        fresh = SourceQuality(['US'], ['alpha'], clock=lambda: self.now)
        self.assertFalse(fresh.summary('US')['capacityLimited'])

    def test_max_provenance_cardinality_is_bitsets_with_bounded_known_groups(self):
        codes = [chr(65 + i // 26) + chr(65 + i % 26) for i in range(249)]
        groups = [str(i) for i in range(32)]
        q = SourceQuality(codes, groups, clock=lambda: self.now)
        for cc in codes:
            for group in groups:
                q.observe(A, cc, group)
        q.terminal(A, report(codes[0]))
        self.assertEqual(len(q._records), 1)
        self.assertEqual(len(next(iter(q._records.values())).sources), 32)
        total = sum(r['nativeQualifiedShare'] for cc in codes for r in q.summary(cc)['groups'])
        self.assertAlmostEqual(total, 1)


if __name__ == '__main__':
    unittest.main()
