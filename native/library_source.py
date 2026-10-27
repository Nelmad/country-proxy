"""Isolate proxy-scraper catalogue access (it does not verify local reachability)."""
import os
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix='country-proxy-catalog-') as state:
    os.environ['PROXY_SCRAPER_HOME'] = state
    from proxyscraper.api import live_proxies
    for proxy in live_proxies(countries=[sys.argv[1]], types=['http', 'socks4', 'socks5'], limit=120):
        print(f'{proxy.ptype}://{proxy.proxy}')
