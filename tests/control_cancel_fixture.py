#!/usr/bin/env python3
"""Disposable Native Messaging fixture: real HTTPS checks, gate browser CONNECT only."""
import asyncio
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
import host
from core import Candidate, Session


def configure(config_path):
    config_path = Path(config_path).resolve()
    config_path.relative_to(ROOT / '.runtime')
    config = json.loads(config_path.read_text())
    port = config['port']
    if type(port) is not int or not 0 < port < 65536:
        raise ValueError('Invalid fixture port')
    paths = {key: Path(config[key]).resolve() for key in ('arm', 'hold', 'events')}
    for value in paths.values():
        value.relative_to(config_path.parent)

    async def discover(_country):
        # All requested countries use the same real egress. The production checker
        # must reject any requested country that differs from its HTTPS GeoIP.
        return [Candidate('http', '127.0.0.1', port)], []

    class FixtureSession(Session):
        def __init__(self, country, emit):
            def observed(event):
                if event.get('phase') == 'connected':
                    armed = paths['arm'].exists()
                    if armed:
                        paths['hold'].write_text('hold subsequent CONNECT\n')
                        paths['arm'].unlink()
                    with paths['events'].open('a') as log:
                        log.write(json.dumps({'at': time.time(), 'country': country,
                                              'proxy': event['proxy'], 'armed': armed}) + '\n')
                # The gate is set only AFTER the unmodified native TLS/GeoIP check
                # succeeds, and BEFORE Chrome receives the connected event.
                emit(event)
            super().__init__(country, observed, discoverer=discover)

    return FixtureSession


if __name__ == '__main__':
    host.Session = configure(sys.argv[1])
    asyncio.run(host.main())
