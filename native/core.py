"""Public proxy discovery and bounded HTTPS checks; no browser traffic passes here."""
import asyncio
import ipaddress
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COUNTRIES = set(json.loads((ROOT / 'extension/countries.json').read_text()))
SCHEMES = ('http', 'socks4', 'socks5')
TRACE = 'https://www.cloudflare.com/cdn-cgi/trace'
TARGET = 'https://www.google.com/generate_204'
SOURCE = 'https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/by-country/{country}.txt'


def country_code(value):
    if not isinstance(value, str) or value.upper() not in COUNTRIES:
        raise ValueError('Нужен код страны ISO 3166-1 alpha-2')
    return value.upper()


@dataclass(frozen=True)
class Candidate:
    scheme: str
    host: str
    port: int

    @property
    def url(self):
        scheme = 'socks5h' if self.scheme == 'socks5' else self.scheme
        return f'{scheme}://{self.host}:{self.port}'

    @property
    def key(self):
        return f'{self.scheme}://{self.host}:{self.port}'


def parse_candidates(text):
    """Lists are untrusted: accept public literal IPv4 only, never credentials or URLs."""
    result = []
    for line in text.splitlines():
        m = re.fullmatch(r'(?:(http|socks4|socks5)://)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})', line.strip())
        if not m:
            continue
        scheme, host, port = m.groups()
        try:
            ip = ipaddress.ip_address(host)
            if not ip.is_global or ip.is_multicast or not 0 < int(port) < 65536:
                continue
        except ValueError:
            continue
        result.extend(Candidate(s, host, int(port)) for s in ([scheme] if scheme else SCHEMES))
    return list(dict.fromkeys(result))


async def process(argv, timeout, max_bytes=2_000_000):
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'SSL_CERT_FILE') if k in os.environ}
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                              stderr=asyncio.subprocess.DEVNULL, env=env)
    async def bounded_read():
        chunks, size = [], 0
        while chunk := await proc.stdout.read(16384):
            size += len(chunk)
            if size > max_bytes:
                raise ValueError('response too large')
            chunks.append(chunk)
        await proc.wait()
        return b''.join(chunks)
    try:
        data = await asyncio.wait_for(bounded_read(), timeout)
        return proc.returncode, data.decode('utf-8', errors='replace')
    finally:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()


async def curl(url, proxy=None, slow=False):
    total = 45 if slow else 12
    argv = ['/usr/bin/curl', '--disable', '--silent', '--show-error', '--connect-timeout',
            str(30 if slow else 7), '--max-time', str(total), '--max-filesize', '2000000',
            '--proto', '=https', '--noproxy', '', '--proxy', proxy.url if proxy else '',
            '--write-out', '\n%{http_code}', url]
    code, text = await process(argv, total + 2)
    body, _, status = text.rpartition('\n')
    return code, status, body


async def discover(country, cap=120):
    country = country_code(country)
    # proxy-scraper runs in a short-lived subprocess, keeping its state and stdout separate.
    async def library():
        code, raw = await process([sys.executable, '-I', str(ROOT / 'native/library_source.py'), country], 28)
        if code:
            raise RuntimeError('proxy-scraper недоступен')
        return parse_candidates(raw)
    async def text_source():
        code, status, raw = await curl(SOURCE.format(country=country), slow=False)
        if code or status != '200':
            raise RuntimeError(f'hproxy: HTTP {status or "—"}')
        return parse_candidates(raw)
    parts = await asyncio.gather(library(), text_source(), return_exceptions=True)
    errors, combined = [], []
    for name, part in zip(('proxy-scraper', 'hproxy'), parts):
        if isinstance(part, BaseException):
            errors.append(name + ': источник недоступен')
        else:
            combined.extend(part)
    return list(dict.fromkeys(combined))[:cap], errors


async def check(candidate, country, slow=False):
    started = time.monotonic()
    responses = await asyncio.gather(curl(TRACE, candidate, slow), curl(TARGET, candidate, slow),
                                     return_exceptions=True)
    if any(isinstance(r, BaseException) for r in responses):
        return None
    (rc, status, trace), (rc2, status2, _) = responses
    if rc or rc2 or status != '200' or status2 != '204':
        return None
    fields = dict(line.split('=', 1) for line in trace.splitlines() if '=' in line)
    try:
        if fields.get('loc') != country or not ipaddress.ip_address(fields.get('ip', '')).is_global:
            return None
    except ValueError:
        return None
    return {**asdict(candidate), 'country': country, 'exitIp': fields['ip'],
            'latencyMs': round((time.monotonic() - started) * 1000),
            'checkedAt': int(time.time() * 1000)}


async def scan(candidates, country, on_progress, checker=check, concurrency=10):
    """Fast pass, then a generous retry for every country. Cancel all probes on first success."""
    for slow in (False, True):
        queue = asyncio.Queue()
        for candidate in candidates:
            queue.put_nowait(candidate)
        completed, found = 0, asyncio.get_running_loop().create_future()
        async def worker():
            nonlocal completed
            while not queue.empty() and not found.done():
                item = queue.get_nowait()
                result = await checker(item, country, slow)
                completed += 1
                on_progress('slow' if slow else 'checking', completed, len(candidates))
                if result and not found.done():
                    found.set_result(result)
        tasks = [asyncio.create_task(worker()) for _ in range(min(concurrency, len(candidates)))]
        if not tasks:
            return None
        all_done = asyncio.gather(*tasks)
        try:
            await asyncio.wait([found, all_done], return_when=asyncio.FIRST_COMPLETED)
            if found.done():
                return found.result()
            await all_done
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.gather(all_done, return_exceptions=True)
            if not found.done():
                found.cancel()
    return None


class Session:
    def __init__(self, country, emit, discoverer=discover, checker=check, interval=30, retry=60):
        self.country = country_code(country)
        self.emit = emit
        self.discoverer, self.checker = discoverer, checker
        self.interval, self.retry = interval, retry
        self.active = None
        self.wake = asyncio.Event()
        self.force_rotate = False
        self.excluded = {}

    def nudge(self, rotate=False):
        self.force_rotate |= rotate
        self.wake.set()

    async def pause(self, seconds):
        try:
            await asyncio.wait_for(self.wake.wait(), seconds)
        except asyncio.TimeoutError:
            pass
        self.wake.clear()

    async def run(self):
        failures = 0
        while True:
            if not self.active:
                self.emit({'phase': 'searching', 'proxy': None})
                candidates, errors = await self.discoverer(self.country)
                candidates = [c for c in candidates if self.excluded.get(c.key, 0) < time.monotonic()]
                self.emit({'phase': 'checking', 'total': len(candidates), 'done': 0, 'warnings': errors})
                self.active = await scan(candidates, self.country,
                    lambda phase, done, total: self.emit({'phase': phase, 'done': done, 'total': total}), self.checker)
                if not self.active:
                    self.emit({'phase': 'empty', 'proxy': None, 'warnings': errors, 'retrySeconds': self.retry})
                    await self.pause(self.retry)
                    continue
                failures = 0
                self.force_rotate = False
                self.emit({'phase': 'connected', 'proxy': self.active})
            await self.pause(self.interval)
            candidate = Candidate(self.active['scheme'], self.active['host'], self.active['port'])
            result = None if self.force_rotate else await self.checker(candidate, self.country, True)
            if result:
                failures = 0
                self.active = result
                self.emit({'phase': 'connected', 'proxy': result})
            else:
                failures += 1
                if self.force_rotate or failures >= 2:
                    self.excluded[candidate.key] = time.monotonic() + 180
                    self.active, self.force_rotate = None, False
                    self.emit({'phase': 'replacing', 'proxy': None})
                else:
                    self.emit({'phase': 'confirming', 'proxy': self.active})
