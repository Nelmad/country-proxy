"""Real local curl phase oracle; only bounded projected diagnostics leave memory.

All upstream sockets are loopback. Disposable TLS credentials exist only in one
TemporaryDirectory and are never included in receipts. No product code changes.
"""
import argparse
import asyncio
import hashlib
import json
import math
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import native_probe_observer as observer

ERROR_CLASSES = {'none', 'certificate', 'tls_handshake', 'tls_io', 'tls_closed',
                 'timeout', 'dns', 'proxy_negotiation', 'tcp_connect', 'transport', 'unknown'}
PHASES = {'complete', 'dns', 'tcp_connect', 'proxy_negotiation', 'tls',
          'negotiation_or_tls', 'post_tls', 'response', 'unknown'}
CASES = ('proxy_tcp_unavailable', 'proxy_accept_hold', 'connect_hold', 'socks_greeting_hold',
         'socks_request_hold', 'tls_close', 'tls_hold', 'invalid_certificate',
         'after_tls_response_hold', 'after_tls_close', 'valid_tls')
CONNECT_TIMEOUT = .6
TOTAL_TIMEOUT = 1.5
PROCESS_TIMEOUT = 4


def number(value, maximum=120000):
    return round(value, 3) if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum else None


def projection(parsed, code):
    """Second independent whitelist; malformed observer output never reaches disk."""
    parsed = parsed if isinstance(parsed, dict) else {}
    diagnosis = parsed.get('diagnosis')
    diagnosis = diagnosis if isinstance(diagnosis, dict) else {}
    safe = {'curlCode': code if type(code) is int and 0 <= code <= 255 else None,
            'httpStatus': None, 'connectStatus': None, 'timingMs': None,
            'diagnosis': {'errorClass': diagnosis.get('errorClass') if diagnosis.get('errorClass') in ERROR_CLASSES else 'unknown',
                          'phase': diagnosis.get('phase') if diagnosis.get('phase') in PHASES else 'unknown',
                          'sslVerifyResult': None, 'proxySslVerifyResult': None,
                          'tlsCompletedEvidence': diagnosis.get('tlsCompletedEvidence') is True}}
    for key in ('httpStatus', 'connectStatus'):
        value = parsed.get(key)
        if type(value) is int and (value == 0 or 100 <= value <= 599):
            safe[key] = value
    for key in ('sslVerifyResult', 'proxySslVerifyResult'):
        value = diagnosis.get(key)
        if type(value) is int and 0 <= value <= 2**31 - 1:
            safe['diagnosis'][key] = value
    timing = parsed.get('timingMs')
    if isinstance(timing, dict):
        values = {key: number(timing.get(key)) for key in observer.TIMING_KEYS}
        if all(value is not None for value in values.values()):
            safe['timingMs'] = values
    return safe


class Fixture:
    def __init__(self, case, good_context, bad_context):
        self.case = case
        self.good_context, self.bad_context = good_context, bad_context
        self.servers, self.writers, self.tasks = [], set(), set()
        self.refusal_socket = None
        self.oracle = {'tcpAccepted': 0, 'connectRequest': 0, 'socksGreeting': 0,
                       'socksRequest': 0, 'tlsClientHello': 0, 'tlsServerAccepted': 0,
                       'decryptedRequest': 0}

    async def listen(self, operation, tls=None):
        def connected(reader, writer):
            async def owned():
                self.writers.add(writer)
                try:
                    await operation(reader, writer)
                except (ConnectionError, OSError, asyncio.IncompleteReadError, ssl.SSLError):
                    pass
                finally:
                    writer.close()
                    try:
                        await asyncio.wait_for(writer.wait_closed(), .3)
                    except (Exception, asyncio.CancelledError):
                        writer.transport.abort()
                    self.writers.discard(writer)
            task = asyncio.create_task(owned())
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        server = await asyncio.start_server(connected, '127.0.0.1', 0, ssl=tls,
                                            ssl_handshake_timeout=.8 if tls else None)
        self.servers.append(server)
        return server.sockets[0].getsockname()[1]

    async def origin(self, reader, writer):
        self.oracle['tlsServerAccepted'] += 1
        request = await reader.readuntil(b'\r\n\r\n')
        if len(request) > 4096:
            return
        self.oracle['decryptedRequest'] += 1
        if self.case == 'after_tls_response_hold':
            await asyncio.Future()
        elif self.case == 'after_tls_close':
            return
        else:
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK')
            await writer.drain()

    async def proxy(self, reader, writer):
        self.oracle['tcpAccepted'] += 1
        if self.case == 'proxy_accept_hold':
            await asyncio.Future()
        if self.case.startswith('socks_'):
            greeting = await reader.readexactly(2)
            await reader.readexactly(greeting[1])
            self.oracle['socksGreeting'] += 1
            if self.case == 'socks_greeting_hold':
                await asyncio.Future()
            writer.write(b'\x05\x00')
            await writer.drain()
            prefix = await reader.readexactly(4)
            if prefix[3] == 3:
                size = (await reader.readexactly(1))[0]
            elif prefix[3] == 1:
                size = 4
            else:
                return
            await reader.readexactly(size + 2)
            self.oracle['socksRequest'] += 1
            await asyncio.Future()
        request = await reader.readuntil(b'\r\n\r\n')
        if len(request) > 4096 or not request.startswith(b'CONNECT phase.invalid:443 '):
            return
        self.oracle['connectRequest'] += 1
        if self.case == 'connect_hold':
            await asyncio.Future()
        writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        await writer.drain()
        if self.case in ('tls_close', 'tls_hold'):
            hello = await reader.readexactly(6)
            if hello[0] == 22 and hello[5] == 1:
                self.oracle['tlsClientHello'] += 1
            if self.case == 'tls_hold':
                await asyncio.Future()
            return
        upstream_reader, upstream_writer = await asyncio.open_connection('127.0.0.1', self.origin_port)
        self.writers.add(upstream_writer)
        async def pipe(source, destination):
            while data := await source.read(4096):
                destination.write(data)
                await destination.drain()
        pumps = [asyncio.create_task(pipe(reader, upstream_writer)),
                 asyncio.create_task(pipe(upstream_reader, writer))]
        try:
            await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in pumps:
                task.cancel()
            await asyncio.gather(*pumps, return_exceptions=True)
            upstream_writer.close()
            try:
                await asyncio.wait_for(upstream_writer.wait_closed(), .3)
            except (Exception, asyncio.CancelledError):
                upstream_writer.transport.abort()
            self.writers.discard(upstream_writer)

    async def start(self):
        if self.case == 'proxy_tcp_unavailable':
            self.refusal_socket = socket.socket()
            self.refusal_socket.bind(('127.0.0.1', 0))
            return self.refusal_socket.getsockname()[1]
        if self.case in ('invalid_certificate', 'after_tls_response_hold', 'after_tls_close', 'valid_tls'):
            self.origin_port = await self.listen(self.origin,
                self.bad_context if self.case == 'invalid_certificate' else self.good_context)
        return await self.listen(self.proxy)

    async def close(self):
        for server in self.servers:
            server.close()
        for writer in list(self.writers):
            writer.transport.abort()
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 2)
        for server in self.servers:
            await asyncio.wait_for(server.wait_closed(), 2)
        if self.refusal_socket is not None:
            self.refusal_socket.close()
        return {'serversClosed': all(not server.is_serving() for server in self.servers),
                'tasksRunning': sum(not task.done() for task in self.tasks),
                'writersRunning': len(self.writers)}


async def run_case(case, good_context, bad_context, ca):
    fixture = Fixture(case, good_context, bad_context)
    child = None
    row = {'case': case, 'result': 'RUNNING', 'processReaped': False}
    try:
        port = await fixture.start()
        scheme = 'socks5h' if case.startswith('socks_') else 'http'
        argv = ['/usr/bin/curl', '--disable', '--silent', '--show-error',
                '--connect-timeout', str(CONNECT_TIMEOUT), '--max-time', str(TOTAL_TIMEOUT),
                '--max-filesize', '1024', '--proto', '=https', '--noproxy', '',
                '--proxy', f'{scheme}://127.0.0.1:{port}', '--cacert', str(ca),
                '--output', '/dev/null', '--write-out', observer.WRITE_OUT,
                'https://phase.invalid/']
        start = time.monotonic_ns()
        child = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL,
                                                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        raw, _ = await asyncio.wait_for(child.communicate(), PROCESS_TIMEOUT)
        row['elapsedMs'] = number((time.monotonic_ns() - start) / 1_000_000)
        if len(raw) > 16384:
            raise ValueError('bounded projection')
        _, parsed = observer.restore_output(raw.decode('utf-8', errors='replace'), code=child.returncode)
        row['observed'] = projection(parsed, child.returncode)
        row['oracle'] = dict(fixture.oracle)
        observed, oracle = row['observed'], row['oracle']
        timing = observed['timingMs']
        assert timing is not None, 'failed timings must remain available'
        if case == 'proxy_tcp_unavailable':
            assert observed['curlCode'] in (7, 28) and not oracle['tcpAccepted']
            assert timing['connect'] == timing['appConnect'] == 0
            assert not observed['diagnosis']['tlsCompletedEvidence']
        elif case in ('proxy_accept_hold', 'connect_hold', 'socks_greeting_hold', 'socks_request_hold', 'tls_hold'):
            assert observed['curlCode'] == 28 and oracle['tcpAccepted']
            assert not observed['diagnosis']['tlsCompletedEvidence']
        elif case == 'tls_close':
            assert observed['curlCode'] in (35, 56) and oracle['tlsClientHello']
            assert observed['diagnosis']['errorClass'] != 'certificate'
        elif case == 'invalid_certificate':
            assert observed['curlCode'] == 60
            assert observed['diagnosis']['errorClass'] == 'certificate'
        elif case == 'after_tls_response_hold':
            assert observed['curlCode'] == 28 and oracle['decryptedRequest']
            assert observed['diagnosis']['tlsCompletedEvidence']
        elif case == 'after_tls_close':
            assert observed['curlCode'] in (52, 56) and oracle['decryptedRequest']
            assert observed['diagnosis']['tlsCompletedEvidence']
        elif case == 'valid_tls':
            assert observed['curlCode'] == 0 and observed['httpStatus'] == 200
            assert observed['diagnosis']['tlsCompletedEvidence']
        if case in ('proxy_accept_hold', 'connect_hold'):
            assert not oracle['tlsClientHello'] and not oracle['tlsServerAccepted']
            assert observed['diagnosis']['phase'] not in ('tls', 'post_tls', 'response', 'complete')
        if case == 'connect_hold':
            assert oracle['connectRequest'] == 1
        elif case == 'socks_greeting_hold':
            assert oracle['socksGreeting'] == 1 and oracle['socksRequest'] == 0
        elif case == 'socks_request_hold':
            assert oracle['socksGreeting'] == oracle['socksRequest'] == 1
        elif case in ('tls_close', 'tls_hold'):
            assert oracle['connectRequest'] == oracle['tlsClientHello'] == 1
        row['result'] = 'PASS'
    except (AssertionError, ValueError):
        row['result'], row['failure'] = 'FAIL', 'oracle_mismatch'
    except Exception:
        row['result'], row['failure'] = 'FAIL', 'fixture_internal'
    finally:
        if child is not None:
            if child.returncode is None:
                child.kill()
            await child.wait()
            row['processReaped'] = child.returncode is not None
        row['cleanup'] = await fixture.close()
        if not row['cleanup']['serversClosed'] or row['cleanup']['tasksRunning'] or row['cleanup']['writersRunning']:
            row['result'], row['failure'] = 'FAIL', 'cleanup'
    return row


async def main(output):
    asyncio.get_running_loop().set_exception_handler(lambda _loop, _context: None)
    version = subprocess.run(['/usr/bin/curl', '--version'], capture_output=True, check=True).stdout
    assert version.startswith(b'curl 8.7.1 '), 'expected reviewed curl version'
    report = {'schema': 1, 'curlVersion': '8.7.1', 'tlsBackend': 'SecureTransport',
              'network': 'loopback_only', 'timeouts': {'connectMs': 600, 'totalMs': 1500, 'processMs': 4000},
              'observerSHA256': hashlib.sha256(Path(observer.__file__).read_bytes()).hexdigest(),
              'labSHA256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'limitations': ['TCP SYN stall is not emulated; accepted TCP hold is a proxy negotiation stall',
                              'Bound unavailable port may yield7 or28 on this OS; no instant refusal or RST is asserted',
                              'Local controlled phase is an oracle, not proof every real failure can be attributed',
                              'Cumulative curl timing values do not partition protocol stages'], 'cases': []}
    with tempfile.TemporaryDirectory(prefix='cp-phase-tls-') as directory:
        scratch = Path(directory)
        for name in ('good', 'bad'):
            subprocess.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-days', '1', '-subj', '/CN=phase.invalid', '-addext', 'subjectAltName=DNS:phase.invalid',
                '-keyout', str(scratch / (name + '.key')), '-out', str(scratch / (name + '.crt'))],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        contexts = []
        for name in ('good', 'bad'):
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(scratch / (name + '.crt'), scratch / (name + '.key'))
            contexts.append(context)
        for case in CASES:
            report['cases'].append(await run_case(case, *contexts, scratch / 'good.crt'))
    report['ephemeralCredentialsRemoved'] = not scratch.exists()
    report['sourceStable'] = (report['observerSHA256'] == hashlib.sha256(Path(observer.__file__).read_bytes()).hexdigest()
                              and report['labSHA256'] == hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    report['result'] = 'PASS' if report['ephemeralCredentialsRemoved'] and report['sourceStable'] and all(row['result'] == 'PASS' for row in report['cases']) else 'FAIL'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'result': report['result'], 'cases': len(report['cases'])}))
    return report['result'] == 'PASS'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    try:
        succeeded = asyncio.run(main(arguments.output))
    except Exception:
        print(json.dumps({'result': 'FAIL', 'reason': 'fixture_initialization'}))
        succeeded = False
    raise SystemExit(0 if succeeded else 1)
