"""Memory-first contract: fake clocks, synthetic outcomes and no network."""
import copy
import ipaddress
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate
from history import EndpointHistory, MAX_AGE, MAX_BYTES, MAX_STREAK

A = Candidate('http', '8.8.8.8', 8080)
B = Candidate('http', '1.1.1.1', 8080)
C = Candidate('socks5', '9.9.9.9', 1080)


class Clock:
    def __init__(self):
        self.mono, self.wall = 1000., 1800000000.

    def advance(self, seconds):
        self.mono += seconds
        self.wall += seconds

    def history(self, **kwargs):
        return EndpointHistory(clock=lambda: self.mono, wall_clock=lambda: self.wall,
                               jitter=lambda: 0, **kwargs)


class MemoryHistory(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.h = self.clock.history()

    def test_exact_endpoint_key_and_no_global_host_penalty(self):
        self.h.observe(A, 'endpoint_failure')
        self.assertFalse(self.h.eligible(A))
        self.assertTrue(self.h.eligible(Candidate('http', A.host, 8081)))
        self.assertTrue(self.h.eligible(Candidate('https', A.host, A.port)))
        self.assertTrue(self.h.eligible(B))

    def test_production_global_literal_only_and_explicit_lab_injection(self):
        for host in ('localhost', '127.0.0.1', '10.0.0.1', '169.254.169.254',
                     '224.0.0.1', '8.8.8.8%lo0', 'user@8.8.8.8', 'https://8.8.8.8'):
            item = Candidate('http', host, 80)
            self.assertIsNone(self.h.observe(item, 'unknown'))
            self.assertTrue(self.h.eligible(item))
        for scheme, port in (('ftp', 80), ('http', True), ('http', 0), ('http', 65536)):
            self.assertIsNone(self.h.seen(Candidate(scheme, A.host, port)))
        lab = self.clock.history(endpoint_validator=lambda address: address.is_loopback)
        item = Candidate('http', '127.0.0.1', 80)
        lab.observe(item, 'unknown')
        self.assertFalse(lab.eligible(item))
        self.assertIsNone(lab.seen(Candidate('http', 'localhost', 80)))

    def test_literal_ipv6_is_canonical_without_extending_parser(self):
        long = Candidate('socks5', '2001:4860:4860:0:0:0:0:8888', 1080)
        short = Candidate('socks5', '2001:4860:4860::8888', 1080)
        self.h.observe(long, 'unknown')
        self.assertFalse(self.h.eligible(short))
        self.assertEqual(len(self.h.records), 1)

    def test_confirmed_failure_doubles_caps_and_recovers(self):
        for streak in range(1, 25):
            rec = self.h.observe(A, 'endpoint_failure')
            self.assertEqual(rec.streak, min(streak, MAX_STREAK))
            delay = min(3600, 60 * 2 ** (streak - 1))
            self.assertEqual(rec.cooldown_until - self.clock.mono, delay)
            self.assertFalse(self.h.eligible(A))
            self.clock.advance(delay)
            self.assertTrue(self.h.eligible(A))
            self.assertTrue(self.h.is_exploration(A))

    def test_jitter_is_nonnegative_ten_percent_capped(self):
        h = EndpointHistory(clock=lambda: self.clock.mono, wall_clock=lambda: self.clock.wall,
                            jitter=lambda: 1)
        rec = h.observe(A, 'endpoint_failure')
        self.assertAlmostEqual(rec.cooldown_until - self.clock.mono, 66)
        for _ in range(12):
            rec = h.observe(A, 'endpoint_failure')
        self.assertEqual(rec.cooldown_until - self.clock.mono, 3600)

    def test_last_physical_outcome_survives_restart_and_neutral_cancellation(self):
        for reason in ('http', 'timeout', 'connect', 'tls', 'transport', 'unknown'):
            self.h.observe(A, 'unknown', reason=reason)
            self.h.observe(A, 'cancel')
            restored = self.clock.history()
            restored.restore(self.h.snapshot())
            self.assertEqual(restored.get(A).last_outcome, reason)
        self.assertEqual(self.h.observe(A, 'endpoint_failure').last_outcome, 'invalid_trace')

    def test_unknown_does_not_grow_confirmed_streak(self):
        for _ in range(20):
            rec = self.h.observe(A, 'unknown')
            self.assertEqual(rec.streak, 0)
            self.assertEqual(rec.cooldown_until - self.clock.mono, 60)
            self.clock.advance(60)
        self.h.observe(A, 'endpoint_failure')
        self.clock.advance(60)
        self.assertEqual(self.h.observe(A, 'unknown').streak, 1)

    def test_ambiguous_failure_cannot_shorten_a_confirmed_quarantine(self):
        self.h.observe(A, 'endpoint_failure')
        self.clock.advance(60)
        rec = self.h.observe(A, 'endpoint_failure')
        original = rec.cooldown_until
        self.clock.advance(5)
        self.h.observe(A, 'unknown', reason='timeout')
        self.assertEqual((rec.cooldown_until, rec.streak), (original, 2))

    def test_neutral_does_not_create_reset_or_renew(self):
        for kind in ('cancel', 'internal', 'neutral'):
            self.assertIsNone(self.h.observe(B, kind))
        rec = self.h.observe(A, 'endpoint_failure')
        before = copy.deepcopy(rec)
        self.clock.advance(100)
        revision = self.h.revision
        for kind in ('cancel', 'internal', 'neutral'):
            self.h.observe(A, kind, country='NO')
        self.assertEqual(rec, before)
        self.assertEqual(self.h.revision, revision)

    def test_country_hint_does_not_create_or_reset_global_penalties(self):
        rec = self.h.observe(A, 'country', country='NO')
        self.assertEqual(rec.country_hint, 'NO')
        self.assertEqual(rec.streak, 0)
        self.assertIsNone(rec.cooldown_until)
        self.assertTrue(self.h.eligible(A))
        self.h.observe(A, 'endpoint_failure')
        before = rec.cooldown_until
        self.h.observe(A, 'country', country='SE')
        self.assertEqual((rec.streak, rec.cooldown_until), (1, before))

    def test_validated_success_resets_and_ewma_uses_successes_only(self):
        self.h.observe(A, 'success', latency_ms=100, country='NO')
        self.h.observe(A, 'unknown', latency_ms=9000)
        self.h.observe(A, 'endpoint_failure', latency_ms=8000)
        self.h.observe(A, 'country', latency_ms=7000, country='SE')
        rec = self.h.observe(A, 'success', latency_ms=200, country='NO')
        self.assertEqual(rec.ewma_ms, 125)
        self.assertEqual(rec.streak, 0)
        self.assertIsNone(rec.cooldown_until)
        self.assertFalse(self.h.is_exploration(A))
        self.assertTrue(self.h.eligible(A))

    def test_rank_recent_streak_then_known_ewma(self):
        self.h.observe(A, 'success', latency_ms=100)
        self.h.observe(B, 'success', latency_ms=20)
        self.assertLess(self.h.rank(B), self.h.rank(A))
        self.assertLess(self.h.rank(A), self.h.rank(C))
        self.h.observe(B, 'endpoint_failure')
        self.assertLess(self.h.rank(A), self.h.rank(B))
        self.clock.advance(301)
        self.assertEqual(self.h.rank(A)[0], 1)
        self.h.observe(C, 'success', latency_ms=500)
        self.assertLess(self.h.rank(C), self.h.rank(A))

    def test_sources_capped_and_stale_reoffers_do_not_immortalize(self):
        self.h.observe(A, 'endpoint_failure', groups=['provider-a'])
        original = self.h.get(A).last_seen
        for index in range(70):
            self.clock.advance(10)
            self.h.seen(A, groups=[f'provider-{index}'])
        self.assertEqual(len(self.h.get(A).groups), 32)
        self.assertEqual(self.h.get(A).last_seen, original)
        self.clock.advance(MAX_AGE)
        self.assertIsNone(self.h.get(A))
        fresh = self.h.seen(A)
        self.assertEqual(fresh.streak, 0)
        self.assertTrue(self.h.is_exploration(A))

    def test_prune_expired_before_oldest_capacity_eviction(self):
        h = self.clock.history(max_records=2)
        h.seen(A)
        self.clock.advance(1)
        h.seen(B)
        self.clock.advance(1)
        h.observe(A, 'country', country='NO')
        h.seen(C)
        self.assertIsNone(h.get(B))
        self.assertIsNotNone(h.get(A))
        self.clock.advance(MAX_AGE)
        self.assertEqual(h.prune(), 2)
        self.assertEqual(h.records, {})

    def test_equal_clock_evicts_first_inserted_not_new_record(self):
        h = self.clock.history(max_records=1)
        h.seen(A)
        rec = h.observe(B, 'endpoint_failure')
        self.assertIs(h.get(B), rec)
        self.assertFalse(h.eligible(B))

    def test_runtime_ignores_wall_jumps_and_clamps_monotonic_rollback(self):
        self.h.observe(A, 'unknown')
        self.clock.wall += MAX_AGE * 5
        self.assertFalse(self.h.eligible(A))
        self.clock.mono += 30
        self.h.eligible(A)
        self.clock.mono -= 500
        self.assertFalse(self.h.eligible(A))

    def test_restore_preserves_remaining_cooldown_not_process_clock(self):
        self.h.observe(A, 'endpoint_failure', groups=['provider-a'])
        self.clock.advance(20)
        document = self.h.snapshot()
        self.clock.advance(10)
        self.clock.mono = 3
        restored = self.clock.history()
        self.assertEqual(restored.restore(document), 1)
        rec = restored.get(A)
        self.assertAlmostEqual(rec.cooldown_until - self.clock.mono, 30)
        self.clock.advance(30)
        self.assertTrue(restored.eligible(A))
        self.assertEqual(rec.groups, ('provider-a',))

    def test_restart_expiry_and_forward_wall_jump_remove_stale_records(self):
        self.h.observe(A, 'success', latency_ms=10)
        document = self.h.snapshot()
        self.clock.wall += MAX_AGE
        restored = self.clock.history()
        self.assertEqual(restored.restore(document), 0)

    def test_backward_wall_jump_rejects_future_snapshot(self):
        self.h.seen(A)
        document = self.h.snapshot()
        self.clock.wall -= 1
        with self.assertRaises(ValueError):
            self.clock.history().restore(document)

    def test_restore_strict_atomic_validation(self):
        self.h.observe(A, 'success', latency_ms=10, country='NO')
        document = self.h.snapshot()
        changes = [('lastOutcome', []), ('lastOutcome', 'outside-schema'), ('scheme', 'ftp'), ('host', '127.0.0.1'), ('port', True),
                   ('streak', 17), ('streak', False), ('ewmaMs', float('nan')),
                   ('countryHint', 'ZZ'), ('groups', ['provider', 'provider']),
                   ('firstSeen', self.clock.wall + 1), ('lastSeen', -1),
                   ('lastSuccess', self.clock.wall + 1),
                   ('cooldownUntil', self.clock.wall + 3601)]
        for field, value in changes:
            bad = copy.deepcopy(document)
            bad['records'][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                self.h.restore(bad)
            self.assertEqual(self.h.snapshot(), document)
        for bad in ({}, {**document, 'schemaVersion': True}, {**document, 'schemaVersion': 2},
                    {**document, 'extra': 0}, {**document, 'records': document['records'] * 2}):
            with self.assertRaises(ValueError):
                self.h.restore(bad)

    def test_snapshot_bounds_newest_first_even_large_metadata(self):
        groups = ['g' + str(index).zfill(2) + 'x' * 61 for index in range(32)]
        for index in range(1100):
            self.clock.advance(.01)
            self.h.seen(Candidate('http', '8.8.8.8', index + 1), groups=groups)
        snapshot = self.h.snapshot()
        self.assertLessEqual(len(json.dumps(snapshot, separators=(',', ':')).encode()), MAX_BYTES)
        self.assertLess(len(snapshot['records']), 1100)
        self.assertEqual(snapshot['records'][0]['port'], 1100)
        self.assertEqual(len(self.h.records), 1100)
        self.assertEqual(self.clock.history().restore(snapshot), len(snapshot['records']))

    def test_invalid_observation_data_rejected(self):
        for kwargs in ({}, {'latency_ms': True}, {'latency_ms': -1},
                       {'latency_ms': float('inf')}, {'latency_ms': 10 ** 500}):
            with self.assertRaises(ValueError):
                self.h.observe(A, 'success', **kwargs)
        with self.assertRaises(ValueError):
            self.h.seen(A, groups=['bad\nlabel'])
        with self.assertRaises(ValueError):
            self.h.observe(A, 'tls')  # Blanket TLS classification is forbidden.


if __name__ == '__main__':
    unittest.main()
