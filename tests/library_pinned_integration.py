"""Run explicitly using the approved installed proxy-scraper interpreter."""
import asyncio
import unittest
from unittest.mock import patch
from test_library_limits import source


class PinnedLibrary(unittest.TestCase):
    def test_real_library_mirror_recovery_country_and_cap(self):
        import json
        from datetime import datetime, timezone
        from proxyscraper import api
        rows = [{'ptype': 'http', 'proxy': f'8.8.8.8:{1000 + i}',
                 'country': 'DE', 'latency': 10} for i in range(130)]
        rows.append({'ptype': 'http', 'proxy': '1.1.1.1:80', 'country': 'US'})
        stats = {'updated': datetime.now(timezone.utc).isoformat(), 'run_hours': 1}
        calls = []
        async def fetch(url, **_):
            calls.append(url)
            if url.startswith(source.BASES[0]):
                if url.endswith('/proxies.json'):
                    await asyncio.sleep(.01)
                    raise ValueError('first mirror fixture')
                await asyncio.sleep(100)
            return json.dumps(rows if url.endswith('/proxies.json') else stats).encode()
        group = source.FetchGroup(fetch)
        with patch.object(api, '_live_fetch', group):
            found = api.live_proxies(countries=['DE'], types=['http', 'socks4', 'socks5'], limit=120)
        self.assertEqual(len(found), 120)
        self.assertTrue(all(p.country == 'DE' for p in found))
        self.assertEqual(set(calls), source.URLS)
        self.assertTrue(all(task.done() for task in group.pairs.values()))


if __name__ == "__main__":
    unittest.main()
