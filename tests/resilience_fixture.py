#!/usr/bin/env python3
"""Disposable soak-only host; real checks/intervals, controllable discovery.

Loopback listeners share an egress, so this fixture relaxes endpoint identity only.
Never register it in a normal browser profile.
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
    config = json.loads(config_path.read_text())
    ports = config['ports']
    if len(ports) != 2 or len(set(ports)) != 2 or any(type(p) is not int or not 0 < p < 65536 for p in ports):
        raise ValueError('Exactly two distinct fixture ports required')
    candidates = [Candidate('http', '127.0.0.1', p) for p in ports]
    events = config_path.parent / 'native-events.jsonl'

    def event(value):
        with events.open('a') as output:
            output.write(json.dumps({'at': time.time(), 'pid': os.getpid(), **value}) + '\n')

    event({'event': 'start', 'fingerprints': {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT / 'native').glob('*.py'))}})
    pid_path = config_path.parent / 'native-pid.json'
    pid_tmp = pid_path.with_suffix('.tmp')
    pid_tmp.write_text(json.dumps({'pid': os.getpid(), 'config': str(config_path), 'at': time.time()}))
    pid_tmp.replace(pid_path)

    async def discover_fixture(requested):
        state = json.loads(config_path.read_text())
        event({'event': 'discover', 'country': requested, 'available': state.get('sourcesAvailable', True)})
        if not state.get('sourcesAvailable', True):
            raise RuntimeError('Controlled source outage')
        # Requested countries deliberately pass to the REAL checker. Wrong countries
        # must be rejected by actual HTTPS trace, never by fabricated fixture output.
        return candidates, []

    class FixturePool(ReservePool):
        def conflicts(self, left, right):
            return (left['host'], left['port']) == (right['host'], right['port'])

        def candidate_conflicts(self, item, proxy):
            return (item.host, item.port) == (proxy['host'], proxy['port'])

    class FixtureSession(Session):
        def __init__(self, requested, emit):
            super().__init__(requested, emit, discoverer=discover_fixture, pool_factory=FixturePool)

        def eligible(self, candidate):
            return self.excluded.get(candidate.key, 0) <= time.monotonic()

        def exclude(self, candidate, seconds=180):
            self.excluded[candidate.key] = time.monotonic() + seconds

    return FixtureSession


async def main(config_path):
    host.Session = configure(config_path)
    task = asyncio.create_task(host.main())
    # A genuine process/port loss, while letting owned curl subprocesses be reaped.
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        await task
    except asyncio.CancelledError:
        pass


if __name__ == '__main__':
    config_path = Path(sys.argv[1]).resolve()
    config_path.relative_to(ROOT / '.runtime')
    asyncio.run(main(config_path))
