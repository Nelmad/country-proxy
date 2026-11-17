"""Compare cold production Session transport ordering, with no network or Chrome.

Run the same file against a Stage 1 snapshot and the candidate, in separate
processes. Only catalogue transport, elapsed delays and checker output are fake.
"""
import argparse
import asyncio
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import sys
import time
from unittest.mock import patch

COUNTRIES = ('AT', 'EE', 'NO')
FAST_S, SLOW_S, EMPTY_S = .008, .12, .001


async def sample(core, sources):
    events = []; winners = []; connected = asyncio.Event(); started = time.monotonic()
    def mark(name, cc=None):
        events.append((name, (time.monotonic() - started) * 1000, cc))
    by_url = {s.for_country(cc): (s, cc) for s in sources.SOURCES for cc in COUNTRIES}
    async def fetch(url, *args, **kwargs):
        source, cc = by_url[url]
        if source.name == 'hproxy-live':
            mark('slow-start', cc)
            try: await asyncio.sleep(SLOW_S)
            except asyncio.CancelledError:
                mark('slow-cancel', cc); raise
            mark('slow-finish', cc); return 0, '200', '[]'
        if source.name == 'Proxifly':
            await asyncio.sleep(FAST_S); mark('fast-ready', cc)
            return 0, '200', f'http://8.8.8.{1 + COUNTRIES.index(cc)}:8080'
        await asyncio.sleep(EMPTY_S)
        return 0, '200', {'geonode':'{"data":[]}', 'proxmint':'{"rows":[]}'}.get(source.format, '')
    async def library(argv, *args, **kwargs):
        assert argv[-2].endswith('library_source.py') and argv[-1] in COUNTRIES
        await asyncio.sleep(EMPTY_S); return 0, ''
    async def checker(candidate, countries, slow=False):
        cc = COUNTRIES[int(candidate.host.rsplit('.', 1)[1]) - 1]; mark('checker-start', cc)
        await asyncio.sleep(.001)
        return dict(scheme=candidate.scheme, host=candidate.host, port=candidate.port,
                    country=cc, exitIp=candidate.host, latencyMs=1, checkedAt=0)
    def emit(event):
        if event['phase']=='connected':
            assert event['country'] in COUNTRIES; winners.append(event['country']); connected.set()
    # Isolate the payload cache and retry timers identically per trial, including
    # the list-returning API on the saved baseline and the stream API on new code.
    cache=sources.SourceCache()
    with ExitStack() as ctx:
        for name in ('collect','stream_feeds'):
            if hasattr(sources,name):
                fn=getattr(sources,name)
                def cached(*a,_fn=fn,**kw): return _fn(*a,**{**kw,'cache':cache})
                ctx.enter_context(patch.object(sources,name,cached))
        ctx.enter_context(patch.object(core,'curl',fetch));ctx.enter_context(patch.object(core,'process',library))
        session=core.Session(COUNTRIES,emit,checker=checker,interval=60)
        task=asyncio.create_task(session.run())
        try: await asyncio.wait_for(connected.wait(),2)
        finally: task.cancel(); await asyncio.gather(task,return_exceptions=True)
    first=next(e for e in events if e[0]=='checker-start')
    pending={cc for label,at,cc in events if label=='slow-start' and at<first[1]} - {cc for label,at,cc in events if label in ('slow-finish','slow-cancel') and at<=first[1]}
    assert winners and not session.pool_task
    return dict(first_checker_ms=first[1],same_country_slow_pending=first[2] in pending,
                other_country_slow_pending=bool(pending-{first[2]}), country=first[2])


async def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    sys.path.insert(0,str(args.root.resolve()/'native'));import core,sources
    rows=[await sample(core,sources) for _ in range(20)];values=sorted(x['first_checker_ms'] for x in rows)
    result=dict(scope='cold injected source transports; production Session; synthetic checker; not Chrome',
                harness_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                source_delays_s=[FAST_S,SLOW_S,EMPTY_S], trials=rows,median_ms=(values[9]+values[10])/2,p95_ms=values[18],
                first_while_both_slow_pending=sum(r['same_country_slow_pending'] and r['other_country_slow_pending'] for r in rows))
    args.output.write_text(json.dumps(result,indent=2)+'\n');print({k:v for k,v in result.items() if k not in ('trials','scope','source_delays_s')})

if __name__=='__main__': asyncio.run(main())
