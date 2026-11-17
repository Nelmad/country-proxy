"""Disposable local-HTTPS acceptance fixture for concurrent recovery.

Production Session, Pool, StreamSearch, CheckBudget and native host remain in use.
Only sources, TLS trust and distinct loopback identity are supplied by the lab.
No probe result or geolocation is manufactured inside the helper.
"""
import asyncio
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

config = json.loads((scratch / 'config.json').read_text())
ports = config['ports']
countries = ('AT', 'EE', 'NO')
endpoint_countries = ('AT', 'EE', 'NO', 'EE', 'AT')
if len(ports) != 5 or len(set(ports)) != 5 or any(type(p) is not int or not 0 < p < 65536 for p in ports):
    raise ValueError('Five distinct local proxy ports required')
items = [core.Candidate('http', '127.0.0.1', port) for port in ports]
sequence = 0


def record(value):
    with (scratch / 'native-events.jsonl').open('a') as output:
        output.write(json.dumps({'atMs': time.time_ns() / 1_000_000, **value}) + '\n')


async def curl_local(url, proxy=None, slow=False):
    if proxy not in items or url not in (core.TRACE, core.TARGET):
        raise ValueError('Unexpected network request')
    total = 45 if slow else 12
    args = ['/usr/bin/curl', '--disable', '--silent', '--show-error', '--connect-timeout', str(30 if slow else 7),
            '--max-time', str(total), '--cacert', str(scratch / 'tls.crt'), '--proto', '=https',
            '--noproxy', '', '--proxy', proxy.url, '--write-out', '\n%{http_code}', url]
    code, text = await core.process(args, total + 2)
    body, _, status = text.rpartition('\n')
    record({'event': 'curl', 'port': proxy.port, 'endpoint': 'trace' if url == core.TRACE else 'target',
            'code': code, 'status': status})
    return code, status, body


core.curl = curl_local


class LocalPool(ReservePool):
    def conflicts(self, left, right):
        return (left['host'], left['port']) == (right['host'], right['port']) or left['exitIp'] == right['exitIp']

    def candidate_conflicts(self, item, proxy):
        return (item.host, item.port) == (proxy['host'], proxy['port'])

    def accept(self, result, **kwargs):
        outcome = super().accept(result, **kwargs)
        if outcome:
            record({'event': 'reserve-accepted', 'port': result['port'],
                    'country': result['country'], 'refill': kwargs.get('refill', False)})
        return outcome

    async def take(self, **kwargs):
        record({'event': 'take-start', 'ports': [p['port'] for p, _ in self.entries.values()]})
        try:
            result = await super().take(**kwargs)
            record({'event': 'take-result', 'port': result['port'] if result else None})
            return result
        except asyncio.CancelledError:
            record({'event': 'take-cancel'})
            raise

    async def _refill(self):
        record({'event': 'refill-start', 'allowed': self.refill_allowed.is_set()})
        try:
            return await super()._refill()
        finally:
            record({'event': 'refill-finished'})


class LocalSession(core.Session):
    def __init__(self, requested, output):
        if tuple(requested) != countries:
            raise ValueError('Expected equal AT/EE/NO group')
        self.primary_seen = False
        self.arm = False
        self.replacement_confirmed = False
        self.additional_available = False
        self.inflight = {}

        async def feed(cc):
            # Exact country suppliers have equal treatment; availability gates
            # isolate first connection, existing reserve and newly discovered IPs.
            indices = ([0] if not self.primary_seen else [1] if not self.arm else
                       [2] if not self.replacement_confirmed else
                       [3, 4] if self.additional_available else [3])
            selected = [items[i] for i in indices if endpoint_countries[i] == cc]
            record({'event': 'feed', 'country': cc, 'ports': [item.port for item in selected],
                    'armed': self.arm, 'replacementConfirmed': self.replacement_confirmed})
            return selected, []

        def observed(event):
            if event.get('phase') == 'connected' and event.get('proxy'):
                self.primary_seen = True
            record({'event': 'status', 'status': event})
            output(event)

        super().__init__(requested, observed, discoverer=feed, pool_factory=LocalPool)

    def eligible(self, candidate):
        return self.excluded.get(candidate.key, 0) <= time.monotonic() and self.history.eligible(candidate)

    def exclude(self, candidate, seconds=180):
        self.excluded[candidate.key] = max(self.excluded.get(candidate.key, 0), time.monotonic() + seconds)

    async def _raw_report(self, item, country, slow=False, extras=None):
        token = time.monotonic_ns()
        self.inflight[token] = item.port
        record({'event': 'check-start', 'port': item.port, 'slow': slow,
                'armed': self.arm, 'running': len(self.inflight)})
        try:
            result = await super()._raw_report(item, country, slow, extras)
            record({'event': 'check-result', 'port': item.port, 'ok': result.get('ok'),
                    'otherInflight': list(self.inflight.values())})
            return result
        except asyncio.CancelledError:
            record({'event': 'check-cancel', 'port': item.port})
            raise
        finally:
            self.inflight.pop(token, None)
            record({'event': 'check-disposed', 'port': item.port, 'running': len(self.inflight)})

    def browser_feedback(self, command, attempt, proxy, reason=None):
        accepted = super().browser_feedback(command, attempt, proxy, reason)
        if accepted and command == 'confirm' and proxy['port'] != ports[0]:
            self.replacement_confirmed = True
        record({'event': 'feedback', 'command': command, 'attempt': attempt,
                'port': proxy.get('port'), 'accepted': accepted})
        return accepted

    def state(self):
        return {'activePort': self.active.get('port') if self.active else None,
                'inflight': list(self.inflight.values()),
                'entries': [{'port': proxy['port'], 'country': proxy['country']}
                            for proxy, _ in self.pool.entries.values()],
                'budget': self.check_budget.snapshot}

    async def control(self):
        global sequence
        while True:
            await asyncio.sleep(.02)
            try:
                command = json.loads((scratch / 'command.json').read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                continue
            seq = command.get('seq')
            if type(seq) is not int or seq <= sequence:
                continue
            sequence = seq
            try:
                action = command['action']
                if action == 'arm':
                    self.arm = True
                elif action == 'refresh':
                    self.additional_available = True
                    item = next(item for item in items if item.port == command.get('port'))
                    if item.key not in self.pool.entries:
                        raise ValueError('Expected reserved fixture')
                    await self.pool._start_refresh(item.key)
                    self.pool.publish()
                elif action != 'state':
                    raise ValueError('Unexpected action')
                pending = scratch / 'reply.tmp'
                pending.write_text(json.dumps({'seq': seq, 'ok': True, 'state': self.state()}))
                pending.replace(scratch / 'reply.json')
            except Exception as error:
                record({'event': 'fixture-error', 'type': type(error).__name__})
                raise

    async def run(self):
        controller = asyncio.create_task(self.control())
        try:
            await super().run()
        finally:
            controller.cancel()
            await asyncio.gather(controller, return_exceptions=True)
            record({'event': 'session-stopped', 'inflight': list(self.inflight.values()),
                    'budget': self.check_budget.snapshot})


record({'event': 'source', 'sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                    for p in sorted((product / 'native').glob('*.py'))}})
host.Session = LocalSession
asyncio.run(host.main())
