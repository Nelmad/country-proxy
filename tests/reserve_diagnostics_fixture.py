"""Synthetic feed and checker for the isolated popup lab. Only A carries Chrome traffic."""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import host
from core import Candidate, Session


def session_factory(port, release):
    active = Candidate('http', '127.0.0.1', port)
    duplicate_host = Candidate('socks5', active.host, port)
    duplicate_exit = Candidate('http', '192.0.2.2', 8080)
    independent = Candidate('http', '192.0.2.3', 8080)
    outside = Candidate('http', '192.0.2.4', 8080)

    class FixtureSession(Session):
        def __init__(self, selected, emit):
            async def feed(country):
                if not self.active:
                    return [active], []
                candidates = [duplicate_host, duplicate_exit, outside]
                if release.is_file():
                    candidates.append(independent)
                return candidates, []

            async def check(item, countries, slow):
                country = 'DE' if item == outside else 'AT' if item == independent else 'NO'
                return {'scheme': item.scheme, 'host': item.host, 'port': item.port,
                        'exitIp': '192.0.2.44' if item == independent else '192.0.2.11',
                        'country': country,
                        'checkedAt': int(time.time() * 1000), 'latencyMs': 1}

            super().__init__(selected, emit, discoverer=feed, checker=check)
            self.pool.interval = 0.5

    return FixtureSession


if __name__ == '__main__':
    host.Session = session_factory(int(sys.argv[1]), Path(sys.argv[2]))
    asyncio.run(host.main())
