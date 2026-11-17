"""One-shot, bounded catalogue adapter. Catalogue claims are not local checks."""
import os
import signal
import sys

MAX_BYTES = 2_000_000
DEADLINE = 28
BASES = ('https://proxy-scraper.de',
         'https://raw.githubusercontent.com/maximilianfeix/proxy-scraper/proxy-list')
URLS = frozenset(base + '/' + name for base in BASES
                 for name in ('proxies.json', 'stats.json'))


async def read_body(reader):
    """Bound decoded bytes before JSON parsing, including unknown-length bodies."""
    import re
    head = await reader.readuntil(b'\r\n\r\n')
    lines = head[:-4].split(b'\r\n')
    if len(head) > 16384 or not re.fullmatch(rb'HTTP/1\.[01] 200(?: [^\r\n]*)?', lines[0]):
        raise ValueError('invalid catalogue response')
    headers = {}
    for line in lines[1:]:
        key, sep, value = line.partition(b':')
        key = key.strip().lower()
        if not sep or not re.fullmatch(rb"[!#$%&'*+.^_`|~0-9a-z-]+", key) or (key in headers and key in (b'content-length', b'transfer-encoding', b'content-encoding')):
            raise ValueError('ambiguous headers')
        headers[key] = value.strip().lower()
    if headers.get(b'content-encoding', b'identity') != b'identity':
        raise ValueError('encoded catalogue denied')
    transfer = headers.get(b'transfer-encoding')
    length = headers.get(b'content-length')
    if transfer and (transfer != b'chunked' or length is not None):
        raise ValueError('ambiguous framing')
    out = bytearray()
    if transfer:
        while True:
            line = await reader.readuntil(b'\r\n')
            if len(line) > 1024:
                raise ValueError('chunk header too large')
            token = line[:-2].split(b';', 1)[0]
            if not re.fullmatch(rb'[0-9a-fA-F]+', token):
                raise ValueError('invalid chunk size')
            size = int(token, 16)
            if size < 0 or size > MAX_BYTES - len(out):
                raise ValueError('catalogue too large')
            if not size:
                if await reader.readexactly(2) != b'\r\n':
                    raise ValueError('trailers denied')
                return bytes(out)
            out.extend(await reader.readexactly(size))
            if await reader.readexactly(2) != b'\r\n':
                raise ValueError('invalid chunk')
    if length is not None:
        if not length.isdigit() or int(length) > MAX_BYTES:
            raise ValueError('catalogue too large')
        return await reader.readexactly(int(length))
    while True:
        chunk = await reader.read(min(65536, MAX_BYTES + 1 - len(out)))
        if not chunk:
            return bytes(out)
        out.extend(chunk)
        if len(out) > MAX_BYTES:
            raise ValueError('catalogue too large')


async def verified_fetch(url, timeout=20, headers=None):
    import asyncio
    import ssl
    from urllib.parse import urlsplit
    if url not in URLS or headers:
        raise ValueError('untrusted catalogue endpoint')
    target = urlsplit(url)
    # No redirects, proxy environment, insecure fallback, or compressed responses.
    async def request():
        reader, writer = await asyncio.open_connection(
            target.hostname, 443, ssl=ssl.create_default_context(),
            server_hostname=target.hostname, limit=16384)
        try:
            writer.write(('GET ' + target.path + ' HTTP/1.1\r\nHost: ' +
                          target.hostname + '\r\nAccept-Encoding: identity\r\n'
                          'Connection: close\r\n\r\n').encode('ascii'))
            await writer.drain()
            return await read_body(reader)
        finally:
            writer.close()
            await writer.wait_closed()
    return await asyncio.wait_for(request(), min(timeout, 20))


class FetchGroup:
    """Both library callbacks await one owned, parsed mirror pair.

    A failure cannot escape to LiveSource's fallback while sibling HTTP work
    remains alive, including failures that occur before either callback awaits.
    """
    def __init__(self, fetch=verified_fetch):
        self.fetch = fetch
        self.pairs = {}

    async def _pair(self, base, timeout):
        import asyncio
        import json
        async def one(name):
            body = await self.fetch(base + '/' + name, timeout=timeout)
            json.loads(body)  # parse errors belong to the owned pair too
            return body
        tasks = [asyncio.create_task(one(name)) for name in ('proxies.json', 'stats.json')]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for task in done:
                task.result()
            return dict(zip(('proxies.json', 'stats.json'), await asyncio.gather(*tasks)))
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def __call__(self, url, timeout=20, headers=None):
        import asyncio
        if url not in URLS or headers:
            raise ValueError('untrusted catalogue endpoint')
        base, name = url.rsplit('/', 1)
        if base not in self.pairs:
            self.pairs[base] = asyncio.create_task(self._pair(base, timeout))
        return (await self.pairs[base])[name]


def main():
    # Arm before third-party imports or outbound work; independent of parent lifetime.
    signal.signal(signal.SIGALRM, lambda *_: os._exit(124))
    signal.setitimer(signal.ITIMER_REAL, DEADLINE)
    import re
    if len(sys.argv) != 2 or not re.fullmatch('[A-Z]{2}', sys.argv[1]):
        raise ValueError('expected ISO country code')
    # Catalogue API only reads live rows. Fail closed if future library code
    # attempts learned-state I/O; never consult the owner's foreign library state.
    os.environ['PROXY_SCRAPER_HOME'] = '/dev/null'
    from proxyscraper import api
    from proxyscraper.agent import LIVE_BASES
    if tuple(LIVE_BASES) != BASES:
        raise RuntimeError('library mirror contract changed')
    api._live_fetch = FetchGroup()
    proxies = api.live_proxies(countries=[sys.argv[1]],
                               types=['http', 'socks4', 'socks5'], limit=120)
    for proxy in proxies:
        print(f'{proxy.ptype}://{proxy.proxy}')



if __name__ == '__main__':
    main()
