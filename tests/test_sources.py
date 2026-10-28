import asyncio
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, curl, parse_candidates
from sources import Source, SourceCache, SOURCES, collect, fair_merge, parse_feed

A = Candidate('http', '8.8.8.8', 80)
B = Candidate('socks5', '1.1.1.1', 1080)

class FeedTests(unittest.TestCase):
    def test_generic_country_urls(self):
        for source in SOURCES:
            for country in ('NO', 'EE', 'AT', 'JP', 'SE'):
                url = source.for_country(country)
                self.assertTrue(url.startswith('https://'))
                self.assertTrue(country in url or country.lower() in url)
            with self.assertRaises(ValueError): source.for_country('../NO')

    def test_typed_tls_and_protocol_specific_list(self):
        values = parse_candidates('https://8.8.8.8:443')
        self.assertEqual(values, [Candidate('https', '8.8.8.8', 443)])
        source = Source('tls', 'https://example.org', 'plain-https')
        raw = '\n'.join([
            '8.8.8.8:443', 'http://1.1.1.1:80',
            '127.0.0.1:443', 'user@1.1.1.1:443',
        ])
        self.assertEqual(parse_feed(source, raw, 'JP', parse_candidates), values)

    def test_json_country_protocol_and_untrusted_fields(self):
        source = Source('geo', 'https://example.org', 'geonode')
        def row(**kw): return dict(ip='8.8.8.8', port='80', country='JP', protocols=['http'], **kw)
        good = row()
        rows = [good, good, {**good, 'country': 'NO'}, {**good, 'ip': '127.0.0.1'},
                {**good, 'ip': 'user@8.8.8.8'}, {**good, 'ip': '8.8.8.8\n1.1.1.1'},
                {**good, 'port': True}, {**good, 'port': '65536'},
                {**good, 'protocols': 'http'}, {**good, 'protocols': ['file', {}, []]},
                {**good, 'ip': '224.0.0.1'}, None]
        self.assertEqual(parse_feed(source, json.dumps({'data': rows}), 'JP', parse_candidates), [A])
        with self.assertRaises(ValueError): parse_feed(source, '{"data": {}}', 'JP', parse_candidates)

    def test_proxmint_schema_and_https_connect(self):
        source = Source('mint', 'https://example.org', 'proxmint')
        data = {'rows': [{'ip': '8.8.8.8', 'port': 80, 'countryCode': 'se', 'protocol': 'https'}]}
        self.assertEqual(parse_feed(source, json.dumps(data), 'SE', parse_candidates), [A])
        self.assertEqual(parse_feed(source, json.dumps(data), 'NO', parse_candidates), [])

    def test_fair_merge_and_dedup_cap(self):
        huge = [Candidate('http', '8.8.8.8', port) for port in range(1, 121)]
        merged = fair_merge([huge, [B], [A, B]], 5)
        self.assertEqual(len(merged), 5)
        self.assertEqual(merged[:3], [huge[0], B, A])
        self.assertEqual(fair_merge([[A,A], [A,B]], 120), [A,B])
        self.assertEqual(fair_merge([[A]], 0), [])

    def test_cache_expiry_and_lru_bound(self):
        now = [0]; cache = SourceCache(clock=lambda: now[0], limit=2)
        cache.put('a', ([], None), 300); cache.put('b', ([B], None), 60)
        self.assertIsNotNone(cache.get('a'))
        cache.put('c', ([A], None), 300)
        self.assertIsNone(cache.get('b'))
        now[0] = 301
        self.assertIsNone(cache.get('a')); self.assertIsNone(cache.get('c'))

class CollectTests(unittest.IsolatedAsyncioTestCase):
    async def test_partial_failure_empty_404_and_library_failure(self):
        feeds = [Source('ok','https://example.org/ok'), Source('empty','https://example.org/empty', empty_404=True),
                 Source('bad','https://example.org/bad'), Source('malformed','https://example.org/malformed','geonode')]
        async def fetch(url):
            if url.endswith('/ok'): return 0, '200', 'http://8.8.8.8:80'
            if url.endswith('/empty'): return 0, '404', 'Not found'
            if url.endswith('/malformed'): return 0, '200', '{'
            raise OSError('remote error is not forwarded')
        async def library(): raise RuntimeError('library failure')
        values, errors = await collect('SE', fetch, parse_candidates, library, sources=feeds, cache=SourceCache())
        self.assertEqual(values,[A]); self.assertEqual(len(errors),3)
        self.assertFalse(any('remote error' in e for e in errors))

    async def test_country_cache_ttl_and_failure_backoff(self):
        now=[0]; cache=SourceCache(clock=lambda:now[0]); calls=[]
        feed=Source('ok','https://example.org/{country}',ttl=300)
        async def fetch(url): calls.append(url); return 0,'200','http://8.8.8.8:80'
        async def library(): return []
        async def run(cc='NO'):
            return await collect(cc,fetch,parse_candidates,library,sources=[feed],cache=cache)
        await run(); await run(); self.assertEqual(len(calls),1)
        await run('SE'); self.assertEqual(len(calls),2)
        now[0]=300; await run(); self.assertEqual(len(calls),3)
        async def failed(url): calls.append(url); return 1,'000',''
        cache=SourceCache(clock=lambda:now[0]); fetch=failed
        await run(); await run(); self.assertEqual(len(calls),4)
        now[0]=360; await run(); self.assertEqual(len(calls),5)

    async def test_provider_shards_get_one_share_and_cap(self):
        feeds=[Source('one-http','https://example.org/http',group='one'),
               Source('one-socks','https://example.org/socks',group='one'),
               Source('two','https://example.org/two')]
        async def library(): return [Candidate('http','9.9.9.9',p) for p in range(1,121)]
        async def fetch(url):
            if url.endswith('/two'): return 0,'200','socks5://1.1.1.1:1080'
            return 0,'200','http://8.8.8.8:80' if url.endswith('/http') else 'socks4://8.8.4.4:90'
        values,_=await collect('JP',fetch,parse_candidates,library,cap=3,sources=feeds,cache=SourceCache())
        self.assertEqual(values,[Candidate('http','9.9.9.9',1),A,B])
        values,_=await collect('JP',fetch,parse_candidates,library,cap=999,sources=feeds,cache=SourceCache())
        self.assertEqual(len(values),120)

    async def test_invalid_country_has_no_network_or_library_side_effect(self):
        async def unexpected(*args): self.fail('must validate first')
        with self.assertRaises(ValueError):
            await collect('../NO',unexpected,parse_candidates,unexpected)

    async def test_cancellation_cancels_feeds(self):
        started=asyncio.Event(); cancelled=asyncio.Event()
        async def library(): return []
        async def fetch(url):
            started.set()
            try: await asyncio.sleep(60)
            finally: cancelled.set()
        task=asyncio.create_task(collect('SE',fetch,parse_candidates,library,sources=[SOURCES[0]],cache=SourceCache()))
        await started.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(cancelled.is_set())

    async def test_tls_proxy_does_not_relax_certificate_validation(self):
        argv=[]
        async def fake(args,timeout): argv.extend(args); return 0, 'ok\n200'
        with patch('core.process',fake):
            await curl('https://example.org',Candidate('https','8.8.8.8',443))
        self.assertEqual(argv[argv.index('--proxy')+1], 'https://8.8.8.8:443')
        for flag in ('--insecure','-k','--proxy-insecure'): self.assertNotIn(flag,argv)

if __name__ == '__main__': unittest.main()
