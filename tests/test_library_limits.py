"""Offline source bounds; no catalogue or network access."""
import asyncio
import importlib.util
import pathlib
import signal
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'native/library_source.py'
spec = importlib.util.spec_from_file_location('bounded_library', SOURCE)
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


def reader(data):
    value = asyncio.StreamReader(limit=16384)
    value.feed_data(data)
    value.feed_eof()
    return value


class Limits(unittest.IsolatedAsyncioTestCase):
    async def test_content_length_and_unknown_length(self):
        for payload in (b'Content-Length: 2000001\r\n\r\n',
                        b'\r\n' + b'x' * 2000001):
            with self.assertRaises(ValueError):
                await source.read_body(reader(b'HTTP/1.1 200 OK\r\n' + payload))
        with self.assertRaises(asyncio.IncompleteReadError):
            await source.read_body(reader(b'HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{}'))

    async def test_chunked(self):
        head = b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'
        self.assertEqual(await source.read_body(reader(head + b'2\r\n{}\r\n0\r\n\r\n')), b'{}')
        for body in (b'1e8481\r\n', b'2\r\nx', b'2\r\n{}xx'):
            with self.assertRaises((ValueError, asyncio.IncompleteReadError)):
                await source.read_body(reader(head + body))

    async def test_strict_tls_one_attempt(self):
        calls = []
        async def fail(*args, **kwargs):
            calls.append(kwargs)
            self.assertTrue(kwargs['ssl'].check_hostname)
            self.assertEqual(kwargs['ssl'].verify_mode, ssl.CERT_REQUIRED)
            raise ssl.SSLCertVerificationError('fixture')
        with patch('asyncio.open_connection', fail):
            with self.assertRaises(ssl.SSLCertVerificationError):
                await source.verified_fetch(next(iter(source.URLS)))
        self.assertEqual(len(calls), 1)
        for url in ('http://proxy-scraper.de/proxies.json', 'https://evil.test/proxies.json',
                    'https://proxy-scraper.de/elsewhere'):
            with self.assertRaises(ValueError):
                await source.verified_fetch(url)

    async def test_pair_failure_drains_before_mirror_fallback(self):
        for mode in ('early', 'json', 'late'):
            active = set()
            calls = []
            async def fetch(url, **_):
                calls.append(url)
                base, name = url.rsplit('/', 1)
                if base == source.BASES[1]:
                    self.assertFalse(active)
                    return b'{}'
                if name == 'proxies.json':
                    if mode == 'late':
                        await asyncio.sleep(.01)
                    if mode == 'json':
                        return b'broken json'
                    raise ValueError('fixture')
                active.add(url)
                try:
                    await asyncio.sleep(100)
                finally:
                    active.discard(url)
            group = source.FetchGroup(fetch)
            async def pair(base):
                return await asyncio.gather(*(group(base + '/' + name)
                    for name in ('proxies.json', 'stats.json')))
            with self.assertRaises(ValueError):
                await asyncio.wait_for(pair(source.BASES[0]), 1)
            self.assertFalse(active)
            self.assertEqual(await asyncio.wait_for(pair(source.BASES[1]), 1), [b'{}', b'{}'])
            self.assertEqual(len(calls), 4)
            self.assertTrue(all(task.done() for task in group.pairs.values()))

    async def test_http_syntax_and_harmless_duplicate_headers(self):
        self.assertEqual(await source.read_body(reader(
            b'HTTP/1.1 200 OK\r\nSet-Cookie: a\r\nSet-Cookie: b\r\nContent-Length: 2\r\n\r\n{}')), b'{}')
        for payload in (
            b'GARBAGE 200 OK\r\n\r\n{}',
            b'HTTP/1.1 302 Found\r\nLocation: https://evil.test\r\n\r\n',
            b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}',
            b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n',
        ):
            with self.assertRaises(ValueError):
                await source.read_body(reader(payload))
        for token in (b'+2', b' 2', b'0x2', b'-1'):
            with self.assertRaises(ValueError):
                await source.read_body(reader(b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' + token + b'\r\n{}\r\n0\r\n\r\n'))


class Watchdog(unittest.TestCase):
    def test_worker_deadline_after_parent_sigkill(self):
        # Run the real entrypoint with only its deadline shortened and a blocking
        # third-party import. The immediate parent dies; worker must still exit.
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            marker = root / 'entered'
            package = root / 'proxyscraper'
            package.mkdir()
            (package / '__init__.py').write_text(
                'import pathlib,time\npathlib.Path(' + repr(str(marker)) + ').touch()\ntime.sleep(60)\n')
            worker = root / 'worker.py'
            worker.write_text(
                'import importlib.util,sys\n'
                'spec=importlib.util.spec_from_file_location("adapter",sys.argv[1])\n'
                'adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)\n'
                'adapter.DEADLINE=1;sys.argv=[sys.argv[1],"DE"];adapter.main()\n')
            monitor_file = root / 'parent.py'
            monitor_file.write_text(
                'import subprocess,sys\n'
                'p=subprocess.Popen([sys.executable,sys.argv[1],sys.argv[2]])\np.wait()\n')
            monitor = subprocess.Popen([sys.executable, str(monitor_file), str(worker), str(SOURCE)],
                                       start_new_session=True, stdout=subprocess.PIPE)
            try:
                end = time.monotonic() + 4
                while not marker.exists() and time.monotonic() < end:
                    time.sleep(.01)
                self.assertTrue(marker.exists())
                monitor.send_signal(signal.SIGKILL)
                # The orphan inherits the pipe; EOF proves watchdog termination.
                monitor.communicate(timeout=4)
            finally:
                # Only this test's newly created session/group may be killed.
                import os
                try:
                    os.killpg(monitor.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                monitor.wait(timeout=2)


if __name__ == '__main__':
    unittest.main()
