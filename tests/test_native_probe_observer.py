"""Native QA observation regressions. All subprocesses are fakes; no network."""
import asyncio
import copy
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from tempfile import TemporaryDirectory

if sys.version_info < (3, 11):
    raise RuntimeError('Native probe tests require Python 3.11 or newer')

sys.path.insert(0, str(Path(__file__).resolve().parent))
from native_probe_observer import NativeProbeObserver, ORIGINAL_WRITE_OUT, WRITE_OUT, project_native_probe, restore_output

TRACE = 'https://www.cloudflare.com/cdn-cgi/trace'
TARGET = 'https://www.google.com/generate_204'
TRAILER = '\nCPQA1|200|200|0.001|0.010|0.030|0.031|0.040|0.041'


def json_trailer(code=0, status=200, **fields):
    data = dict(exitcode=code, http_code=status, http_connect=200,
                time_namelookup=.001, time_connect=.010, time_appconnect=.030,
                time_pretransfer=.031, time_starttransfer=.040, time_total=.041,
                ssl_verify_result=0, proxy_ssl_verify_result=0, errormsg='')
    data.update(fields)
    return f'\nCPQA2|{status:03d}|' + json.dumps(data, separators=(',', ':'))


def numeric_trailer(code=0, status=200, **fields):
    payload = json_trailer(code, status, **fields).split('|', 2)[2]
    data = json.loads(payload)
    prefix = ['CPQA3', f'{status:03d}', str(code), f'{data["http_connect"]:03d}',
              str(data['ssl_verify_result']), str(data['proxy_ssl_verify_result'])]
    prefix.extend(f'{data[name]:.6f}' for name in ('time_namelookup', 'time_connect', 'time_appconnect',
                                                'time_pretransfer', 'time_starttransfer', 'time_total'))
    return '\n' + '|'.join(prefix) + '|' + payload


def command(url):
    return ['/usr/bin/curl', '--disable', '--proxy', 'PRIVATE', '--write-out', ORIGINAL_WRITE_OUT, url]


class NativeProbeTest(unittest.IsolatedAsyncioTestCase):
    def test_writeout_restores_exact_body_and_status_without_exporting_body(self):
        for body in ('', 'PRIVATE\n', 'text\r\nPRIVATE', 'body\nCPQA1|200|a fake body trailer'):
            restored, metadata = restore_output(body+TRAILER)
            self.assertEqual(restored, body+'\n200')
            self.assertEqual(metadata['timingMs']['appConnect'], 30)
            self.assertEqual(metadata['connectStatus'], 200)
            self.assertNotIn('PRIVATE', json.dumps(metadata))
        for field in ('nan', 'inf', '-1', '121', 'PRIVATE', '0.1|EXTRA'):
            restored, metadata = restore_output('PRIVATE'+TRAILER.replace('0.030', field))
            self.assertEqual(restored, 'PRIVATE\n200')
            self.assertIsNone(metadata)
        self.assertEqual(restore_output('PRIVATE\n200'), ('PRIVATE\n200', None))
        self.assertEqual(restore_output('PRIVATE\nCPQA1|bad'), ('PRIVATE\nCPQA1|bad', None))

    async def test_two_ordinals_cancelled_primary_and_exact_protocol_preservation(self):
        calls, results, held = [], [], asyncio.Event()
        core = SimpleNamespace(TRACE=TRACE, TARGET=TARGET)
        async def process(argv, timeout, max_bytes):
            calls.append((list(argv), timeout, max_bytes))
            if argv[-1] == TRACE and sum(a[0][-1] == TRACE for a in calls) == 1:
                held.set()
                await asyncio.Future()
            body = 'PRIVATE\n' if argv[-1] == TRACE else ''
            trailer = TRAILER if argv[-1] == TRACE else TRAILER.replace('|200|200|', '|204|200|')
            return 0, body+trailer
        extras = object()
        async def inspect(candidate, country, slow=False, **kwargs):
            self.assertIs(kwargs['extras'], extras)
            primary = asyncio.create_task(core.process(command(TRACE), 47, 2000000))
            target = asyncio.create_task(core.process(command(TARGET), 47, 2000000))
            await held.wait()
            results.append(await core.process(command(TRACE), 47, 2000000))
            results.append(await target)
            primary.cancel()
            await asyncio.gather(primary, return_exceptions=True)
            return {'ok': True, 'proxy': {'host': 'PRIVATE'}}
        core.process, core.inspect_proxy = process, inspect
        observer = NativeProbeObserver(core).attach()
        self.addCleanup(observer.close)
        caller = time.monotonic_ns()
        result = await core.inspect_proxy('PRIVATE', ['AT', 'EE', 'NO'], True, extras=extras)
        self.assertEqual(results, [(0, 'PRIVATE\n\n200'), (0, '\n204')])
        proof = project_native_probe(result['_qaProbe'], caller)
        self.assertFalse(proof['joinedEarlier'])
        self.assertEqual([(r['endpoint'], r['ordinal'], r['outcome']) for r in proof['controls']],
                         [('trace', 1, 'cancelled'), ('target', 1, 'completed'), ('trace', 2, 'completed')])
        self.assertIsNone(proof['controls'][0]['timingMs'])
        self.assertEqual(proof['controls'][2]['timingMs']['total'], 41)
        self.assertNotIn('PRIVATE', json.dumps(proof))
        self.assertNotIn('https://', json.dumps(proof))
        for argv, timeout, maximum in calls:
            original = command(argv[-1]); original[-2] = WRITE_OUT
            self.assertEqual(argv, original)
            self.assertEqual((timeout, maximum), (47, 2000000))
        self.assertEqual(command(TRACE)[-2], ORIGINAL_WRITE_OUT)

    async def test_only_exact_control_commands_are_changed_and_rows_are_bounded(self):
        calls = []
        core = SimpleNamespace(TRACE=TRACE, TARGET=TARGET)
        async def process(argv, *args):
            calls.append(list(argv))
            return 0, 'PRIVATE'+(TRAILER if WRITE_OUT in argv else '\n200')
        foreign = command(TRACE+'?foreign=PRIVATE')
        modified = command(TRACE); modified[-2] = '%{json}'
        duplicate = command(TRACE); duplicate[1:1] = ['--write-out', ORIGINAL_WRITE_OUT]
        async def inspect(*args, **kwargs):
            await core.process(foreign, 12)
            await core.process(modified, 12)
            await core.process(duplicate, 12)
            for url in (TRACE, TRACE, TRACE, TARGET, TARGET):
                await core.process(command(url), 12)
            return {'ok': True}
        core.process, core.inspect_proxy = process, inspect
        observer = NativeProbeObserver(core).attach();self.addCleanup(observer.close)
        caller = time.monotonic_ns();report = await core.inspect_proxy(None, 'AT')
        proof = project_native_probe(report['_qaProbe'], caller)
        self.assertEqual(calls[:3], [foreign, modified, duplicate])
        self.assertEqual(calls[5][-2], ORIGINAL_WRITE_OUT)
        self.assertTrue(proof['limited']);self.assertEqual(len(proof['controls']), 4)

    async def test_concurrent_physical_checks_do_not_share_context_or_failure_timing(self):
        core = SimpleNamespace(TRACE=TRACE, TARGET=TARGET)
        async def process(argv, *args):
            await asyncio.sleep(0)
            return (28 if argv[-1] == TARGET else 0), 'PRIVATE'+TRAILER
        async def inspect(candidate, country, slow=False):
            await core.process(command(candidate), 12)
            return {'ok': candidate == TRACE}
        core.process, core.inspect_proxy = process, inspect
        observer = NativeProbeObserver(core).attach();self.addCleanup(observer.close)
        before = time.monotonic_ns()
        a,b = await asyncio.gather(core.inspect_proxy(TRACE, 'AT'), core.inspect_proxy(TARGET, 'AT'))
        a,b = [project_native_probe(r['_qaProbe'], before) for r in (a,b)]
        self.assertEqual([r['endpoint'] for r in a['controls']], ['trace'])
        self.assertEqual([r['endpoint'] for r in b['controls']], ['target'])
        self.assertEqual(b['controls'][0]['curlCode'], 28)
        self.assertEqual(b['controls'][0]['timingMs']['total'], 41)
        self.assertIsNone(observer.current.get())

    async def test_exception_and_cancellation_never_invent_a_returned_probe(self):
        core = SimpleNamespace(TRACE=TRACE, TARGET=TARGET)
        entered = asyncio.Event()
        async def process(*args):
            entered.set();await asyncio.Future()
        async def inspect(*args, **kwargs):
            await core.process(command(TRACE), 12)
        core.process, core.inspect_proxy = process, inspect
        observer = NativeProbeObserver(core).attach();self.addCleanup(observer.close)
        task = asyncio.create_task(core.inspect_proxy(None, 'AT'))
        await entered.wait();task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        self.assertIsNone(observer.current.get())

    def test_projection_marks_shared_earlier_work_and_rejects_malformed_fields(self):
        record = {'version':1, '_startedNs':1000000, 'startedAtMs':100,
                  'elapsedMs':50, 'limited':False, 'controls':[{
                      'endpoint':'trace', 'ordinal':1, 'startMs':1, 'endMs':40,
                      'outcome':'completed', 'curlCode':0, 'httpStatus':200,
                      'connectStatus':200, 'timingMs':dict(nameLookup=1,connect=2,appConnect=3,
                          pretransfer=4,startTransfer=5,total=6), 'url':'PRIVATE'}]}
        proof = project_native_probe(record, 2000000)
        self.assertTrue(proof['joinedEarlier']);self.assertIsNone(proof['queueWaitMs'])
        self.assertNotIn('PRIVATE', json.dumps(proof))
        self.assertEqual(project_native_probe(record, 0)['queueWaitMs'], 1)
        for key,value in [('ordinal',3),('ordinal',True),('startMs',float('nan')),
                          ('endMs',51),('curlCode',False),('httpStatus',99),('endpoint','PRIVATE')]:
            invalid = copy.deepcopy(record);invalid['controls'][0][key] = value
            self.assertIsNone(project_native_probe(invalid, 0), key)
        duplicate = copy.deepcopy(record);duplicate['controls'] *= 2
        self.assertIsNone(project_native_probe(duplicate, 0))
        invalid = copy.deepcopy(record);invalid['controls'][0]['timingMs']['total'] = 'PRIVATE'
        self.assertIsNone(project_native_probe(invalid, 0))

    def test_json_exact_restoration_and_redaction(self):
        trailer = json_trailer(errormsg='PRIVATE https://private.invalid/ 192.0.2.100',
                               url_effective='https://private.invalid/', remote_ip='192.0.2.100')
        for body in ('', 'PRIVATE\n', 'text\r\nPRIVATE', 'body\nCPQA2|200|{"spoof":true}'):
            restored, metadata = restore_output(body + trailer, code=0)
            self.assertEqual(restored, body + '\n200')
            self.assertEqual(metadata['timingMs']['appConnect'], 30)
            self.assertEqual(metadata['diagnosis']['errorClass'], 'none')
            self.assertTrue(metadata['diagnosis']['tlsCompletedEvidence'])
            for private in ('PRIVATE', 'https://', '192.0.2.100', 'errormsg', 'url_effective'):
                self.assertNotIn(private, json.dumps(metadata))
        # The independent status survives even a malformed diagnostic payload.
        for payload in ('', '{bad', '[]', '{"http_code":200}', '{"nested":{"x":1}}'):
            text = 'body\r\n\nCPQA2|204|' + payload
            self.assertEqual(restore_output(text, code=0), ('body\r\n\n204', None))

    def test_json_strict_capped_scalar_schema(self):
        valid = json_trailer()
        invalid = [
            valid.replace('"exitcode":0', '"exitcode":0,"exitcode":0'),
            valid.replace('"time_total":0.041', '"time_total":NaN'),
            valid.replace('"time_total":0.041', '"time_total":Infinity'),
            json_trailer(time_connect=True), json_trailer(time_connect='0.01'),
            json_trailer(time_connect=-.01), json_trailer(time_total=121),
            json_trailer(ssl_verify_result=True), json_trailer(proxy_ssl_verify_result=-1),
            json_trailer(ssl_verify_result=2147483648), json_trailer(exitcode=True),
            json_trailer(http_connect=99), json_trailer(extra={'nested': 1}),
            json_trailer(extra=[1]), json_trailer(extra='x'*16385),
            json_trailer(extra='Ж'*9000).replace('\\u0416', 'Ж'),
            json_trailer(extra='x', **{f'key{i}':i for i in range(128)}),
        ]
        for text in invalid:
            with self.subTest(case=invalid.index(text)):
                restored, metadata = restore_output('body' + text, code=0)
                self.assertEqual(restored, 'body\n200')
                self.assertIsNone(metadata)
        self.assertIsNone(restore_output(valid, code=35)[1])
        mismatch = valid.replace('CPQA2|200|', 'CPQA2|204|')
        self.assertEqual(restore_output('body' + mismatch, code=0), ('body\n204', None))

    def test_numeric_prefix_survives_oversized_invalid_or_mismatched_json(self):
        trailer = numeric_trailer(60, 0, ssl_verify_result=18, certs='PRIVATE'*4000,
                                  time_appconnect=0, time_pretransfer=0, time_starttransfer=0,
                                  time_total=30)
        prefix = trailer.rsplit('|', 1)[0]
        for payload in (trailer.rsplit('|', 1)[1], '', '{bad', '[]', '{"exitcode":0}'):
            for body in ('', 'PRIVATE\n', 'body\r\n', 'body\nCPQA3|000|spoof'):
                with self.subTest(payload_size=len(payload), body_size=len(body)):
                    restored, metadata = restore_output(body + prefix + '|' + payload, code=60)
                    self.assertEqual(restored, body + '\n000')
                    self.assertEqual(metadata['metadataMode'], 'numeric_only')
                    self.assertEqual(metadata['timingMs']['total'], 30000)
                    self.assertEqual(metadata['diagnosis']['errorClass'], 'certificate')
                    self.assertEqual(metadata['diagnosis']['sslVerifyResult'], 18)
                    self.assertNotIn('PRIVATE', json.dumps(metadata))

    def test_matching_json_hint_and_every_numeric_prefix_field_are_checked(self):
        trailer = numeric_trailer(35, 0, errormsg='SSL_ERROR_SYSCALL PRIVATE', time_appconnect=0,
                                  time_pretransfer=0, time_starttransfer=0)
        restored, metadata = restore_output('body' + trailer, code=35)
        self.assertEqual(restored, 'body\n000')
        self.assertEqual(metadata['metadataMode'], 'json')
        self.assertEqual(metadata['diagnosis']['errorClass'], 'tls_io')
        prefix, payload = trailer.rsplit('|', 1)
        data = json.loads(payload)
        for field in ('exitcode', 'http_code', 'http_connect', 'ssl_verify_result', 'proxy_ssl_verify_result',
                      'time_namelookup', 'time_connect', 'time_appconnect', 'time_pretransfer',
                      'time_starttransfer', 'time_total'):
            altered = dict(data)
            altered[field] += .0000001 if field.startswith('time_') else 1
            with self.subTest(field=field):
                restored, mismatch = restore_output('body' + prefix + '|' + json.dumps(altered), code=35)
                self.assertEqual(restored, 'body\n000')
                self.assertEqual(mismatch['metadataMode'], 'numeric_only')
                self.assertEqual(mismatch['diagnosis']['errorClass'], 'tls_handshake')
                self.assertEqual(mismatch['timingMs'], metadata['timingMs'])

    def test_invalid_numeric_prefix_never_invents_metadata_or_changes_body(self):
        trailer = numeric_trailer(28, 0)
        parts = trailer[1:].split('|', 12)
        cases = [(2, 'true'), (2, '-1'), (2, '0'), (3, '099'), (3, '600'),
                 (4, '-1'), (4, 'true'), (4, '2147483648'), (5, 'NaN'),
                 (6, 'nan'), (7, 'Infinity'), (8, '-1'), (9, '121'),
                 (10, '1e-3'), (11, '0.'+'1'*300)]
        for index, value in cases:
            altered = list(parts)
            altered[index] = value
            with self.subTest(index=index, value_size=len(value)):
                self.assertEqual(restore_output('body\r\n\n' + '|'.join(altered), code=28),
                                 ('body\r\n\n000', None))
        self.assertIsNone(restore_output(trailer, code=False)[1])

    async def test_numeric_only_failure_projection_keeps_code_timings_and_mode(self):
        core = SimpleNamespace(TRACE=TRACE, TARGET=TARGET)
        async def process(argv, timeout, max_bytes):
            self.assertEqual((timeout, max_bytes), (47, 2000000))
            return 60, 'body' + numeric_trailer(60, 0, ssl_verify_result=18, certs='PRIVATE'*4000,
                                               time_appconnect=0, time_pretransfer=0, time_starttransfer=0)
        async def inspect(*args, **kwargs):
            self.assertEqual(await core.process(command(TRACE), 47, 2000000), (60, 'body\n000'))
            return {'ok':False, 'reason':'tls', 'code':60}
        core.process, core.inspect_proxy = process, inspect
        observer = NativeProbeObserver(core).attach()
        self.addCleanup(observer.close)
        caller = time.monotonic_ns()
        report = await core.inspect_proxy(None, 'AT')
        row = project_native_probe(report['_qaProbe'], caller)['controls'][0]
        self.assertEqual((row['outcome'], row['curlCode'], row['metadataMode']), ('failed', 60, 'numeric_only'))
        self.assertEqual(row['diagnosis']['errorClass'], 'certificate')
        self.assertEqual(row['timingMs']['total'], 41)
        self.assertNotIn('PRIVATE', json.dumps(report))
        for mode in ('PRIVATE', True, None):
            invalid = copy.deepcopy(report['_qaProbe'])
            invalid['controls'][0]['metadataMode'] = mode
            self.assertIsNone(project_native_probe(invalid, caller))
        for field in ('timingMs', 'diagnosis'):
            invalid = copy.deepcopy(report['_qaProbe'])
            invalid['controls'][0][field] = None
            self.assertIsNone(project_native_probe(invalid, caller))

    def test_failed_partial_timings_and_diagnostic_limits(self):
        cases = [(35, {}, 'tls_handshake', 'negotiation_or_tls'),
                 (35, {'errormsg':'SSL_ERROR_SYSCALL in connection to PRIVATE'}, 'tls_io', 'negotiation_or_tls'),
                 (35, {'errormsg':'unexpected EOF PRIVATE'}, 'tls_closed', 'negotiation_or_tls'),
                 (28, {'errormsg':'Connection timed out after 30000 milliseconds PRIVATE'}, 'timeout', 'negotiation_or_tls'),
                 (28, {'time_appconnect':.02}, 'timeout', 'post_tls'),
                 (28, {'time_appconnect':.02, 'time_starttransfer':.025}, 'timeout', 'response'),
                 (97, {}, 'proxy_negotiation', 'proxy_negotiation'),
                 (7, {}, 'tcp_connect', 'tcp_connect'), (6, {}, 'dns', 'dns'),
                 (60, {'ssl_verify_result':20}, 'certificate', 'tls')]
        for code, extra, kind, phase in cases:
            fields = dict(time_appconnect=0, time_pretransfer=0, time_starttransfer=0, time_total=30)
            fields.update(extra)
            with self.subTest(code=code, kind=kind, phase=phase):
                restored, metadata = restore_output('body' + json_trailer(code, 0, **fields), code=code)
                self.assertEqual(restored, 'body\n000')
                self.assertEqual(metadata['timingMs']['connect'], 10)
                self.assertEqual(metadata['timingMs']['total'], 30000)
                self.assertEqual(metadata['diagnosis']['errorClass'], kind)
                self.assertEqual(metadata['diagnosis']['phase'], phase)
                self.assertEqual(metadata['diagnosis']['tlsCompletedEvidence'], fields['time_appconnect'] > 0)
                self.assertNotIn('PRIVATE', json.dumps(metadata))

    async def test_json_failure_metadata_is_whitelisted_in_returned_probe(self):
        core = SimpleNamespace(TRACE=TRACE, TARGET=TARGET)
        calls = []
        async def process(argv, timeout, max_bytes):
            calls.append((list(argv), timeout, max_bytes))
            return 28, 'PRIVATE' + json_trailer(28, 0, errormsg='PRIVATE 192.0.2.1',
                url_effective='https://private.invalid/', time_appconnect=0, time_pretransfer=0,
                time_starttransfer=0, time_total=30)
        async def inspect(*args, **kwargs):
            result = await core.process(command(TRACE), 47, 2000000)
            self.assertEqual(result, (28, 'PRIVATE\n000'))
            return {'ok': False, 'reason':'timeout'}
        core.process, core.inspect_proxy = process, inspect
        observer = NativeProbeObserver(core).attach()
        self.addCleanup(observer.close)
        caller = time.monotonic_ns()
        report = await core.inspect_proxy(None, 'AT')
        proof = project_native_probe(report['_qaProbe'], caller)
        row = proof['controls'][0]
        self.assertEqual(row['outcome'], 'failed')
        self.assertEqual(row['timingMs']['total'], 30000)
        self.assertEqual(row['diagnosis']['phase'], 'negotiation_or_tls')
        self.assertEqual(calls, [(command(TRACE)[:-2] + [WRITE_OUT, TRACE], 47, 2000000)])
        for private in ('PRIVATE', '192.0.2.1', 'https://', 'errormsg', 'url_effective'):
            self.assertNotIn(private, json.dumps(report['_qaProbe']))
            self.assertNotIn(private, json.dumps(proof))

    def test_projection_rejects_invalid_diagnosis_and_cancelled_evidence(self):
        _, metadata = restore_output(json_trailer(28, 0, time_appconnect=0), code=28)
        row = dict(endpoint='trace', ordinal=1, startMs=1, endMs=40, outcome='failed', curlCode=28,
                   **metadata)
        record = dict(version=1, _startedNs=1000, startedAtMs=100, elapsedMs=50, limited=False,
                      controls=[row])
        self.assertIsNotNone(project_native_probe(record, 0))
        for key, value in [('errorClass','PRIVATE'), ('phase','PRIVATE'),
                           ('sslVerifyResult',True), ('proxySslVerifyResult',-1),
                           ('tlsCompletedEvidence',1)]:
            invalid = copy.deepcopy(record)
            invalid['controls'][0]['diagnosis'][key] = value
            self.assertIsNone(project_native_probe(invalid, 0))
        invalid = copy.deepcopy(record)
        invalid['controls'][0].update(outcome='cancelled', curlCode=None)
        self.assertIsNone(project_native_probe(invalid, 0))
        invalid = copy.deepcopy(record)
        invalid['controls'][0]['diagnosis']['tlsCompletedEvidence'] = True
        self.assertIsNone(project_native_probe(invalid, 0))

    async def test_truncated_json_is_unknown_metadata_with_exact_product_status(self):
        core = SimpleNamespace(TRACE=TRACE, TARGET=TARGET)
        async def process(argv, timeout, max_bytes):
            self.assertEqual((timeout, max_bytes), (47, 2000000))
            return 0, ('body' + json_trailer())[:-10]
        async def inspect(*args, **kwargs):
            self.assertEqual(await core.process(command(TRACE), 47, 2000000), (0, 'body\n200'))
            return {'ok':True}
        core.process, core.inspect_proxy = process, inspect
        observer = NativeProbeObserver(core).attach()
        self.addCleanup(observer.close)
        caller = time.monotonic_ns()
        report = await core.inspect_proxy(None, 'AT')
        row = project_native_probe(report['_qaProbe'], caller)['controls'][0]
        self.assertEqual((row['outcome'], row['curlCode']), ('completed', 0))
        self.assertIsNone(row['timingMs'])
        self.assertNotIn('diagnosis', row)

    async def test_original_stdout_cap_is_not_expanded_for_json_overhead(self):
        core = SimpleNamespace(TRACE=TRACE, TARGET=TARGET)
        async def process(argv, timeout, max_bytes):
            self.assertEqual((timeout, max_bytes), (47, 2000000))
            body = 'x' * (max_bytes - len('\n200'))
            self.assertEqual(len(body + '\n200'), max_bytes)
            if len(body + numeric_trailer()) > max_bytes:
                raise ValueError('response too large')
            raise AssertionError('fixture must exceed unchanged cap')
        async def inspect(*args, **kwargs):
            try:
                await core.process(command(TRACE), 47, 2000000)
            except ValueError:
                return {'ok':False, 'reason':'internal'}
            raise AssertionError('unchanged cap must reject')
        core.process, core.inspect_proxy = process, inspect
        observer = NativeProbeObserver(core).attach()
        self.addCleanup(observer.close)
        caller = time.monotonic_ns()
        report = await core.inspect_proxy(None, 'AT')
        self.assertEqual(report['reason'], 'internal')
        row = project_native_probe(report['_qaProbe'], caller)['controls'][0]
        self.assertEqual((row['outcome'], row['curlCode']), ('error', None))
        self.assertIsNone(row['timingMs'])
        self.assertNotIn('diagnosis', row)

    async def test_public_helper_real_session_promotion_records_the_hedged_physical_check(self):
        import public_group_host as public
        core=public.core
        calls=[]
        async def process(argv,*args):
            url=argv[-1];calls.append(url)
            if url==TRACE and calls.count(TRACE)==1:await asyncio.Future()
            if url==TRACE:return 0,'loc=AT\nip=8.8.4.4\n'+TRAILER
            return 0,TRAILER.replace('|200|200|','|204|200|')
        with TemporaryDirectory() as directory, patch.object(core,'process',process), \
                patch.object(core,'inspect_proxy',core.inspect_proxy), \
                patch.object(core.Session,'_budgeted',core.Session._budgeted), \
                patch.object(public.host,'Session',public.host.Session), \
                patch.object(core,'RESERVE_EXTRA_DELAY',.005):
            folder=Path(directory)
            public.monitor(folder,1,observe_offers=True)
            session=public.host.Session(['AT','EE','NO'],lambda event:None)
            item=core.Candidate('http','192.0.2.100',8080)
            old=dict(scheme=item.scheme,host=item.host,port=item.port,country='AT',
                     exitIp='8.8.8.8',latencyMs=10,checkedAt=100)
            self.assertTrue(session.pool.accept(old))
            result=await asyncio.wait_for(session.pool.take(),1)
            self.assertEqual(result['exitIp'],'8.8.4.4')
            self.assertEqual((folder/'started').read_text(),'1')
            data=json.loads((folder/'offers-0001.json').read_text())
            [row]=data['takes'][0]['rechecks']
            self.assertEqual(row['outcome'],'passed')
            controls=row['nativeProbe']['controls']
            self.assertEqual([(r['endpoint'],r['ordinal'],r['outcome']) for r in controls],
                             [('trace',1,'cancelled'),('target',1,'completed'),('trace',2,'completed')])
            self.assertNotIn('192.0.2.100',json.dumps(data))
            self.assertNotIn('8.8.4.4',json.dumps(data))
            self.assertEqual(session.supplemental_budget.running,0)
            await session.check_budget.close()

    async def test_public_limit_wrapper_forwards_optional_extras(self):
        import public_group_host as public
        extras = object()
        async def inspect(candidate, country, slow=False, **kwargs):
            self.assertIs(kwargs['extras'], extras)
            return {'ok': True}
        with TemporaryDirectory() as directory, patch.object(public.core,'inspect_proxy',inspect), \
                patch.object(public.core.Session,'_budgeted',public.core.Session._budgeted):
            public.monitor(Path(directory), 1)
            self.assertEqual(await public.core.inspect_proxy(None, 'AT', extras=extras), {'ok':True})
            self.assertEqual((Path(directory)/'started').read_text(), '1')


if __name__ == '__main__':
    unittest.main()
