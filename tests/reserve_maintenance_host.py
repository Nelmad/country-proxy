"""Local-only maintenance oracle; production Session/pool/budgets/curl remain intact."""
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
if len(ports) != 5 or len(set(ports)) != 5:
    raise ValueError('Five distinct loopback SOCKS5 endpoints required')
items = [core.Candidate('socks5', '127.0.0.1', port) for port in ports]
locations = ('AT', 'EE', 'NO', 'AT', 'EE')
countries = ('AT', 'EE', 'NO')
stage = ContextVar('stage', default='ordinary')
context = ContextVar('check', default={})
original_process = core.process
running_curl = set()
call_sequence = session_sequence = command_sequence = 0


def record(value):
    with (scratch / 'native-events.jsonl').open('a') as output:
        output.write(json.dumps({'atMs': time.time_ns() / 1_000_000,
                                 'monotonicMs': time.monotonic_ns() / 1_000_000,
                                 **value}) + '\n')


async def local_process(argv, timeout, *args, **kwargs):
    global call_sequence
    if argv[0] != '/usr/bin/curl' or argv[-1] not in (core.TRACE, core.TARGET):
        raise ValueError('Unexpected subprocess in local-only fixture')
    item = next((item for item in items if item.url == argv[argv.index('--proxy') + 1]), None)
    if item is None:
        raise ValueError('Unexpected proxy in local-only fixture')
    call_sequence += 1
    call = call_sequence
    endpoint = 'trace' if argv[-1] == core.TRACE else 'target'
    running_curl.add(call)
    record({'event': 'curl-start', 'call': call, 'port': item.port, 'endpoint': endpoint,
            'context': context.get(), 'running': len(running_curl),
            'processTimeout': timeout, 'curlMaxTime': argv[argv.index('--max-time') + 1],
            'curlConnectTimeout': argv[argv.index('--connect-timeout') + 1]})
    try:
        answer = await original_process([*argv[:-1], '--cacert', str(scratch / 'tls.crt'), argv[-1]],
                                        timeout, *args, **kwargs)
        record({'event': 'curl-result', 'call': call, 'port': item.port, 'endpoint': endpoint,
                'code': answer[0], 'httpStatus': answer[1].rpartition('\n')[2].strip(),
                'context': context.get()})
        return answer
    except asyncio.CancelledError:
        record({'event': 'curl-cancel', 'call': call, 'port': item.port, 'endpoint': endpoint})
        raise
    finally:
        running_curl.discard(call)
        record({'event': 'curl-disposed', 'call': call, 'running': len(running_curl)})


core.process = local_process


class LocalPool(ReservePool):
    # All five identities are loopback fixtures; independent ports represent hosts.
    def conflicts(self, left, right):
        return ((left['host'], left['port']) == (right['host'], right['port'])
                or left['exitIp'] == right['exitIp'])

    def candidate_conflicts(self, item, proxy):
        return (item.host, item.port) == (proxy['host'], proxy['port'])

    def accept(self, result, **kwargs):
        accepted = super().accept(result, **kwargs)
        if accepted:
            record({'event': 'reserve-accepted', 'port': result['port'], 'country': result['country'],
                    'checkedAt': result['checkedAt'], 'stage': stage.get()})
        return accepted

    async def _refresh_one(self, key, entry, token, generation):
        value = stage.set('maintenance')
        port = entry[0]['port']
        record({'event': 'maintenance-start', 'port': port, 'previousCheckedAt': entry[0]['checkedAt']})
        try:
            await super()._refresh_one(key, entry, token, generation)
        finally:
            current = self.entries.get(key)
            record({'event': 'maintenance-end', 'port': port,
                    'retained': current is not None,
                    'checkedAt': current[0]['checkedAt'] if current else None,
                    'verifiedAtMonoMs': current[1] * 1000 if current else None})
            stage.reset(value)

    async def take(self, **kwargs):
        value = stage.set('promotion')
        record({'event': 'take-start', 'ports': [proxy['port'] for proxy, _ in self.entries.values()]})
        try:
            result = await super().take(**kwargs)
            record({'event': 'take-result', 'port': result['port'] if result else None})
            return result
        except asyncio.CancelledError:
            record({'event': 'take-cancel'})
            raise
        finally:
            stage.reset(value)


class LocalSession(core.Session):
    def __init__(self, requested, output):
        global session_sequence
        session_sequence += 1
        self.lab_session = session_sequence
        if not set(core.country_codes(requested)).issubset(countries):
            raise ValueError('Unexpected selected group')
        self.primary_seen = False
        self.confirmed_replacements = 0
        self.inflight = {}

        async def feed(cc):
            indices = ([0] if not self.primary_seen else [1] if not self.confirmed_replacements
                       else [2] if self.confirmed_replacements == 1 else [3, 4])
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

    # Match fixture host identities without changing production history/check logic.
    def eligible(self, item):
        return self.excluded.get(item.key, 0) <= time.monotonic() and self.history.eligible(item)

    def exclude(self, item, seconds=180):
        self.excluded[item.key] = max(self.excluded.get(item.key, 0), time.monotonic() + seconds)

    async def _raw_report(self, item, country, slow=False, *args, **kwargs):
        check = time.monotonic_ns()
        self.inflight[check] = item.port
        value = context.set({'session': self.lab_session, 'check': check, 'stage': stage.get()})
        record({'event': 'check-start', 'session': self.lab_session, 'check': check, 'port': item.port,
                'stage': stage.get(), 'slow': slow, 'running': len(self.inflight)})
        try:
            report = await super()._raw_report(item, country, slow, *args, **kwargs)
            record({'event': 'check-result', 'session': self.lab_session, 'check': check, 'port': item.port,
                    'stage': stage.get(), 'ok': report.get('ok'), 'reason': report.get('reason'),
                    'endpoint': report.get('endpoint'), 'code': report.get('code'),
                    'checkedAt': report.get('proxy', {}).get('checkedAt'),
                    'country': report.get('proxy', {}).get('country'),
                    'exitIp': report.get('proxy', {}).get('exitIp'),
                    'latencyMs': report.get('latencyMs')})
            return report
        except asyncio.CancelledError:
            record({'event': 'check-cancel', 'session': self.lab_session, 'check': check, 'port': item.port})
            raise
        finally:
            context.reset(value)
            self.inflight.pop(check, None)
            record({'event': 'check-disposed', 'session': self.lab_session, 'check': check,
                    'running': len(self.inflight), 'budget': self.check_budget.snapshot})

    def browser_feedback(self, command, attempt, proxy, reason=None):
        accepted = super().browser_feedback(command, attempt, proxy, reason)
        if accepted and command == 'confirm':
            if proxy['port'] == ports[1]:
                self.confirmed_replacements = max(1, self.confirmed_replacements)
            elif proxy['port'] == ports[2]:
                self.confirmed_replacements = max(2, self.confirmed_replacements)
        record({'event': 'feedback', 'session': self.lab_session, 'command': command,
                'accepted': accepted, 'attempt': attempt, 'port': proxy.get('port')})
        return accepted

    async def control(self):
        global command_sequence
        while True:
            await asyncio.sleep(.02)
            try:
                message = json.loads((scratch / 'command.json').read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                continue
            seq = message.get('seq')
            if type(seq) is not int or seq <= command_sequence:
                continue
            command_sequence = seq
            if message.get('action') != 'state':
                raise ValueError('Unexpected fixture command')
            reply = {'seq': seq, 'ok': True, 'session': self.lab_session,
                     'monotonicMs': time.monotonic_ns() / 1_000_000,
                     'entries': [{'port': proxy['port'], 'checkedAt': proxy['checkedAt'],
                                  'verifiedAtMonoMs': at * 1000}
                                 for proxy, at in self.pool.entries.values()],
                     'inflight': list(self.inflight.values()), 'curlRunning': len(running_curl),
                     'budget': self.check_budget.snapshot,
                     'supplementalRunning': getattr(getattr(self, 'supplemental_budget', None), 'running', None)}
            temporary = scratch / 'reply.tmp'
            temporary.write_text(json.dumps(reply))
            temporary.replace(scratch / 'reply.json')

    async def run(self):
        record({'event': 'session-started', 'session': self.lab_session})
        control = asyncio.create_task(self.control())
        try:
            await super().run()
        finally:
            control.cancel()
            await asyncio.gather(control, return_exceptions=True)
            record({'event': 'session-stopped', 'session': self.lab_session,
                    'inflight': list(self.inflight.values()), 'curlRunning': len(running_curl),
                    'budget': self.check_budget.snapshot,
                    'supplementalRunning': getattr(getattr(self, 'supplemental_budget', None), 'running', None)})


record({'event': 'source', 'sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                    for p in sorted((product / 'native').glob('*.py'))}})
host.Session = LocalSession
asyncio.run(host.main())
