#!/usr/bin/env python3
"""Owned-profile reserve-race fixture; all accepted results use real TLS/GeoIP.

Only endpoint identity is relaxed to distinct loopback ports sharing one real
egress. Files gate ordering/CONNECT transport, never checker return values,
country, exit IP, latency, production timeouts, or promotion/feedback logic.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
import host
from core import Candidate, Session
from pool import ReservePool


def configure(config_path):
    config_path = Path(config_path).resolve()
    config_path.relative_to(ROOT / '.runtime')
    config = json.loads(config_path.read_text())
    ports = config['ports']
    if (not isinstance(ports, list) or len(ports) != 3 or len(set(ports)) != 3
            or any(type(port) is not int or not 0 < port < 65536 for port in ports)):
        raise ValueError('Exactly three distinct fixture ports required')
    scenario = config['scenario']
    if scenario not in ('native-hang', 'browser-reject'):
        raise ValueError('Unknown reserve-race scenario')
    directory = config_path.parent
    events = directory / 'native-events.jsonl'
    active, reserve_a, reserve_b = [Candidate('http', '127.0.0.1', p) for p in ports]

    def record(value):
        with events.open('a') as output:
            output.write(json.dumps({'at': time.time(), 'mono': time.monotonic(),
                                     'pid': os.getpid(), **value}) + '\n')

    record({'event': 'start', 'scenario': scenario, 'fingerprints': {
        source.name: hashlib.sha256(source.read_bytes()).hexdigest()
        for source in sorted((ROOT / 'native').glob('*.py'))}})
    (directory / 'native-pid.json').write_text(json.dumps({
        'pid': os.getpid(), 'config': str(config_path)}))

    async def gate(name):
        # A test failure cannot leave a native fixture waiting forever.
        async with asyncio.timeout(55):
            while not (directory / name).exists():
                await asyncio.sleep(.01)

    class FixturePool(ReservePool):
        def conflicts(self, left, right):
            return (left['host'], left['port']) == (right['host'], right['port'])

        def candidate_conflicts(self, item, proxy):
            return (item.host, item.port) == (proxy['host'], proxy['port'])

    class FixtureSession(Session):
        def __init__(self, requested, emit):
            self.inflight = set()
            self.primary_seen = False

            async def discover_fixture(country):
                record({'event': 'discover', 'country': country,
                        'after_failure': (directory / 'fail-injected').exists(),
                        'active_port': self.active.get('port') if self.active else None})
                # Foreground discovery can find only the initial endpoint. Its
                # confirmation enables the ordinary pool refill with A and B.
                return ([reserve_a, reserve_b] if self.primary_seen else [active]), []

            def observed(event):
                record({'event': 'status', 'status': event})
                proxy = event.get('proxy')
                if event.get('phase') == 'connected' and proxy:
                    self.primary_seen = True
                    if scenario == 'browser-reject' and proxy['port'] == reserve_a.port:
                        # Set before handing the *real* native success to Chrome.
                        # The following browser CONNECTs get a transport failure.
                        (directory / 'reject-A').write_text('reject next CONNECTs\n')
                emit(event)

            super().__init__(requested, observed, discoverer=discover_fixture,
                             pool_factory=FixturePool)

        async def _raw_report(self, item, country, slow=False, extras=None):
            promotion = (directory / 'fail-injected').exists() and item != active
            token = (item.key, time.monotonic_ns())
            self.inflight.add(token)
            record({'event': 'checker-start', 'candidate': item.key,
                    'port': item.port, 'promotion': promotion})
            try:
                if promotion and item == reserve_a and scenario == 'native-hang':
                    # The Node listener holds actual CONNECTs from curl until the
                    # production race cancels the loser and drains subprocesses.
                    (directory / 'hold-A').write_text('hold actual native CONNECT\n')
                if promotion and item == reserve_b:
                    # Establish A outstanding before B's real native HTTPS check.
                    # In browser-reject, an initial B task is cancelled when A
                    # wins; the next B check waits for Chrome's real A failure.
                    await gate('held-A' if scenario == 'native-hang' else 'rejected-A')
                result = await super()._raw_report(item, country, slow, extras)
                record({'event': 'checker-result', 'candidate': item.key,
                        'port': item.port, 'promotion': promotion,
                        'accepted': result['ok'],
                        'a_outstanding': any(k == reserve_a.key for k, _ in self.inflight)
                        if item != reserve_a else False,
                        'proxy': result.get('proxy')})
                return result
            except asyncio.CancelledError:
                record({'event': 'checker-cancel', 'candidate': item.key,
                        'port': item.port, 'promotion': promotion})
                raise
            finally:
                self.inflight.discard(token)
                record({'event': 'checker-disposed', 'candidate': item.key,
                        'port': item.port, 'promotion': promotion})

        def eligible(self, candidate):
            return self.excluded.get(candidate.key, 0) <= time.monotonic()

        def exclude(self, candidate, seconds=180):
            self.excluded[candidate.key] = time.monotonic() + seconds

        def browser_feedback(self, command, attempt, proxy, reason=None):
            accepted = super().browser_feedback(command, attempt, proxy, reason)
            record({'event': 'feedback', 'command': command, 'attempt': attempt,
                    'proxy': proxy, 'reason': reason, 'accepted': accepted})
            return accepted

    return FixtureSession


async def main(config_path):
    host.Session = configure(config_path)
    task = asyncio.create_task(host.main())
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        await task
    except asyncio.CancelledError:
        pass


if __name__ == '__main__':
    asyncio.run(main(Path(sys.argv[1])))
