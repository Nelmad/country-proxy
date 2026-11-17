#!/usr/bin/env python3
"""Owned Chrome profile only: real Session/checker, one injected loopback endpoint.

No clock acceleration, fake HTTPS result, country override or public feed access.
The sole policy injection admits the specifically owned loopback listener into
history; production parsing and endpoint validation remain unchanged.
"""
import asyncio
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import signal
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'native'))
import host
from core import Candidate, Session, country_code
from history import EndpointHistory


async def main(config_path):
    config_path = Path(config_path).resolve()
    config_path.relative_to(ROOT / '.runtime' / 'stage4-history')
    config = json.loads(config_path.read_text())
    port, country = config['port'], country_code(config['country'])
    if type(port) is not int or not 0 < port < 65536:
        raise ValueError('One owned listener port required')
    directory = config_path.parent
    data_dir = directory / 'history'
    candidate = Candidate('http', '127.0.0.1', port)
    events = directory / 'native-events.jsonl'

    def record(value):
        with events.open('a') as output:
            output.write(json.dumps({'at': time.time(), 'mono': time.monotonic(),
                                     'pid': os.getpid(), **value}) + '\n')

    record({'event': 'start', 'config': str(config_path), 'dataDir': str(data_dir),
            'fingerprints': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in sorted((ROOT / 'native').glob('*.py'))}})
    history = EndpointHistory(endpoint_validator=lambda address: address == ipaddress.ip_address('127.0.0.1'))
    sessions = 0

    class FixtureSession(Session):
        def __init__(self, requested, emit, **kwargs):
            nonlocal sessions
            sessions += 1
            self.fixture_session = sessions

            async def discover_fixture(requested_country):
                if requested_country != country:
                    raise ValueError('Fixture country mismatch')
                record({'event': 'discover', 'session': self.fixture_session,
                        'port': port, 'country': requested_country})
                return [candidate], []

            def observed(event):
                record({'event': 'status', 'session': self.fixture_session, 'status': event})
                emit(event)

            super().__init__(requested, observed, discoverer=discover_fixture, **kwargs)

        async def _raw_report(self, item, requested_country, slow=False, extras=None):
            record({'event': 'checker-start', 'session': self.fixture_session,
                    'port': item.port, 'slow': bool(slow)})
            try:
                report = await super()._raw_report(item, requested_country, slow, extras)
                record({'event': 'checker-result', 'session': self.fixture_session,
                        'port': item.port, 'slow': bool(slow), 'report': report})
                return report
            except asyncio.CancelledError:
                record({'event': 'checker-cancel', 'session': self.fixture_session,
                        'port': item.port, 'slow': bool(slow)})
                raise

        def remember_check(self, item, observation, report):
            already = bool(report and report.get('_remembered'))
            super().remember_check(item, observation, report)
            if report is None or already:
                return
            rec = self.history.get(item)
            record({'event': 'logical-outcome', 'session': self.fixture_session,
                    'port': item.port, 'reason': report.get('reason'), 'ok': report.get('ok', False),
                    'history': None if rec is None else {
                        'streak': rec.streak, 'ewmaMs': rec.ewma_ms,
                        'lastSuccess': rec.last_success,
                        'cooldownUntilWall': None if rec.cooldown_until is None else
                        time.time() + rec.cooldown_until - time.monotonic(),
                        'eligible': self.history.eligible(item)}})

        def browser_feedback(self, command, attempt, proxy, reason=None):
            accepted = super().browser_feedback(command, attempt, proxy, reason)
            record({'event': 'feedback', 'session': self.fixture_session,
                    'command': command, 'attempt': attempt, 'proxy': proxy,
                    'reason': reason, 'accepted': accepted})
            return accepted

    host.Session = FixtureSession
    original_send = host.send

    def observed_send(message):
        if message.get('type') == 'hello':
            record({'event': 'hello', 'message': message})
        elif message.get('type') == 'status':
            record({'event': 'history-status', 'phase': message.get('phase'),
                    'history': message.get('history'),
                    'port': (message.get('proxy') or {}).get('port')})
        original_send(message)

    host.send = observed_send
    task = asyncio.create_task(host.main(data_dir, history=history))
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        await task
    except asyncio.CancelledError:
        pass
    finally:
        record({'event': 'exit', 'records': len(history.records)})


if __name__ == '__main__':
    asyncio.run(main(Path(sys.argv[1])))
