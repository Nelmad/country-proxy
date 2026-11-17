"""Passively record the two approved control responses and addressed feedback in a disposable profile."""
import asyncio
import hashlib
import hmac
import json
from contextvars import ContextVar
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from public_group_host import core, host, monitor


def record_offers(directory):
    salt = (directory / 'alias-salt').read_bytes()
    journal = directory / 'offers.jsonl'
    checked = {}
    current = ContextVar('control_responses', default=None)
    curl = core.curl
    inspect = core.inspect_proxy
    send = host.send
    receive = host.receive

    def alias(proxy):
        key = f"{proxy['scheme']}://{proxy['host']}:{proxy['port']}"
        return hmac.new(salt, key.encode(), hashlib.sha256).hexdigest()[:16]

    def write(row):
        with journal.open('a') as stream:
            print(json.dumps({**row, 'atMs': time.time_ns() // 1_000_000}), file=stream)

    async def observe_curl(url, proxy=None, slow=False):
        response = await curl(url, proxy, slow)
        observations = current.get()
        if observations is not None and url in (core.TRACE, core.TARGET):
            rc, http_status, _ = response
            observations['trace' if url == core.TRACE else 'target'] = {'curl': rc, 'status': http_status}
        return response

    async def observe_check(candidate, country, slow=False, **kwargs):
        observations = {}
        token = current.set(observations)
        try:
            result = await inspect(candidate, country, slow, **kwargs)
            if result.get('ok'):
                proxy = result['proxy']
                if len(checked) >= 480:
                    del checked[next(iter(checked))]
                checked[alias(proxy), proxy['checkedAt']] = observations
            return result
        finally:
            current.reset(token)

    def send_observed(message):
        if message.get('type') == 'status' and message.get('phase') == 'connected':
            p = message['proxy']
            name = alias(p)
            write({'event':'offer', 'session':message['id'], 'attempt':message['attempt'],
                   'alias':name, 'scheme':p['scheme'], 'country':p['country'], 'checkedAt':p['checkedAt'],
                   'latencyMs':p.get('latencyMs'), 'nativeRequests':checked.get((name, p['checkedAt']))})
        send(message)

    async def receive_observed(reader):
        message = await receive(reader)
        if message.get('command') in ('confirm', 'reject'):
            write({'event':message['command'], 'session':message['id'], 'attempt':message['attempt'],
                   'alias':alias(message['proxy']), 'reason':message.get('reason')})
        return message

    core.curl = observe_curl
    core.inspect_proxy = observe_check
    host.send = send_observed
    host.receive = receive_observed


if __name__ == '__main__':
    directory = Path(sys.argv[1])
    monitor(directory, int(sys.argv[2]))
    record_offers(directory)
    asyncio.run(host.entry(directory / 'history'))
