"""Production Session + host.status_message serializer with paired HTTPS completions.

No external network: discovery and curl are injected. Both results are made
ready in one event-loop turn in each order; controller admission is not mocked.
"""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import sys
from unittest.mock import patch

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-root', type=Path, required=True)
args = parser.parse_args()
root = args.source_root.resolve()
sys.path.insert(0, str(root / 'native'))
import core
from host import status_message


async def measure(order):
    selected = ('AT', 'EE', 'NO')
    candidate = core.Candidate('http', '8.8.8.8', 3128)
    events = asyncio.Queue()
    ready = asyncio.Event()
    controls = {}
    mode = 'initial'
    endpoints = {core.TRACE: 'trace', core.TARGET: 'target'}
    completed = []

    async def source(_country):
        return [candidate], []

    async def transfer(url, _candidate, _slow=False):
        name = endpoints[url]
        if mode in ('initial', 'recovered'):
            return (0, '200', 'ip=9.9.9.9\nloc=NO') if name == 'trace' else (0, '204', '')
        controls[name] = asyncio.get_running_loop().create_future()
        if len(controls) == 2:
            ready.set()
        response = await controls[name]
        completed.append(name)
        return response

    def emit(event):
        if event['phase'] in ('connected', 'confirming', 'replacing'):
            events.put_nowait(status_message('fixture-session', selected, event))

    with patch.object(core, 'curl', transfer):
        session = core.Session(selected, emit, discoverer=source, interval=60)
        session.wait_for_browser = True
        owner = asyncio.create_task(session.run())
        try:
            first = await events.get()
            address = {key: first['proxy'][key] for key in ('scheme', 'host', 'port')}
            assert session.browser_feedback('confirm', first['attempt'], address)
            mode = 'dual'
            session.nudge()
            await ready.wait()
            for name in order:
                controls[name].set_result((0, '200', 'ip=9.9.9.9\nloc=JP') if name == 'trace' else (28, '', ''))
            warning = await events.get()
            assert completed == list(order), completed
            assert warning['phase'] == 'confirming', warning
            mode = 'recovered'
            session.nudge()
            recovered = await events.get()
            assert recovered['phase'] == 'connected', recovered
            return {'completionOrder': completed, 'first': first, 'warning': warning, 'recovered': recovered}
        finally:
            owner.cancel()
            await asyncio.gather(owner, return_exceptions=True)


async def main():
    cases = []
    for order in [('target', 'trace'), ('trace', 'target')]:
        async with asyncio.timeout(5):
            cases.append(await measure(order))
    print(json.dumps({'countries': ['AT', 'EE', 'NO'], 'cases': cases,
                      'syntheticDiscovery': True, 'syntheticCurl': True, 'pythonVersion': sys.version,
                      'productionComponents': ['core.Session', 'host.status_message serializer'],
                      'productionHostEventLoop': False,
                      'sourceSHA256': {name: hashlib.sha256((root/'native'/name).read_bytes()).hexdigest()
                                       for name in ('core.py', 'host.py')}}, separators=(',', ':')))


if __name__ == '__main__':
    asyncio.run(main())
