"""No-network regressions for post-replacement refill and exact stage fault ownership."""
import asyncio
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'native'), str(ROOT / 'tests')]
from core import Candidate, Session
from refill_observer import RefillJournal, RefillObserver, fault_target


def proxy(item, country='AT'):
    return {'scheme': item.scheme, 'host': item.host, 'port': item.port, 'country': country,
            'exitIp': item.host, 'latencyMs': 1, 'checkedAt': int(time.time() * 1000)}


class RefillObserverTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)

    def read(self):
        return json.loads((self.directory / 'offers-0001.json').read_text())

    async def session(self):
        async def checker(item, *_):
            return proxy(item)
        async def feed(_):
            return [], []
        session = Session(['AT', 'EE', 'NO'], lambda _: None, checker=checker, discoverer=feed)
        self.addAsyncCleanup(session.check_budget.close)
        return session

    def test_fault_binds_stage_session_attempt_and_endpoint(self):
        item = Candidate('http', '192.0.2.51', 8080)
        session = SimpleNamespace(qa_session_number=3, offer_attempt=7, active=proxy(item))
        token = {'stage': 2, 'session': 3, 'attempt': 7, 'endpoint': item.key}
        self.assertTrue(fault_target(token, session, item))
        for field, value in [('stage', True), ('stage', 3), ('session', 4), ('attempt', 6),
                             ('attempt', True), ('endpoint', 'http://192.0.2.51:80')]:
            self.assertFalse(fault_target({**token, field: value}, session, item))
        self.assertFalse(fault_target({**token, 'extra': 'secret'}, session, item))
        self.assertFalse(fault_target(None, session, item))
        session.offer_attempt += 1
        self.assertFalse(fault_target(token, session, item))

    async def test_removed_admission_cannot_reappear_as_unrelated_accept(self):
        session = await self.session()
        RefillJournal(self.directory).attach(session)
        b = Candidate('http', '192.0.2.52', 80)
        self.assertTrue(session.pool.accept(proxy(b), refill=True))
        self.assertEqual(self.read()['liveAdmissions'], [1])
        session.pool._remove(b.key)
        session.pool.publish()
        self.assertEqual(self.read()['liveAdmissions'], [])
        self.assertTrue(session.pool.accept(proxy(b)))
        self.assertEqual(self.read()['liveAdmissions'], [])
        self.assertEqual(len(self.read()['admissions']), 1)

    async def test_maintenance_preserves_same_admission_and_take_binds_exact_result(self):
        session = await self.session()
        RefillJournal(self.directory).attach(session)
        a, b = Candidate('http', '192.0.2.53', 80), Candidate('http', '192.0.2.54', 80)
        session.active = proxy(a)
        session.offer_attempt = 1
        session.pool.accept(proxy(b), refill=True)
        entry = session.pool.entries[b.key]
        await session.pool._refresh_one(b.key, entry, session.pool._tokens[b.key], session.pool._generation)
        self.assertEqual(self.read()['liveAdmissions'], [1])
        [maintained] = self.read()['maintenance']
        self.assertEqual((maintained['admissionId'], maintained['ok'], maintained['renewed']), (1, True, True))
        self.assertIsNone(maintained['nativeProbe'])  # Injected checker supplies no transport evidence.
        winner = await session.pool.take(on_result=lambda *_args, **_kwargs: None)
        self.assertIsNotNone(winner)
        session.active = winner
        session.offer_attempt = 2
        session.emit({'phase': 'connected', 'proxy': winner})
        [offer] = self.read()['offers']
        self.assertEqual(offer['origin'], 'pool')
        self.assertEqual(offer['refillAdmissionId'], 1)
        self.assertEqual(self.read()['liveAdmissions'], [])
        text = json.dumps(self.read())
        for private in (a.host, b.host, '"host":', '"exitIp":'):
            self.assertNotIn(private, text)

    async def test_maintenance_captures_exact_returned_attempts_without_addresses(self):
        session = await self.session()
        item = Candidate('socks5', '192.0.2.81', 1080)
        async def raw(candidate, *_args, **_kwargs):
            return {'ok': True, 'proxy': proxy(candidate), '_qaProbe': {
                'version': 1, '_startedNs': time.monotonic_ns(), 'startedAtMs': 1000,
                'elapsedMs': 3, 'limited': False, 'private': 'PRIVATE', 'controls': [
                    {'endpoint': name, 'ordinal': ordinal, 'startMs': start, 'endMs': start + 1,
                     'outcome': 'failed' if code else 'completed', 'curlCode': code,
                     'httpStatus': status, 'connectStatus': 0, 'timingMs': None, 'address': 'PRIVATE'}
                    for name, ordinal, start, code, status in [
                        ('trace', 1, 0, 97, 0), ('trace', 2, 1, 0, 200), ('target', 1, 0, 0, 204)]
                ]}}
        session._raw_report = raw
        RefillJournal(self.directory).attach(session)
        session.pool.accept(proxy(item), refill=True)
        entry = session.pool.entries[item.key]
        await session.pool._refresh_one(item.key, entry, session.pool._tokens[item.key], session.pool._generation)
        [row] = self.read()['maintenance']
        self.assertEqual((row['outcome'], row['renewed'], row['ok']), ('completed', True, True))
        self.assertEqual([r['curlCode'] for r in row['nativeProbe']['controls']], [97, 0, 0])
        self.assertEqual(row['admissionId'], 1)
        await session.reserve_report(item, session.country, True)
        self.assertEqual(self.read()['maintenance'], [row])  # Later work cannot rewrite this observation.
        self.assertNotIn('PRIVATE', json.dumps(self.read()))
        self.assertNotIn(item.host, json.dumps(self.read()))

    async def test_failed_maintenance_has_no_renewal_or_false_ready_lease(self):
        session = await self.session()
        item = Candidate('socks5', '192.0.2.82', 1080)
        async def raw(*_args, **_kwargs):
            return {'ok': False, 'reason': 'connect', 'endpoint': 'trace', 'code': 97, 'latencyMs': 3}
        session._raw_report = raw
        RefillJournal(self.directory).attach(session)
        session.pool.accept(proxy(item), refill=True)
        entry = session.pool.entries[item.key]
        await session.pool._refresh_one(item.key, entry, session.pool._tokens[item.key], session.pool._generation)
        [row] = self.read()['maintenance']
        self.assertEqual((row['ok'], row['renewed'], row['nativeCheckedAt']), (False, False, None))
        self.assertEqual(row['check']['code'], 97)
        self.assertEqual(self.read()['liveAdmissions'], [])
        self.assertNotIn(item.key, session.pool.entries)

    async def test_joined_existing_verification_can_renew_without_claiming_own_probe(self):
        session = await self.session()
        item = Candidate('socks5', '192.0.2.84', 1080)
        started, release = asyncio.Event(), asyncio.Event()
        async def raw(candidate, *_args, **_kwargs):
            started.set()
            await release.wait()
            return {'ok': True, 'proxy': proxy(candidate)}
        session._raw_report = raw
        RefillJournal(self.directory).attach(session)
        session.pool.accept(proxy(item), refill=True)
        entry = session.pool.entries[item.key]
        existing = asyncio.create_task(session.pool.verify(item))
        maintenance = None
        try:
            await asyncio.wait_for(started.wait(), 1)
            maintenance = asyncio.create_task(session.pool._refresh_one(
                item.key, entry, session.pool._tokens[item.key], session.pool._generation))
            async with asyncio.timeout(1):
                while not self.read()['maintenance']:
                    await asyncio.sleep(0)
            release.set()
            await asyncio.gather(existing, maintenance)
        finally:
            release.set()
            for task in (existing, maintenance):
                if task is not None and not task.done():
                    task.cancel()
            await asyncio.gather(*(task for task in (existing, maintenance) if task is not None), return_exceptions=True)
        [row] = self.read()['maintenance']
        self.assertEqual((row['outcome'], row['renewed'], row['admissionId']), ('completed', True, 1))
        self.assertIsNone(row['ok'])  # Shared operation belonged to another caller's context.
        self.assertIsNone(row['nativeProbe'])
        self.assertEqual(self.read()['liveAdmissions'], [1])

    async def test_cancelled_maintenance_is_not_a_failed_or_renewed_check(self):
        session = await self.session()
        item = Candidate('socks5', '192.0.2.83', 1080)
        started = asyncio.Event()
        async def raw(*_args, **_kwargs):
            started.set()
            await asyncio.Future()
        session._raw_report = raw
        RefillJournal(self.directory).attach(session)
        session.pool.accept(proxy(item))  # No refill lineage: still a real maintenance observation.
        entry = session.pool.entries[item.key]
        task = asyncio.create_task(session.pool._refresh_one(item.key, entry, session.pool._tokens[item.key], session.pool._generation))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        [row] = self.read()['maintenance']
        self.assertEqual((row['outcome'], row['ok'], row['renewed'], row['admissionId']),
                         ('cancelled', None, False, None))
        self.assertIs(session.pool.entries[item.key], entry)

    async def test_failure_groups_ignore_variable_latency_and_old_scheduler_stats(self):
        session = await self.session()
        item = Candidate('http', '192.0.2.55', 80)
        counter = 0
        async def raw(*_args):
            nonlocal counter
            counter += 1
            return {'ok': False, 'reason': 'timeout', 'endpoint': 'target', 'code': 28, 'latencyMs': counter}
        session._raw_report = raw
        async def refill():
            for _ in range(40):
                await session._budgeted(item, session.country, True, 'speculative')
        session.pool._refill = refill
        session.search.last_stats = {'checks': 999, 'admissions': 999}
        RefillJournal(self.directory).attach(session)
        await session.pool._refill()
        row = self.read()['refillRounds'][0]
        self.assertEqual(row['checks'], 40)
        self.assertEqual(row['failures'], [{'check': {'reason': 'timeout', 'endpoint': 'target', 'code': 28}, 'count': 40}])
        self.assertEqual(row['scheduler'], {})
        self.assertFalse(self.read()['truncated'])

    async def test_pending_refill_is_visible_and_cancellation_is_not_a_failure(self):
        session = await self.session()
        started = asyncio.Event()
        async def refill():
            started.set()
            await asyncio.Future()
        session.pool._refill = refill
        RefillJournal(self.directory).attach(session)
        task = asyncio.create_task(session.pool._refill())
        await started.wait()
        self.assertEqual(self.read()['refillRounds'][0]['outcome'], 'pending')
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        row = self.read()['refillRounds'][0]
        self.assertEqual(row['outcome'], 'cancelled')
        self.assertEqual(row['failures'], [])

    async def test_lifecycle_and_stage_faults_are_saved_without_endpoint(self):
        session = await self.session()
        started = asyncio.Event()
        async def run():
            started.set()
            await asyncio.Future()
        session.run = run
        RefillJournal(self.directory).attach(session)
        task = asyncio.create_task(session.run())
        await started.wait()
        self.assertTrue(self.read()['lifecycle']['running'])
        session.qa_refill_fault(2, 5)
        self.assertEqual(self.read()['faults'][0]['stage'], 2)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(self.read()['lifecycle']['running'])
        self.assertIsInstance(self.read()['lifecycle']['stoppedAtMs'], int)

    async def test_native_confirmation_first_host_exit_identity_and_readmission_are_distinct(self):
        session = await self.session()
        session.wait_for_browser = True
        RefillJournal(self.directory).attach(session)
        a, b, c = [Candidate('http', f'192.0.2.{i}', 80) for i in (91, 92, 93)]
        for attempt, item in ((1, a), (2, b)):
            session.offer_attempt, session.active = attempt, proxy(item)
            session.emit({'phase': 'connected', 'proxy': session.active})
            if attempt == 1:
                self.assertTrue(session.browser_feedback('confirm', attempt, dict(scheme=item.scheme, host=item.host, port=item.port)))
        # A pending B offer does not establish the post-confirmation barrier.
        session.pool.accept(proxy(c), refill=True)
        self.assertEqual(self.read()['admissions'][0]['confirmedAttemptAtAdmission'], 1)
        session.pool._remove(c.key)
        self.assertTrue(session.browser_feedback('confirm', 2, dict(scheme=b.scheme, host=b.host, port=b.port)))
        # Different port/protocol on a previously admitted host is not a new address.
        alternate = Candidate('socks5', c.host, 1080)
        changed = proxy(alternate);changed['exitIp'] = '198.51.100.93'
        session.pool.accept(changed, refill=True)
        second = self.read()['admissions'][1]
        self.assertEqual((second['firstHostAdmissionId'], second['firstExitAdmissionId'], second['confirmedAttemptAtAdmission']), (1, 2, 2))
        session.pool._remove(alternate.key)
        shared_exit = Candidate('http', '192.0.2.94', 80)
        changed = proxy(shared_exit);changed['exitIp'] = c.host
        session.pool.accept(changed, refill=True)
        third = self.read()['admissions'][2]
        self.assertEqual((third['firstHostAdmissionId'], third['firstExitAdmissionId']), (3, 1))
        session.pool._remove(shared_exit.key)
        session.pool.accept(proxy(a), refill=True)
        fourth = self.read()['admissions'][3]
        self.assertEqual((fourth['firstHostAdmissionId'], fourth['firstExitAdmissionId']), (0, 0))
        session.qa_refill_fault(2, 2)
        self.assertEqual(self.read()['faults'][-1]['admissionCount'], 4)
        text = json.dumps(self.read())
        for private in (a.host, b.host, c.host, shared_exit.host, '198.51.100.93'):
            self.assertNotIn(private, text)

    async def test_actual_python_journal_projects_in_javascript_and_qualifies_only_after_confirm(self):
        session = await self.session()
        session.wait_for_browser = True
        RefillJournal(self.directory).attach(session)
        a, b, c = [Candidate('http', f'192.0.2.{i}', 80) for i in (101, 102, 103)]
        for attempt, item in ((1, a), (2, b)):
            session.offer_attempt, session.active = attempt, proxy(item)
            session.emit({'phase': 'connected', 'proxy': session.active})
            self.assertTrue(session.browser_feedback('confirm', attempt, dict(scheme=item.scheme, host=item.host, port=item.port)))
        session.pool.accept(proxy(c), refill=True)
        # The reader normally sees a running session during the public run.
        raw = self.read();raw['lifecycle']['running'] = True
        module = (ROOT / 'tests/refill-evidence.mjs').as_uri()
        script = ('import {readRefillData,boundOffer,postReplacementAdmissions} from '+json.dumps(module)+';'
                  'let text="";for await(const chunk of process.stdin)text+=chunk;'
                  'const s=readRefillData(JSON.parse(text),1),b=boundOffer([s],2);'
                  'const a=postReplacementAdmissions([s],b,0,{countries:["AT","EE","NO"],count:1,expiresAt:10000},["AT","EE","NO"],200);'
                  'process.stdout.write(JSON.stringify(a.map(x=>({id:x.id,firstHost:x.firstHostAdmissionId,firstExit:x.firstExitAdmissionId,confirmed:x.confirmedAttemptAtAdmission}))));')
        result = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps(raw),
                                text=True, capture_output=True, timeout=10, check=True)
        self.assertEqual(json.loads(result.stdout), [{'id': 1, 'firstHost': 1, 'firstExit': 1, 'confirmed': 2}])

    def test_identity_maps_are_bounded_and_never_forget_old_addresses(self):
        observer = RefillObserver(self.directory, 1)
        for value in range(512):
            self.assertEqual(observer.first_admission(observer.first_hosts, str(value), value), value)
        self.assertIsNone(observer.first_admission(observer.first_hosts, 'overflow', 513))
        self.assertEqual(len(observer.first_hosts), 512)
        self.assertEqual(observer.first_admission(observer.first_hosts, '1', 514), 1)
        self.assertTrue(observer.data['truncated'])


if __name__ == '__main__':
    unittest.main()
