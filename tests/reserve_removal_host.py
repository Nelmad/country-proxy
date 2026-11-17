"""Disposable loopback QA for production reserve removals; never accesses public services.

Native commands and pool logic stay in production. The fixture supplies bounded
local feeds, a one-run TLS trust anchor, distinct loopback identities, and exact
maintenance/prune triggers. It never manufactures a network check result.
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
if len(ports) != 3 or len(set(ports)) != 3 or any(type(p) is not int or not 0 < p < 65536 for p in ports):
    raise ValueError('Three distinct local proxy ports required')
items = [core.Candidate('http', '127.0.0.1', p) for p in ports]
sequence = 0


def record(value):
    with (scratch / 'native-events.jsonl').open('a') as output:
        output.write(json.dumps({'atMs': int(time.time() * 1000), **value}) + '\n')


def write_state(value):
    pending = scratch / 'reply.tmp'
    pending.write_text(json.dumps(value))
    pending.replace(scratch / 'reply.json')


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


class LocalSession(core.Session):
    def __init__(self, requested, output):
        if tuple(requested) != countries:
            raise ValueError('Expected equal AT/EE/NO group')
        self.primary_seen = False
        self.refresh_tasks = {}

        async def feed(cc):
            # Seed one deterministic primary, then both independent reserves.
            return ([items[countries.index(cc)]] if self.primary_seen else [items[0]]), []

        def observed(event):
            if event.get('phase') == 'connected' and event.get('proxy'):
                self.primary_seen = True
            record({'event': 'status', 'status': event})
            output(event)

        super().__init__(requested, observed, discoverer=feed, pool_factory=LocalPool)

    def eligible(self, candidate):
        return self.excluded.get(candidate.key, 0) <= time.monotonic() and self.history.eligible(candidate)

    def exclude(self, candidate, seconds=180):
        # Three lab listeners share loopback; quarantine follows their fixture identity.
        self.excluded[candidate.key] = max(self.excluded.get(candidate.key, 0), time.monotonic() + seconds)

    def state(self):
        # The private identity lookup is inspected only for correlation evidence.
        identities = getattr(self.pool, '_reserve_ids', {})
        return {'activePort': self.active.get('port') if self.active else None,
                'entries': [{'port': proxy['port'], 'country': proxy['country'],
                             'ageMs': max(0, round((self.pool.clock() - at) * 1000)),
                             'reserveId': identities.get(key)}
                            for key, (proxy, at) in self.pool.entries.items()],
                'diagnostics': self.pool.diagnostic_snapshot(self.active is not None)}

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
                before = self.state()
                action = command['action']
                item = next((item for item in items if item.port == command.get('port')), None)
                if action != 'state' and (item is None or item.key not in self.pool.entries):
                    raise ValueError('Expected currently reserved local endpoint')
                if action in ('refresh', 'refresh-start'):
                    task = self.pool._start_refresh(item.key)
                    self.refresh_tasks[item.key] = task
                    if action == 'refresh':
                        await task
                elif action == 'refresh-cancel':
                    task = self.refresh_tasks.pop(item.key)
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    self.pool.publish()
                elif action == 'expire':
                    proxy, _ = self.pool.entries[item.key]
                    self.pool.entries[item.key] = (proxy, self.pool.clock() - self.pool.ttl - .01)
                    self.pool.publish()
                elif action == 'outside':
                    proxy, at = self.pool.entries[item.key]
                    self.pool.entries[item.key] = ({**proxy, 'country': 'SE'}, at)
                    self.pool.publish()
                elif action != 'state':
                    raise ValueError('Unknown fixture trigger')
                write_state({'seq': seq, 'ok': True, 'before': before, 'after': self.state()})
            except Exception as error:
                write_state({'seq': seq, 'ok': False, 'error': type(error).__name__ + ': ' + str(error)})

    async def run(self):
        controller = asyncio.create_task(self.control())
        try:
            await super().run()
        finally:
            controller.cancel()
            await asyncio.gather(controller, return_exceptions=True)


record({'event': 'source', 'sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                    for p in sorted((product / 'native').glob('*.py'))}})
host.Session = LocalSession
asyncio.run(host.main())
