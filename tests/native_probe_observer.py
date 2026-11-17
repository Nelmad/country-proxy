"""Test-only per-control curl timings; never retains URLs, addresses, headers or bodies.

Only exact production control commands are instrumented. curl times are cumulative
seconds from that curl start, not disjoint TCP/SOCKS/TLS intervals:
https://curl.se/docs/manpage.html#-w
The fixed numeric prefix survives unusable optional JSON. Its transient trailer
shares the original stdout cap; a response at that cap
can be rejected slightly earlier. No product timeout or size limit is relaxed.
JSON strings (including errormsg, URLs and addresses) are never retained. Positive
appConnect is TLS completion evidence, possibly outer TLS for an HTTPS proxy;
connect without appConnect cannot separate SOCKS negotiation from TLS.
"""
import asyncio
from contextvars import ContextVar
import json
import math
import re
import time

ORIGINAL_WRITE_OUT = '\n%{http_code}'
TIMING_KEYS = ('nameLookup', 'connect', 'appConnect', 'pretransfer', 'startTransfer', 'total')
CURL_FIELDS = ('http_code', 'http_connect', 'time_namelookup', 'time_connect',
               'time_appconnect', 'time_pretransfer', 'time_starttransfer', 'time_total')
WRITE_OUT = ('\nCPQA3|%{http_code}|%{exitcode}|%{http_connect}|%{ssl_verify_result}|%{proxy_ssl_verify_result}|'
             + '|'.join('%{' + name + '}' for name in CURL_FIELDS[2:]) + '|%{json}')
MAX_JSON_BYTES = 16384
ERROR_CLASSES = frozenset(('none', 'certificate', 'tls_handshake', 'tls_io', 'tls_closed',
                           'timeout', 'dns', 'proxy_negotiation', 'tcp_connect', 'transport', 'unknown'))
PHASES = frozenset(('complete', 'dns', 'tcp_connect', 'proxy_negotiation', 'tls',
                   'negotiation_or_tls', 'post_tls', 'response', 'unknown'))
MAX_MS = 120000
MAX_SAFE_INTEGER = 2**53-1
OUTCOMES = frozenset(('completed', 'failed', 'cancelled', 'timeout', 'error'))


def milliseconds(value):
    return (round(value, 3) if type(value) in (int, float) and math.isfinite(value)
            and 0 <= value <= MAX_MS else None)


def integer(value, maximum=MAX_SAFE_INTEGER):
    return type(value) is int and 0 <= value <= maximum


def classify_error(code, message, timing, ssl_verify, proxy_ssl_verify):
    """Error class is a text/code hint, never proof of cause or responsibility.

    Phase uses cumulative numeric evidence and exit code only. Untrusted error
    text must not make ambiguous negotiation/TLS timing look like a proven phase.
    """
    message = message.lower() if isinstance(message, str) and len(message) <= 2048 else ''
    tls_completed = timing['appConnect'] > 0
    phase = ('response' if timing['startTransfer'] > 0 else 'post_tls' if tls_completed
             else 'negotiation_or_tls' if timing['connect'] > 0 else 'unknown')
    if code == 0:
        kind, phase = 'none', 'complete'
    elif code in (51, 60):
        kind, phase = 'certificate', 'tls'
    elif code == 35:
        kind = ('tls_closed' if 'unexpected eof' in message or 'connection closed' in message
                else 'tls_io' if 'ssl_error_syscall' in message else 'tls_handshake')
    elif code == 28:
        kind = 'timeout'
    elif code in (5, 6):
        kind, phase = 'dns', 'dns'
    elif code == 97:
        kind, phase = 'proxy_negotiation', 'proxy_negotiation'
    elif code == 7:
        kind, phase = 'tcp_connect', 'tcp_connect'
    else:
        kind = 'transport'
    return {'errorClass': kind, 'phase': phase, 'sslVerifyResult': ssl_verify,
            'proxySslVerifyResult': proxy_ssl_verify, 'tlsCompletedEvidence': tls_completed}


def json_metadata(payload, status, code, *, expected_fields=None):
    """Strict bounded transient parsing; return only the numeric/enum whitelist."""
    if len(payload) > MAX_JSON_BYTES:
        return None
    def pairs(items):
        if len(items) > 128 or len({key for key, _ in items}) != len(items):
            raise ValueError('invalid diagnostic object')
        return dict(items)
    def constant(_):
        raise ValueError('nonfinite diagnostic number')
    try:
        if len(payload.encode('utf-8')) > MAX_JSON_BYTES:
            return None
        value = json.loads(payload, object_pairs_hook=pairs, parse_constant=constant)
        if not isinstance(value, dict) or any(isinstance(v, (dict, list)) for v in value.values()):
            return None
        if code is not None and not integer(code, 999):
            return None
        if expected_fields is not None and any(value.get(name) != expected for name, expected in expected_fields.items()):
            return None
        exit_code = value.get('exitcode')
        if not integer(exit_code, 999) or (code is not None and exit_code != code):
            return None
        http, connect = value.get('http_code'), value.get('http_connect')
        if (not integer(http, 599) or (0 < http < 100) or http != int(status)
                or not integer(connect, 599) or 0 < connect < 100):
            return None
        timing = {}
        for name, field in zip(TIMING_KEYS, CURL_FIELDS[2:]):
            raw = value.get(field)
            if type(raw) not in (int, float):
                return None
            timing[name] = milliseconds(raw * 1000)
            if timing[name] is None:
                return None
        verify = []
        for field in ('ssl_verify_result', 'proxy_ssl_verify_result'):
            raw = value.get(field)
            if raw is not None and not integer(raw, 2147483647):
                return None
            verify.append(raw)
        diagnosis = classify_error(exit_code, value.get('errormsg'), timing, *verify)
        return {'httpStatus': http, 'connectStatus': connect, 'timingMs': timing, 'diagnosis': diagnosis}
    except (ValueError, TypeError, OverflowError, RecursionError):
        return None


def restore_output(text, *, code=None):
    """Restore the original body + newline + status even if timing fields are bad."""
    body, separator, tail = text.rpartition('\n')
    parts = tail.split('|', 2)
    if not separator or len(parts) < 2 or parts[0] not in ('CPQA1', 'CPQA2', 'CPQA3') or not re.fullmatch(r'[0-9]{3}', parts[1]):
        return text, None
    restored = body + '\n' + parts[1]
    if parts[0] == 'CPQA3':
        return restored, numeric_metadata(tail.split('|', 12), code)
    if parts[0] == 'CPQA2':
        return restored, json_metadata(parts[2], parts[1], code) if len(parts) == 3 else None
    # Read old fixture trailers too; they carry no error classification.
    parts = tail.split('|')
    if len(parts) != 9 or len(tail) > 256 or not re.fullmatch(r'[0-9]{3}', parts[2]):
        return restored, None
    if any(not re.fullmatch(r'[0-9]{1,6}(?:\.[0-9]{1,9})?', v) for v in parts[3:]):
        return restored, None
    timings = dict(zip(TIMING_KEYS, (milliseconds(float(v)*1000) for v in parts[3:])))
    if any(v is None for v in timings.values()):
        return restored, None
    return restored, {'httpStatus': int(parts[1]), 'connectStatus': int(parts[2]), 'timingMs': timings}


def numeric_metadata(parts, code):
    """The fixed numeric prefix survives an unusable optional JSON hint."""
    if len(parts) != 13 or len('|'.join(parts[:12])) > 256 or code is not None and not integer(code, 999):
        return None
    if (not re.fullmatch('[0-9]{3}', parts[1]) or not re.fullmatch('[0-9]{1,3}', parts[2])
            or not re.fullmatch('[0-9]{3}', parts[3])
            or any(not re.fullmatch('[0-9]{1,10}', value) for value in parts[4:6])
            or any(not re.fullmatch(r'[0-9]{1,6}(?:\.[0-9]{1,9})?', value) for value in parts[6:12])):
        return None
    status, exit_code, connect, verify, proxy_verify = map(int, parts[1:6])
    if (status > 599 or 0 < status < 100 or connect > 599 or 0 < connect < 100
            or not integer(verify, 2147483647) or not integer(proxy_verify, 2147483647)
            or code is not None and exit_code != code):
        return None
    timing = {name: milliseconds(float(value) * 1000) for name, value in zip(TIMING_KEYS, parts[6:12])}
    if any(value is None for value in timing.values()):
        return None
    metadata = {'httpStatus': status, 'connectStatus': connect, 'timingMs': timing,
                'diagnosis': classify_error(exit_code, '', timing, verify, proxy_verify),
                'metadataMode': 'numeric_only'}
    expected = dict(zip(CURL_FIELDS[2:], (float(value) for value in parts[6:12])))
    expected.update(http_connect=connect, ssl_verify_result=verify, proxy_ssl_verify_result=proxy_verify)
    hint = json_metadata(parts[12], parts[1], exit_code, expected_fields=expected)
    if (hint is not None and all(hint[name] == metadata[name] for name in ('httpStatus', 'connectStatus', 'timingMs'))
            and hint['diagnosis']['sslVerifyResult'] == verify
            and hint['diagnosis']['proxySslVerifyResult'] == proxy_verify):
        metadata['diagnosis'] = hint['diagnosis']
        metadata['metadataMode'] = 'json'
    return metadata


def project_native_probe(value, caller_started_ns):
    """Whitelist the exact returned physical report, including shared earlier work."""
    if (not isinstance(value, dict) or value.get('version') != 1 or
            not integer(value.get('startedAtMs')) or not integer(value.get('_startedNs'), 2**63-1) or
            not integer(caller_started_ns, 2**63-1) or not isinstance(value.get('controls'), list) or
            len(value['controls']) > 4 or type(value.get('limited')) is not bool):
        return None
    elapsed = milliseconds(value.get('elapsedMs'))
    if elapsed is None:
        return None
    delta = (value['_startedNs'] - caller_started_ns)/1_000_000
    queue_wait = milliseconds(delta) if delta >= 0 else None
    if delta >= 0 and queue_wait is None:
        return None
    rows, seen = [], set()
    for raw in value['controls']:
        if not isinstance(raw, dict):
            return None
        endpoint, ordinal = raw.get('endpoint'), raw.get('ordinal')
        if endpoint not in ('trace', 'target') or type(ordinal) is not int or ordinal not in (1, 2) or (endpoint, ordinal) in seen:
            return None
        seen.add((endpoint, ordinal))
        start, end = milliseconds(raw.get('startMs')), milliseconds(raw.get('endMs'))
        if start is None or end is None or end < start or end > elapsed or raw.get('outcome') not in OUTCOMES:
            return None
        code = raw.get('curlCode')
        if code is not None and not integer(code, 999):
            return None
        if (raw['outcome'] == 'completed' and code != 0 or
                raw['outcome'] == 'failed' and not (integer(code, 999) and code > 0) or
                raw['outcome'] in ('cancelled', 'timeout', 'error') and code is not None):
            return None
        row = {'endpoint': endpoint, 'ordinal': ordinal, 'startMs': start, 'endMs': end,
               'outcome': raw['outcome'], 'curlCode': code, 'httpStatus': None,
               'connectStatus': None, 'timingMs': None}
        if 'metadataMode' in raw:
            if raw['metadataMode'] not in ('json', 'numeric_only') or raw['outcome'] not in ('completed', 'failed'):
                return None
            row['metadataMode'] = raw['metadataMode']
        for name in ('httpStatus', 'connectStatus'):
            status = raw.get(name)
            if status is not None and (not integer(status, 599) or 0 < status < 100):
                return None
            row[name] = status
        timing = raw.get('timingMs')
        if timing is not None:
            if raw['outcome'] not in ('completed', 'failed') or not isinstance(timing, dict):
                return None
            parsed = {name: milliseconds(timing.get(name)) for name in TIMING_KEYS}
            if any(v is None for v in parsed.values()):
                return None
            row['timingMs'] = parsed
        diagnosis = raw.get('diagnosis')
        if 'metadataMode' in raw and (row['timingMs'] is None or not isinstance(diagnosis, dict)):
            return None
        if diagnosis is not None:
            if (raw['outcome'] not in ('completed', 'failed') or not isinstance(diagnosis, dict)
                    or diagnosis.get('errorClass') not in ERROR_CLASSES or diagnosis.get('phase') not in PHASES
                    or type(diagnosis.get('tlsCompletedEvidence')) is not bool):
                return None
            for name in ('sslVerifyResult', 'proxySslVerifyResult'):
                if diagnosis.get(name) is not None and not integer(diagnosis[name], 2147483647):
                    return None
            if row['timingMs'] is None or diagnosis['tlsCompletedEvidence'] != (row['timingMs']['appConnect'] > 0):
                return None
            row['diagnosis'] = {key: diagnosis.get(key) for key in ('errorClass', 'phase',
                               'sslVerifyResult', 'proxySslVerifyResult', 'tlsCompletedEvidence')}
        rows.append(row)
    return {'version': 1, 'startedAtMs': value['startedAtMs'], 'elapsedMs': elapsed,
            'queueWaitMs': queue_wait, 'joinedEarlier': delta < 0,
            'limited': value['limited'], 'controls': rows}


class NativeProbeObserver:
    def __init__(self, core):
        self.core = core
        self.current = ContextVar('qa_native_probe', default=None)
        self.original_inspect = core.inspect_proxy
        self.original_process = core.process
        self.inspected = self.processed = None

    def attach(self):
        async def inspected(candidate, country, slow=False, **kwargs):
            start = time.monotonic_ns()
            record = {'version': 1, '_startedNs': start, 'startedAtMs': time.time_ns()//1_000_000,
                      'elapsedMs': None, 'limited': False, 'controls': []}
            token = self.current.set(record)
            try:
                report = await self.original_inspect(candidate, country, slow, **kwargs)
                record['elapsedMs'] = milliseconds((time.monotonic_ns()-start)/1_000_000)
                # Only an actual returned object can establish this attribution.
                # A cancelled caller has no report and must remain unknown.
                if isinstance(report, dict):
                    report['_qaProbe'] = record
                return report
            finally:
                self.current.reset(token)

        async def processed(argv, timeout, max_bytes=2_000_000):
            record = self.current.get()
            endpoints = {self.core.TRACE: 'trace', self.core.TARGET: 'target'}
            exact = (record is not None and isinstance(argv, (list, tuple)) and len(argv) >= 4 and
                     argv[0] == '/usr/bin/curl' and argv[-1] in endpoints and argv.count('--write-out') == 1)
            index = argv.index('--write-out') if exact else -1
            if not exact or index+1 >= len(argv)-1 or argv[index+1] != ORIGINAL_WRITE_OUT:
                return await self.original_process(argv, timeout, max_bytes)
            endpoint = endpoints[argv[-1]]
            ordinal = 1 + sum(row['endpoint'] == endpoint for row in record['controls'])
            if ordinal > 2 or len(record['controls']) >= 4:
                record['limited'] = True
                return await self.original_process(argv, timeout, max_bytes)
            start = time.monotonic_ns()
            row = {'endpoint': endpoint, 'ordinal': ordinal,
                   'startMs': milliseconds((start-record['_startedNs'])/1_000_000), 'endMs': None,
                   'outcome': 'error', 'curlCode': None, 'httpStatus': None, 'connectStatus': None, 'timingMs': None}
            record['controls'].append(row)
            command = list(argv)
            command[index+1] = WRITE_OUT
            try:
                code, text = await self.original_process(command, timeout, max_bytes)
                restored, timing = restore_output(text, code=code)
                row['curlCode'] = code if integer(code, 999) else None
                row['outcome'] = 'completed' if code == 0 else 'failed'
                if timing:
                    row.update(timing)
                return code, restored
            except asyncio.CancelledError:
                row['outcome'] = 'cancelled'
                raise
            except TimeoutError:
                row['outcome'] = 'timeout'
                raise
            finally:
                row['endMs'] = milliseconds((time.monotonic_ns()-record['_startedNs'])/1_000_000)

        self.inspected, self.processed = inspected, processed
        self.core.inspect_proxy, self.core.process = inspected, processed
        return self

    def close(self):
        if self.core.inspect_proxy is self.inspected:
            self.core.inspect_proxy = self.original_inspect
        if self.core.process is self.processed:
            self.core.process = self.original_process
