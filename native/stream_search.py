"""Session-local, bounded streaming admission; a feed label never proves exit geography."""
import asyncio
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from itertools import islice
from random import SystemRandom
from uuid import uuid4

from check_budget import await_cleanup


@dataclass
class _Record:
    item: object
    # One queue reference per country. Mirrors charge the same provider group.
    owners: dict = field(default_factory=dict)
    # One origin observation per group; no response bodies or visited URLs.
    sources: dict = field(default_factory=dict)

    def observe(self, cc, batch):
        self.owners.setdefault(cc, batch.group)
        self.sources[batch.group] = (cc, batch.fetched_at, getattr(batch, 'updated_at', None))


class StreamSearch:
    """Keep cursors and bounded pending work across non-overlapping rounds of one Session."""

    def __init__(self, countries, groups, producer, *, shuffle=None, cap=120,
                 discovery_budget=45, history=None, quality=None):
        from core import country_codes, selection_argument
        selected = country_codes(countries)
        self.selection = selection_argument(selected)
        self.cap = max(1, min(cap, 120))
        self.discovery_budget = discovery_budget
        self.producer = producer
        self.history = history
        self.quality = quality
        self.countries = list(selected)
        self.groups = list(dict.fromkeys(groups))
        if not self.groups or len(self.groups) > 32:
            raise ValueError('expected 1..32 known provider groups')
        shuffle = SystemRandom().shuffle if shuffle is None else shuffle
        shuffle(self.countries)
        shuffle(self.groups)
        self.generation = uuid4().hex
        self.round_number = 0
        self.credit_cursor = self.discovery_cursor = self.admission_cursor = 0
        self.group_credit_cursor = dict.fromkeys(selected, 0)
        self.group_cursor = dict.fromkeys(selected, 0)
        self.pending = {cc: {g: OrderedDict() for g in self.groups} for cc in selected}
        self.records = {}
        # Bounded alongside pending; reoffers never change an accepted FIFO place.
        self.exploration = {cc: OrderedDict() for cc in selected}
        self.exploration_clock = 0
        self.since_exploration = dict.fromkeys(selected, 0)
        self.last_stats = {}
        self.last_observations = []
        self._running = False

    def clear_pending(self):
        """Final Session cleanup only; a stopped pool may still promote/reuse work."""
        if self._running:
            raise RuntimeError('cancel and drain the streaming round first')
        self.records.clear()
        for queue in self.exploration.values():
            queue.clear()
        for queues in self.pending.values():
            for queue in queues.values():
                queue.clear()

    def _forget(self, key, cc):
        rec = self.records[key]
        self.pending[cc][rec.owners.pop(cc)].pop(key)
        self.exploration[cc].pop(key, None)
        if not rec.owners:
            del self.records[key]

    def _store(self, cc, group, item):
        """Make room for a late group, never evict a retained queue's head.

        On overflow only the *tail* of a disproportionately large sibling is
        displaced. If that's impossible, apply backpressure to the new record.
        This lets a lone productive group use the whole country capacity.
        """
        queues = self.pending[cc]
        key = item.key
        record = self.records.get(key)
        if record is not None and cc in record.owners:
            return record
        if sum(map(len, queues.values())) >= 120:
            largest = max(queues, key=lambda g: len(queues[g]))
            if len(queues[largest]) <= len(queues[group]) + 1:
                return None
            self._forget(next(reversed(queues[largest])), cc)
        record = self.records.setdefault(key, _Record(item))
        record.owners[cc] = group
        queues[group][key] = None
        self.exploration[cc][key] = self.exploration_clock
        self.exploration_clock += 1
        return record

    def _admit(self, key):
        rec = self.records.pop(key)
        for owner, owner_group in rec.owners.items():
            self.pending[owner][owner_group].pop(key)
            self.exploration[owner].pop(key, None)
        return rec

    async def run_round(self, checker, eligible=lambda _: True, on_progress=lambda *_: None,
                        *, on_result=None, slow_only=False, concurrency=10, on_terminal=None, on_quarantined=None):
        """Return (winning proxy or None, warnings). Stop on the first accepted result.

        on_result(proxy) may accept a verified reserve yet return False to keep
        filling the pool. Discovery has a deadline. Once it ends, already ready
        candidates still receive their credits and checks have their own timeouts.
        With on_terminal, checker returns inspect_proxy-shaped reports internally;
        this method still returns only a proxy/None. The synchronous callback
        receives (item, observation, report) once after all owned cleanup.
        """
        if self._running:
            raise RuntimeError('overlapping streaming rounds')
        self._running = True
        self.round_number += 1
        try:
            return await _Round(self, checker, eligible, on_progress, on_result,
                                slow_only, max(1, min(concurrency, 10)), on_terminal, on_quarantined).run()
        finally:
            self._running = False


class _Round:
    def __init__(self, search, checker, eligible, on_progress, on_result, slow_only, slots, on_terminal, on_quarantined):
        self.s = search
        self.checker, self.eligible, self.on_progress = checker, eligible, on_progress
        self.on_result = on_result
        self.on_terminal = on_terminal
        self.on_quarantined = on_quarantined
        self.reports = {}
        self.hints = {}
        self.slow_only, self.slots = slow_only, slots
        self.event = asyncio.Event()
        self.jobs, self.checks = [], {}
        self.finished = deque()
        self.retry = deque()
        self.admitted = {}
        self.accepting = True
        self.completed = set()
        self.warnings = []
        self.started_countries = 0
        self.country_done = set()
        self.groups_done = {cc: set() for cc in search.countries}
        self.credits = {cc: dict.fromkeys(search.groups, 0) for cc in search.countries}
        self.local_shared = dict.fromkeys(search.countries, 0)
        self.exploration_credits = dict.fromkeys(search.countries, 0)
        self.country_allocated = dict.fromkeys(search.countries, 0)
        self.shared = 0
        # The country and group ticket rings advance by actual ticket count.
        for _ in range(search.cap):
            cc = search.countries[search.credit_cursor]
            search.credit_cursor = (search.credit_cursor + 1) % len(search.countries)
            self._grant(cc)
        self.expired = False
        self.results = {}
        self.counts = {'admissions': 0, 'checks': 0, 'fast': 0, 'slow': 0,
                       'peak_checks': 0, 'country_starts': 0, 'dropped': 0}
        self.phase_done = {False: 0, True: 0}

    def _grant(self, cc):
        s = self.s
        self.country_allocated[cc] += 1
        # Reserve exploration before provider allocation: never confiscate an
        # already-issued ticket from a slow provider. Normal provider tickets
        # retain their continuing uniform ring. History never scores providers.
        if s.history is not None and (
                s.since_exploration[cc] + self.country_allocated[cc]) % 5 == 0:
            self.exploration_credits[cc] += 1
            return
        idx = s.group_credit_cursor[cc]
        self.credits[cc][s.groups[idx]] += 1
        s.group_credit_cursor[cc] = (idx + 1) % len(s.groups)

    def _warn(self, cc, message):
        if len(self.warnings) < 12:
            self.warnings.append(f'{cc}: {str(message)[:160]}')

    def _offer(self, cc, batch):
        if batch.group not in self.credits[cc]:
            raise ValueError('unexpected provider group')
        if batch.error:
            self._warn(cc, batch.error)
        for item in islice(batch.candidates, 120):
            if self.s.quality is not None:
                self.s.quality.observe(item, cc, batch.group)
            if self.s.history is not None:
                self.s.history.seen(item, groups=(batch.group,))
            previous = self.admitted.get(item.key)
            if previous is not None:
                previous.observe(cc, batch)
            rec = self.s._store(cc, batch.group, item)
            if rec is not None:
                if previous is not None:
                    # A late offer cannot be served retroactively. Keep it in
                    # the SAME bounded country queue. This round skips its key.
                    rec.sources.update(previous.sources)
                rec.observe(cc, batch)
            else:
                self.counts['dropped'] += 1
        if batch.complete:
            self.groups_done[cc].add(batch.group)
        self.event.set()

    async def _produce(self):
        s = self.s
        while self.accepting and self.started_countries < len(s.countries) and self.loop.time() < self.deadline:
            cc = s.countries[s.discovery_cursor]
            s.discovery_cursor = (s.discovery_cursor + 1) % len(s.countries)
            self.started_countries += 1
            self.counts['country_starts'] += 1
            iterator = None
            try:
                iterator = s.producer(cc)
                async for batch in iterator:
                    if not self.accepting or self.loop.time() >= self.deadline:
                        break
                    self._offer(cc, batch)
                    # Let the dispatcher use a ready feed even if the next feed
                    # is also cached and its async iterator does not suspend.
                    await asyncio.sleep(0)
            except Exception:
                self._warn(cc, 'Источники временно недоступны')
            finally:
                try:
                    close = getattr(iterator, 'aclose', None)
                    if close is not None:
                        await await_cleanup(asyncio.ensure_future(close()))
                finally:
                    self.country_done.add(cc)
                    self.groups_done[cc].update(s.groups)
                    self.event.set()

    def _expire(self):
        self.expired = True
        for job in self.jobs:
            if not job.done() and not job.cancelling():
                job.cancel()
        if len(self.country_done) < len(self.s.countries):
            self._warn('discovery', 'Истёк срок ожидания источников')
        self.country_done.update(self.s.countries)
        for cc in self.s.countries:
            self.groups_done[cc].update(self.s.groups)
        self.event.set()

    def _hint(self, key, name):
        hints = self.hints.setdefault(key, {})
        if name not in hints:
            item = self.s.records[key].item
            if name == 'admissible':
                value = self.eligible(item)
            else:
                value = getattr(self.s.history, name)(item)
                if name == 'eligible' and not value and self.on_quarantined:
                    self.on_quarantined(item)
            hints[name] = value
        return hints[name]

    def _ready_keys(self, queue):
        return (key for key in queue if key not in self.admitted and
                (self.s.history is None or self._hint(key, 'eligible')))

    def _head(self, queue):
        # A quarantined endpoint keeps its bounded FIFO place. Expiry makes it
        # ready without requiring a source-cache hit or another source offer.
        keys = self._ready_keys(queue)
        if self.s.history is None:
            return next(keys, None)
        return min(keys, key=lambda key: self._hint(key, 'rank'), default=None)

    def _exploration_group(self, cc):
        s = self.s
        if s.history is None:
            return None
        if s.since_exploration[cc] < 4:
            if not self.exploration_credits[cc] or any(
                    (self.credits[cc][group] or self.local_shared[cc]) and
                    next(self._ready_keys(queue), None) is not None
                    for group, queue in s.pending[cc].items()):
                return None
        # Exploration can reorder only spendable tickets. A still-producing
        # provider retains its protected credits, as does every other country.
        for key in s.exploration[cc]:
            rec = s.records[key]
            group = rec.owners[cc]
            if (key not in self.admitted and (self.credits[cc][group] or self.local_shared[cc] or self.exploration_credits[cc])
                    and self._hint(key, 'eligible') and self._hint(key, 'admissible')
                    and self._hint(key, 'is_exploration')):
                return group, key
        return None

    def _has_exploration(self, cc):
        return self.s.history is not None and any(
            key not in self.admitted and self._hint(key, 'eligible')
            and self._hint(key, 'admissible')
            and self._hint(key, 'is_exploration')
            for key in self.s.exploration[cc])

    def _has_ready(self, queues):
        return any(next(self._ready_keys(q), None) is not None for q in queues.values())

    def _release(self, cc):
        """Unfinished producers, including not-yet-started countries, keep credits."""
        queues = self.s.pending[cc]
        credits = self.credits[cc]
        for g in self.groups_done[cc]:
            if credits[g] and next(self._ready_keys(queues[g]), None) is None:
                self.local_shared[cc] += credits[g]
                credits[g] = 0
        if not self._has_exploration(cc) and self.exploration_credits[cc]:
            # A warm ready feed must still stream while siblings hang. Spend
            # one unneeded reserve only after its normal spendable work runs
            # out; keep later exploration places reserved until actually needed.
            if not any((credits[g] or self.local_shared[cc]) and
                       next(self._ready_keys(q), None) is not None
                       for g, q in queues.items()):
                self.local_shared[cc] += 1
                self.exploration_credits[cc] -= 1
        if cc in self.country_done and not self._has_ready(queues):
            self.shared += self.local_shared[cc] + self.exploration_credits[cc]
            self.local_shared[cc] = self.exploration_credits[cc] = 0

    def _next(self):
        s = self.s
        # Reclaim available tickets before distributing any of them. This is
        # separate from ready-country order and independent of ISO/user order.
        for cc in self.country_done:
            self._release(cc)
        while True:
            granted = False
            for offset in range(len(s.countries)):
                ci = (s.admission_cursor + offset) % len(s.countries)
                cc = s.countries[ci]
                queues = s.pending[cc]
                self._release(cc)
                if not self._has_ready(queues):
                    continue
                exploration = self._exploration_group(cc)
                group_order = [(s.group_cursor[cc] + off) % len(s.groups)
                               for off in range(len(s.groups))]
                if exploration is not None:
                    ei = s.groups.index(exploration[0])
                    group_order.remove(ei)
                    group_order.insert(0, ei)
                for gi in group_order:
                    g = s.groups[gi]
                    key = exploration[1] if exploration is not None and g == exploration[0] else self._head(queues[g])
                    while key is not None:
                        if (self._hint(key, 'admissible') if s.history is not None
                                else self.eligible(s.records[key].item)):
                            break
                        # Eligibility is session-wide, not a guess from a feed's country.
                        granted = True  # released group quota can serve an earlier queue
                        rec = s.records[key]
                        for owner in tuple(rec.owners):
                            s._forget(key, owner)
                        self._release(cc)
                        key = self._head(queues[g])
                    reserved = (exploration is not None and key == exploration[1]
                                and self.exploration_credits[cc])
                    if key is None or not (reserved or self.credits[cc][g] or self.local_shared[cc]):
                        continue
                    if reserved:
                        self.exploration_credits[cc] -= 1
                    elif self.credits[cc][g]:
                        self.credits[cc][g] -= 1
                    else:
                        self.local_shared[cc] -= 1
                    s.group_cursor[cc] = (gi + 1) % len(s.groups)
                    s.admission_cursor = (ci + 1) % len(s.countries)
                    rec = s._admit(key)
                    if exploration is not None and key == exploration[1]:
                        s.since_exploration[cc] = 0
                    else:
                        s.since_exploration[cc] += 1
                    self.admitted[rec.item.key] = rec
                    self.counts['admissions'] += 1
                    self.results[rec.item.key] = {
                        'generation': s.generation, 'endpoint': rec.item.key,
                        'attempt': f'{s.round_number}:{len(self.admitted)}',
                        'requestedCountry': cc, 'stage': 'admitted',
                        'nativeQualified': False, 'browserConfirmed': None,
                    }
                    return rec
                if self.shared and self._has_ready(queues):
                    # Borrowed country tickets still enter the fair group ring.
                    self.shared -= 1
                    self._grant(cc)
                    granted = True
            if not granted:
                return None

    async def _probe(self, rec, slow):
        key = rec.item.key
        if not self.eligible(rec.item):
            self.completed.add(key)
            return {'ok': False, 'reason': 'neutral'} if self.on_terminal else None
        self.counts['checks'] += 1
        self.counts['slow' if slow else 'fast'] += 1
        self.results[key]['stage'] = 'slow' if slow else 'fast'
        try:
            return await self.checker(rec.item, self.s.selection, slow)
        except Exception:
            return {'ok': False, 'reason': 'internal'} if self.on_terminal else None

    def _check_done(self, key, slow, task):
        self.finished.append((key, slow, task))
        self.event.set()

    def _dispatch(self):
        # No await occurs in this dispatcher turn. Reuse bounded hint lookups
        # only until the next event-loop yield; the physical probe independently
        # rechecks eligibility after acquiring its task slot.
        self.hints.clear()
        while len(self.checks) < self.slots:
            rec = self._next() if len(self.admitted) < self.s.cap else None
            slow = self.slow_only
            if rec is None:
                if not self.retry:
                    return
                rec, slow = self.retry.popleft(), True
            key = rec.item.key
            self.on_progress('slow' if slow else 'checking', self.phase_done[slow], len(self.admitted))
            task = asyncio.create_task(self._probe(rec, slow))
            self.checks[key] = task
            task.add_done_callback(lambda t, k=key, mode=slow: self._check_done(k, mode, t))
            self.counts['peak_checks'] = max(len(self.checks), self.counts['peak_checks'])

    def _finish(self, accepting=True):
        while self.finished:
            key, slow, task = self.finished.popleft()
            self.checks.pop(key)
            if task.cancelled() or task.cancelling():
                # A separately cancelled physical attempt is neither a failure
                # nor a vote to cancel every other producer in this Session.
                continue
            returned = task.result()
            if self.on_terminal:
                report = returned if isinstance(returned, dict) and isinstance(returned.get('ok'), bool) else {
                    'ok': False, 'reason': 'internal'}
                self.reports[key] = report
                result = report.get('proxy') if report['ok'] else None
            else:
                result = returned
            self.phase_done[slow] += 1
            self.on_progress('slow' if slow else 'checking', self.phase_done[slow], len(self.admitted))
            if result:
                self.completed.add(key)
                self.results[key].update(stage='native-qualified', nativeQualified=True,
                                         actualCountry=result.get('country'))
                if accepting and (self.on_result is None or self.on_result(result)):
                    return result
            elif slow or key in self.completed:
                self.completed.add(key)
                self.results[key]['stage'] = 'unavailable'
            elif accepting:
                # A slow retry may start in an otherwise free slot while a
                # source is hanging. The producer deadline never cancels it.
                self.retry.append(self.admitted[key])
        return None

    def _restore(self):
        # Adjudicate after producer and physical-check cleanup, including late
        # provenance and fully finished losers. An untried slow retry is neutral.
        self._finish(accepting=False)
        for key, rec in self.admitted.items():
            observation = self.results[key]
            if key not in self.completed:
                observation['stage'] = 'cancelled'
            observation['sources'] = [
                {'group': g, 'requestedCountry': c, 'fetchedAt': fetched, 'updatedAt': updated}
                for g, (c, fetched, updated) in rec.sources.items()]
            if self.on_terminal:
                report = (self.reports.get(key, {'ok': False, 'reason': 'internal'})
                          if key in self.completed else {'ok': False, 'reason': 'cancel'})
                self.on_terminal(rec.item, observation, report)
            # Unstarted retained queues precede interrupted probes. Quarantine
            # is also retained so clock-only recovery survives payload eviction.
            if key not in self.completed or (self.s.history is not None and
                                             not self.s.history.eligible(rec.item)):
                for cc, group in rec.owners.items():
                    saved = self.s._store(cc, group, rec.item)
                    if saved is not None:
                        saved.sources.update(rec.sources)
        self.s.last_stats = self.counts.copy()
        self.s.last_observations = list(self.results.values())

    async def run(self):
        self.loop = asyncio.get_running_loop()
        self.deadline = self.loop.time() + self.s.discovery_budget
        timer = self.loop.call_at(self.deadline, self._expire)
        self.jobs = [asyncio.create_task(self._produce())
                     for _ in range(min(3, len(self.s.countries)))]
        for job in self.jobs:
            job.add_done_callback(lambda _: self.event.set())
        try:
            while True:
                self.event.clear()
                winner = self._finish()
                if winner:
                    return winner, self.warnings
                self._dispatch()
                if not self.checks and (self.expired or all(job.done() for job in self.jobs)):
                    return None, self.warnings
                await self.event.wait()
        finally:
            self.accepting = False
            timer.cancel()
            owned = self.jobs + list(self.checks.values())
            for task in owned:
                if not task.done() and not task.cancelling():
                    task.cancel()
            try:
                await await_cleanup(asyncio.gather(*owned, return_exceptions=True))
            finally:
                self._restore()
