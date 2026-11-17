"""Group-only soak. Production Session and curl subprocesses with a private TLS origin and controlled feed."""
import asyncio
import json
from pathlib import Path
import sys
import time
product, scratch = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(product / 'native'))
import core
import host
from pool import ReservePool
ports=json.loads((scratch/'ports.json').read_bytes())
countries=('AT','EE','NO')
items=[core.Candidate('http','127.0.0.1',p) for p in ports]
async def curl_local(url,proxy=None,slow=False):
    if proxy not in items or url not in (core.TRACE,core.TARGET):raise ValueError('Unexpected network request')
    total=45 if slow else 12
    args=['/usr/bin/curl','--disable','--silent','--show-error','--connect-timeout',str(30 if slow else 7),
          '--max-time',str(total),'--cacert',str(scratch/'tls.crt'),'--proto','=https','--noproxy','','--proxy',proxy.url,
          '--write-out','\n%{http_code}',url]
    code,text=await core.process(args,total+2);body,_,status=text.rpartition('\n');return code,status,body
core.curl=curl_local
class LocalPool(ReservePool):
    def conflicts(self,a,b):
        return (a['host'],a['port'])==(b['host'],b['port']) or a['exitIp']==b['exitIp']
    def candidate_conflicts(self,a,b):return a.port==b['port']
class LocalSession(core.Session):
    def __init__(self,requested,output):
        if tuple(requested)!=countries:raise ValueError('Unexpected selection')
        async def feed(cc):return [items[countries.index(cc)]],[]
        super().__init__(requested,output,discoverer=feed,pool_factory=LocalPool)
    def eligible(self,candidate):return self.excluded.get(candidate.key,0)<=time.monotonic() and self.history.eligible(candidate)
    def exclude(self,candidate,seconds=180):self.excluded[candidate.key]=max(self.excluded.get(candidate.key,0),time.monotonic()+seconds)
host.Session=LocalSession
asyncio.run(host.main())
