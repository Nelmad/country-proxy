import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import https_diagnosis_host as adapter


class DiagnosticHostTests(unittest.IsolatedAsyncioTestCase):
    async def test_source_and_concurrent_control_calls_keep_their_original_results(self):
        core, host = adapter.core, adapter.host
        first = core.Candidate('http', '192.0.2.1', 8080)
        second = core.Candidate('socks5', '192.0.2.2', 1080)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def fake_curl(url, proxy=None, slow=False):
            if proxy is None:
                return 0, '200', 'test list'
            if proxy == first and url == core.TRACE:
                entered.set()
                await release.wait()
            if url == core.TRACE:
                return 0, '200', 'ip=1.1.1.1\nloc=NO\n'
            return 0, '204', ''

        with tempfile.TemporaryDirectory() as name:
            path = Path(name)
            (path / 'alias-salt').write_bytes(b'fixture')
            with (patch.object(core, 'curl', fake_curl), patch.object(core, 'inspect_proxy', core.inspect_proxy),
                  patch.object(host, 'send', lambda _: None), patch.object(host, 'receive', host.receive)):
                adapter.record_offers(path)
                self.assertEqual(await core.curl('https://source.invalid/list'), (0, '200', 'test list'))
                a = asyncio.create_task(core.inspect_proxy(first, ['AT', 'EE', 'NO']))
                await asyncio.wait_for(entered.wait(), 1)
                try:
                    b = await core.inspect_proxy(second, ['AT', 'EE', 'NO'])
                finally:
                    release.set()
                for attempt, result in enumerate([await a, b], 1):
                    self.assertTrue(result['ok'])
                    host.send({'type': 'status', 'phase': 'connected', 'id': 'session',
                               'attempt': attempt, 'proxy': result['proxy']})
                journal = (path / 'offers.jsonl').read_text()
                entries = [json.loads(line) for line in journal.splitlines()]
                self.assertEqual(len(entries), 2)
                self.assertNotEqual(entries[0]['alias'], entries[1]['alias'])
                for record in entries:
                    self.assertEqual(record['nativeRequests'], {
                        'trace': {'curl': 0, 'status': '200'}, 'target': {'curl': 0, 'status': '204'}})
                self.assertNotIn('192.0.2.', journal)
