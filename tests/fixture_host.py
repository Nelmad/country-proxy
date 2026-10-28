#!/usr/bin/env python3
"""Test-only Native Messaging wiring: real host/Session/checker, two loopback fixtures.

Never registered in the normal Chrome profile. Public source parsing is not changed.
"""
import asyncio
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
import host
from core import Candidate, Session, country_code
from pool import ReservePool


def configure(config):
    country = country_code(config['country'])
    ports = config['ports']
    if not isinstance(ports, list) or len(ports) != 2 or len(set(ports)) != 2:
        raise ValueError('Two distinct fixture ports required')
    if any(type(p) is not int or not 0 < p < 65536 for p in ports):
        raise ValueError('Invalid fixture port')
    candidates = [Candidate('http', '127.0.0.1', p) for p in ports]

    async def discover_fixture(requested):
        if requested != country:
            raise ValueError('Fixture country mismatch')
        return candidates, []

    class FixturePool(ReservePool):
        # Only the fixture identity differs: real public reserves require distinct host/egress.
        # Both local test listeners intentionally share one host and one real external IP.
        def conflicts(self, left, right):
            return (left['host'], left['port']) == (right['host'], right['port'])

        def candidate_conflicts(self, item, proxy):
            return (item.host, item.port) == (proxy['host'], proxy['port'])

    class FixtureSession(Session):
        def __init__(self, requested, emit):
            # Keep production health intervals, HTTPS checker and rotation logic.
            super().__init__(requested, emit, discoverer=discover_fixture, pool_factory=FixturePool)

        def eligible(self, candidate):
            return self.excluded.get(candidate.key, 0) <= time.monotonic()

        def exclude(self, candidate, seconds=180):
            self.excluded[candidate.key] = time.monotonic() + seconds

    return FixtureSession


if __name__ == '__main__':
    config_path = Path(sys.argv[1]).resolve()
    config_path.relative_to(ROOT / '.runtime')
    host.Session = configure(json.loads(config_path.read_text()))
    asyncio.run(host.main())
