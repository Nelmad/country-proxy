"""Small session-local reserve; native verification never substitutes a Chrome probe."""
import asyncio
import time
from core import Candidate


def candidate(proxy):
    return Candidate(proxy['scheme'], proxy['host'], proxy['port'])


class ReservePool:
    LIMIT = 2

    def __init__(self, country, discoverer, checker, active, eligible, exclude, emit,
                 clock=time.monotonic, ttl=90, interval=30, budget=45):
        self.country, self.discoverer, self.checker = country, discoverer, checker
        self.active, self.eligible, self.exclude, self.emit = active, eligible, exclude, emit
        self.clock, self.ttl, self.interval, self.budget = clock, ttl, interval, budget
        self.entries = {}  # key -> (verified proxy, monotonic completion time)
        self.checking, self.cursor = False, 0

    def conflicts(self, left, right):
        # Different protocols/ports on one host or one egress are not independent reserves.
        return left['host'] == right['host'] or left['exitIp'] == right['exitIp']

    def candidate_conflicts(self, item, proxy):
        return item.host == proxy['host']

    def prune(self):
        now, active = self.clock(), self.active()
        self.entries = {key: (p, at) for key, (p, at) in self.entries.items()
                        if now - at < self.ttl and p['country'] == self.country
                        and self.eligible(candidate(p)) and not (active and self.conflicts(p, active))}

    def publish(self):
        self.prune()
        remaining = min((self.ttl - (self.clock() - at) for _, at in self.entries.values()), default=0)
        self.emit({'phase': 'pool', 'reserveCount': len(self.entries), 'reserveChecking': self.checking,
                   'reserveExpiresAt': int(time.time() * 1000 + remaining * 1000)})

    async def verify(self, item):
        try:
            result = await self.checker(item, self.country, True)
            if (result and result.get('country') == self.country and candidate(result) == item
                    and self.eligible(item)):
                return result
        except Exception:
            pass
        return None

    def accept(self, result):
        self.prune()
        active = self.active()
        existing = [p for p, _ in self.entries.values()]
        if (len(existing) >= self.LIMIT or not self.eligible(candidate(result))
                or any(self.conflicts(result, p) for p in existing + ([active] if active else []))):
            return False
        self.entries[candidate(result).key] = (result, self.clock())
        self.publish()
        return True

    async def refresh(self):
        self.prune()
        async def refresh_one(key, old):
            result = await self.verify(candidate(old))
            self.entries.pop(key, None)
            if result:
                self.accept(result)
            else:
                self.exclude(candidate(old), 60)
        await asyncio.gather(*(refresh_one(k, p) for k, (p, _) in list(self.entries.items())))
        self.publish()
        if len(self.entries) >= self.LIMIT:
            return
        candidates, _ = await self.discoverer(self.country)
        active = self.active()
        candidates = [c for c in dict.fromkeys(candidates) if self.eligible(c)
                      and c.key not in self.entries and not (active and self.candidate_conflicts(c, active))]
        if not candidates:
            return
        # Advance through large feeds across bounded rounds, instead of retrying only their head.
        offset = self.cursor % len(candidates)
        queue = asyncio.Queue()
        for c in candidates[offset:] + candidates[:offset]:
            queue.put_nowait(c)
        async def worker():
            while not queue.empty() and len(self.entries) < self.LIMIT:
                item = queue.get_nowait(); self.cursor += 1
                result = await self.verify(item)
                if result:
                    self.accept(result)
        tasks = [asyncio.create_task(worker()) for _ in range(min(3, len(candidates)))]
        try:
            async with asyncio.timeout(self.budget):
                await asyncio.gather(*tasks)
        except TimeoutError:
            pass
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def run(self):
        while True:
            self.checking = True; self.publish()
            try:
                await self.refresh()
            except Exception:
                # Reserve acquisition is optional; a source failure must not drop a healthy active proxy.
                pass
            finally:
                self.checking = False
            self.publish()
            await asyncio.sleep(self.interval)

    async def take(self):
        """Called only after stopping maintenance. Always recheck, even inside the freshness TTL."""
        self.prune()
        while self.entries:
            key = min(self.entries, key=lambda k: self.entries[k][0].get('latencyMs', 0))
            proxy, _ = self.entries.pop(key); self.publish()
            self.emit({'phase': 'reserve', 'proxy': None})
            result = await self.verify(candidate(proxy))
            if result and not (self.active() and self.conflicts(result, self.active())):
                return result
            self.exclude(candidate(proxy), 60)
        return None
