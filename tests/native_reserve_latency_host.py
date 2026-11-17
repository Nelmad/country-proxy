"""Controlled feeds and TLS trust for real native reserve latency acceptance.

Session, CheckBudget, ReservePool, inspect_proxy, curl and child cleanup remain
production implementations. The process seam adds only a per-run CA and a
proxy-only marker used by the local server to distinguish native requests.
"""
import asyncio
from contextvars import ContextVar
import hashlib
import json
from pathlib import Path
import sys
import time

product, scratch = map(Path, sys.argv[1:3])
sys.path.insert(0, str(product / 'native'))
import core
import host
from pool import ReservePool

ports = json.loads((scratch / 'config.json').read_text())['ports']
countries = ('AT', 'EE', 'NO')
locations = ('AT', 'EE', 'NO', 'AT', 'EE')
items = [core.Candidate('http', '127.0.0.1', p) for p in ports]
if len(items) != 5 or len(set(ports)) != 5:
    raise ValueError('Expected five distinct controlled proxy ports')
sequence = session_sequence = call_sequence = 0
inflight_curl = set()
check_context = ContextVar('check_context', default={})
original_process = core.process


def record(value):
    with (scratch / 'native-events.jsonl').open('a') as output:
        output.write(json.dumps({'atMs': time.time_ns() / 1_000_000, **value}) + '\n')


async def local_process(argv, timeout, *args, **kwargs):
    global call_sequence
    if argv[0] != '/usr/bin/curl' or argv[-1] not in (core.TRACE, core.TARGET):
        raise ValueError('Unexpected subprocess in local-only fixture')
    proxy = argv[argv.index('--proxy') + 1]
    item = next((item for item in items if item.url == proxy), None)
    if item is None:
        raise ValueError('Unexpected proxy in local-only fixture')
    call_sequence += 1
    call = call_sequence
    endpoint = 'trace' if argv[-1] == core.TRACE else 'target'
    context = check_context.get()
    inflight_curl.add(call)
    record({'event': 'curl-start', 'call': call, 'port': item.port,
            'endpoint': endpoint, 'context': context, 'running': len(inflight_curl),
            'processTimeout': timeout, 'curlMaxTime': argv[argv.index('--max-time') + 1]})
    modified = [*argv[:-1], '--cacert', str(scratch / 'tls.crt'),
                '--proxy-header', f'X-Country-Proxy-Lab: {call}', argv[-1]]
    try:
        result = await original_process(modified, timeout, *args, **kwargs)
        record({'event': 'curl-result', 'call': call, 'port': item.port,
                'endpoint': endpoint, 'code': result[0]})
        return result
    except asyncio.CancelledError:
        record({'event': 'curl-cancel', 'call': call, 'port': item.port, 'endpoint': endpoint})
        raise
    finally:
        inflight_curl.discard(call)
        record({'event': 'curl-disposed', 'call': call, 'running': len(inflight_curl)})


core.process = local_process


class LocalPool(ReservePool):
    def conflicts(self, left, right):
        return ((left['host'], left['port']) == (right['host'], right['port'])
                or left['exitIp'] == right['exitIp'])

    def candidate_conflicts(self, item, proxy):
        return (item.host, item.port) == (proxy['host'], proxy['port'])

    def accept(self, result, **kwargs):
        accepted = super().accept(result, **kwargs)
        if accepted:
            record({'event': 'reserve-accepted', 'port': result['port'], 'country': result['country']})
        return accepted

    async def take(self, **kwargs):
        record({'event': 'take-start', 'ports': [proxy['port'] for proxy, _ in self.entries.values()]})
        try:
            result = await super().take(**kwargs)
            record({'event': 'take-result', 'port': result['port'] if result else None})
            return result
        except asyncio.CancelledError:
            record({'event': 'take-cancel'})
            raise


class LocalSession(core.Session):
    def __init__(self, requested, output):
        global session_sequence
        session_sequence += 1
        self.lab_session = session_sequence
        if not set(core.country_codes(requested)).issubset(countries):
            raise ValueError('Unexpected group')
        self.primary_seen = self.armed = False
        self.confirmed_replacements = 0
        self.inflight = {}

        async def feed(cc):
            indices = ([0] if not self.primary_seen else [1] if not self.armed else
                       [] if not self.confirmed_replacements else
                       [2, 3] if self.confirmed_replacements == 1 else [4])
            selected = [items[i] for i in indices if locations[i] == cc]
            record({'event': 'feed', 'session': self.lab_session, 'country': cc,
                    'ports': [item.port for item in selected]})
            return selected, []

        def observed(event):
            if event.get('phase') == 'connected' and event.get('proxy'):
                self.primary_seen = True
            record({'event': 'status', 'session': self.lab_session, 'status': event})
            output(event)

        super().__init__(requested, observed, discoverer=feed, pool_factory=LocalPool)

    def eligible(self, item):
        return self.excluded.get(item.key, 0) <= time.monotonic() and self.history.eligible(item)

    def exclude(self, item, seconds=180):
        self.excluded[item.key] = max(self.excluded.get(item.key, 0), time.monotonic() + seconds)

    async def _raw_report(self, item, country, slow=False, *args, **kwargs):
        token = time.monotonic_ns()
        self.inflight[token] = item.port
        context = check_context.set({'session': self.lab_session, 'check': token, 'armed': self.armed})
        record({'event': 'check-start', 'session': self.lab_session, 'port': item.port,
                'check': token, 'slow': slow, 'armed': self.armed, 'running': len(self.inflight)})
        try:
            result = await super()._raw_report(item, country, slow, *args, **kwargs)
            record({'event': 'check-result', 'session': self.lab_session, 'port': item.port,
                    'check': token, 'ok': result.get('ok'), 'reason': result.get('reason'),
                    'endpoint': result.get('endpoint'), 'latencyMs': result.get('latencyMs'),
                    'proxyLatencyMs': result.get('proxy', {}).get('latencyMs')})
            return result
        except asyncio.CancelledError:
            record({'event': 'check-cancel', 'session': self.lab_session, 'port': item.port, 'check': token})
            raise
        finally:
            check_context.reset(context)
            self.inflight.pop(token, None)
            record({'event': 'check-disposed', 'session': self.lab_session, 'check': token,
                    'running': len(self.inflight), 'budget': self.check_budget.snapshot})

    def browser_feedback(self, command, attempt, proxy, reason=None):
        accepted = super().browser_feedback(command, attempt, proxy, reason)
        if accepted and command == 'confirm' and proxy['port'] != ports[0]:
            self.confirmed_replacements = max(self.confirmed_replacements, 1 if proxy['port'] == ports[1] else 2)
        record({'event': 'feedback', 'session': self.lab_session, 'command': command,
                'accepted': accepted, 'attempt': attempt, 'port': proxy.get('port')})
        return accepted

    async def control(self):
        global sequence
        while True:
            await asyncio.sleep(.02)
            try:
                message = json.loads((scratch / 'command.json').read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                continue
            seq = message.get('seq')
            if type(seq) is not int or seq <= sequence:
                continue
            sequence = seq
            if message.get('action') == 'arm':
                self.armed = True
            elif message.get('action') != 'state':
                raise ValueError('Unexpected fixture command')
            reply = {'seq': seq, 'ok': True, 'session': self.lab_session,
                     'entries': [proxy['port'] for proxy, _ in self.pool.entries.values()],
                     'inflight': list(self.inflight.values()), 'curlRunning': len(inflight_curl),
                     'budget': self.check_budget.snapshot,
                     'supplementalRunning': getattr(getattr(self, 'supplemental_budget', None), 'running', None)}
            temp = scratch / 'reply.tmp'
            temp.write_text(json.dumps(reply))
            temp.replace(scratch / 'reply.json')

    async def run(self):
        record({'event': 'session-started', 'session': self.lab_session})
        control = asyncio.create_task(self.control())
        try:
            await super().run()
        finally:
            control.cancel()
            await asyncio.gather(control, return_exceptions=True)
            record({'event': 'session-stopped', 'session': self.lab_session,
                    'inflight': list(self.inflight.values()), 'curlRunning': len(inflight_curl),
                    'budget': self.check_budget.snapshot,
                    'supplementalRunning': getattr(getattr(self, 'supplemental_budget', None), 'running', None)})


record({'event': 'source', 'sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                    for p in sorted((product / 'native').glob('*.py'))}})
host.Session = LocalSession
asyncio.run(host.main())
