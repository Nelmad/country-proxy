"""Small session-local reserve; native verification never substitutes a Chrome probe."""
import asyncio
from collections import Counter, deque
import time
import math
from uuid import uuid4
from core import Candidate, country_codes, selection_argument
from check_budget import CheckBudget, await_cleanup


def candidate(proxy):
    return Candidate(proxy['scheme'], proxy['host'], proxy['port'])


class ReservePool:
    LIMIT = 2
    DIAGNOSTIC_KEY_LIMIT = 4096

    def __init__(self, country, discoverer, checker, active, eligible, exclude, emit,
                 clock=time.monotonic, ttl=90, interval=30, budget=45):
        self.countries = country_codes(country)
        self.country = selection_argument(self.countries)
        self.discoverer, self.checker = discoverer, checker
        # Session supplies its speculative lane after constructing compatible factories.
        self.refill_checker = checker
        self.report_checker = None  # Optional exact reports for maintenance/promotion.
        self.stream_round = None  # Session supplies its shared country scheduler.
        self.active, self.eligible, self.exclude, self.emit = active, eligible, exclude, emit
        self.clock, self.ttl, self.interval, self.budget = clock, ttl, interval, budget
        self.entries = {}  # key -> (verified proxy, monotonic completion time)
        self.checking = False
        self.pending = []  # unfinished candidate keys, in fair retry order
        self._tokens = {}
        self._reserve_ids = {}
        self._lease_checks = {}
        self.removals = deque(maxlen=20)
        self._removal_id = 0
        self._generation = 0
        self._refresh_tasks = {}
        self._probes = {}
        self._changed = asyncio.Event()
        self._refill_needed = asyncio.Event()
        self._refill_busy = False
        self._running = False
        self._take_lock = asyncio.Lock()
        # Session pauses discovery until Chrome confirms a native offer. Lease
        # maintenance remains independent of this gate.
        self.refill_allowed = asyncio.Event()
        self.refill_allowed.set()

        self.counts = Counter()
        self._qualified_keys = set()
        self.diagnostics_limited = False

    def diagnostic_snapshot(self, has_active):
        if not has_active:
            state = 'noActive'
        elif not self.refill_allowed.is_set():
            state = 'awaitingBrowser'
        elif len(self.entries) >= self.LIMIT:
            state = 'full'
        else:
            state = 'refilling' if self._refill_busy else 'waiting'
        return {'state': state, 'counts': dict(self.counts), 'limited': self.diagnostics_limited,
                'removals': [{**event, **({'check': dict(event['check'])} if 'check' in event else {})}
                             for event in self.removals],
                'removalsLimited': self._removal_id > len(self.removals)}

    def _count_once(self, keys, key, reason):
        if key in keys:
            return
        if len(keys) >= self.DIAGNOSTIC_KEY_LIMIT:
            self.diagnostics_limited = True
            return
        keys.add(key)
        self.counts[reason] += 1

    def conflicts(self, left, right):
        # Different protocols/ports on one host or one egress are not independent reserves.
        return left['host'] == right['host'] or left['exitIp'] == right['exitIp']

    def candidate_conflicts(self, item, proxy):
        return item.host == proxy['host']

    @staticmethod
    def _check_detail(report):
        if not isinstance(report, dict) or report.get('ok') is not False:
            return None
        reasons = {'timeout', 'tls', 'connect', 'http', 'country', 'invalid_trace',
                   'transport', 'internal', 'unavailable', 'unknown'}
        reason = report.get('reason')
        detail = {'reason': reason if isinstance(reason, str) and reason in reasons else 'unknown'}
        if report.get('endpoint') in ('trace', 'target'):
            detail['endpoint'] = report['endpoint']
        code = report.get('code')
        if type(code) is int and 0 <= code <= 255:
            detail['code'] = code
        status = report.get('status')
        if (type(status) is int and 100 <= status <= 599 or
                isinstance(status, str) and len(status) == 3 and status.isascii() and status.isdigit()
                and 100 <= int(status) <= 599):
            detail['status'] = int(status)
        latency = report.get('latencyMs')
        if type(latency) in (int, float) and 0 <= latency <= 86400000 and math.isfinite(latency):
            detail['latencyMs'] = round(latency)
        return detail

    def _remember_lease_check(self, operation, result, report):
        # Record before yielding: history may already quarantine the endpoint.
        # Pruning must retain the cause of THIS lease's check, never a global last error.
        if asyncio.current_task().cancelling():
            return
        detail = self._check_detail(report)
        if detail:
            reason = 'unknown' if detail['reason'] == 'unknown' else 'checkFailed'
        elif result is None:
            reason = 'unknown'  # Legacy checker does not provide attribution.
        elif isinstance(result, dict) and result.get('country') not in self.countries:
            reason = 'outsideGroup'
        else:
            reason = None
        for reserve_id, (key, entry, token, generation, stage) in operation['leases'].items():
            if (generation == self._generation and self._reserve_ids.get(key) == reserve_id
                    and self._tokens.get(key) is token and self.entries.get(key) is entry):
                if reason is None:
                    # A previous owner may have been cancelled after its check
                    # completed. New success replaces that lease's old evidence.
                    self._lease_checks.pop(reserve_id, None)
                else:
                    self._lease_checks[reserve_id] = (stage, reason, detail)

    def _record_removal(self, entry, reserve_id, stage, reason, check=None):
        self._removal_id += 1
        event = {'id': self._removal_id, 'reserveId': reserve_id,
                 'atMs': int(time.time() * 1000),
                 'ageMs': min(86400000, max(0, round((self.clock() - entry[1]) * 1000))),
                 'stage': stage, 'reason': reason}
        if check is not None:
            event['check'] = dict(check)
        self.removals.append(event)

    def _remove(self, key, reason=None, *, stage='prune', wake_refill=True):
        self._tokens.pop(key, None)
        reserve_id = self._reserve_ids.pop(key, None)
        observed = self._lease_checks.pop(reserve_id, None)
        value = self.entries.pop(key, None)
        if value is not None:
            if reason:
                # Keep the existing aggregate counters compatible.
                self.counts['expired' if reason == 'expired' else 'removed'] += 1
                check = None
                if reason in ('quarantined', 'checkFailed', 'unknown', 'removed') and observed:
                    stage, reason, check = observed
                elif reason == 'removed':
                    reason = 'unknown'
                self._record_removal(value, reserve_id or uuid4().hex, stage, reason, check)
            self._changed.set()
            if wake_refill:
                self._refill_needed.set()
        return value

    def prune(self):
        now, active = self.clock(), self.active()
        for key, (proxy, at) in list(self.entries.items()):
            reason = ('expired' if now - at >= self.ttl else
                      'outsideGroup' if proxy['country'] not in self.countries else
                      'quarantined' if not self.eligible(candidate(proxy)) else
                      ('sameHost' if proxy['host'] == active['host'] else 'sameExit')
                      if active and self.conflicts(proxy, active) else None)
            if reason:
                self._remove(key, reason)
        # Also reconcile legacy callers that clear entries directly between runs.
        for key in self._tokens.keys() - self.entries.keys():
            self._tokens.pop(key, None)
            self._lease_checks.pop(self._reserve_ids.pop(key, None), None)

    def publish(self):
        self.prune()
        self.publish_snapshot()

    def publish_snapshot(self):
        remaining = min((self.ttl - (self.clock() - at) for _, at in self.entries.values()), default=0)
        self.emit({'phase': 'pool', 'reserveCount': len(self.entries), 'reserveChecking': self.checking,
                   'reserveExpiresAt': int(time.time() * 1000 + remaining * 1000)})

    async def verify(self, item, *, speculative=False, on_result=None, lease=None):
        """Coalesce pool-owned checks and drain cancelled work before releasing ownership.

        Shielding makes caller cancellation final even if an injected checker catches
        cancellation and returns a late result. Such a result never reaches accept().
        """
        operation = self._probes.get(item.key)
        while operation is not None and operation['task'].cancelling():
            # A new owner waits for abandoned work to finish; it never inherits
            # cancellation or interrupts the old checker's asynchronous cleanup.
            await operation['released'].wait()
            operation = self._probes.get(item.key)
        if operation is None:
            checker = self.refill_checker if speculative else self.checker
            operation = {'owners': 0, 'released': asyncio.Event(), 'leases': {}}
            async def check():
                try:
                    if not speculative and self.report_checker is not None:
                        report = await self.report_checker(item, self.country, True)
                        result = report.get('proxy') if isinstance(report, dict) else None
                    else:
                        result = await checker(item, self.country, True)
                        report = None
                    self._remember_lease_check(operation, result, report)
                    return result
                except Exception:
                    self._remember_lease_check(operation, None, None)
                    raise
                finally:
                    operation['at'] = self.clock()
            operation['task'] = asyncio.create_task(check())
            self._probes[item.key] = operation
        if lease is not None:
            key, entry, token, generation, stage = lease
            reserve_id = self._reserve_ids.get(key)
            if reserve_id is not None:
                operation['leases'][reserve_id] = lease
        operation['owners'] += 1
        observed = False
        def observe(result):
            nonlocal observed
            try:
                valid = (isinstance(result, dict) and result.get('country') in self.countries
                         and candidate(result) == item and self.eligible(item)
                         and isinstance(result.get('exitIp'), str) and bool(result['exitIp']))
            except (KeyError, TypeError):
                valid = False
            result = result if valid else None
            if on_result is not None and not observed:
                observed = True
                on_result(result, operation['at'])
            return result
        try:
            try:
                result = await asyncio.shield(operation['task'])
                return observe(result)
            except Exception:
                observe(None)
            return None
        finally:
            task = operation['task']
            # The checker can finish before this shield owner is scheduled. A
            # winner canceling the owner must not erase that genuine runner-up.
            # Results returned after checker cancellation remain inconclusive.
            if (on_result is not None and not observed and task.done()
                    and not task.cancelled() and not task.cancelling()):
                try:
                    result = task.result()
                except Exception:
                    result = None
                observe(result)
            operation['owners'] -= 1
            if operation['owners'] == 0:
                task = operation['task']
                if not task.done() and not task.cancelling():
                    task.cancel()
                async def finish():
                    await asyncio.gather(task, return_exceptions=True)
                    if self._probes.get(item.key) is operation:
                        self._probes.pop(item.key, None)
                    operation['released'].set()
                await await_cleanup(asyncio.create_task(finish()))

    def _admission_reason(self, result, at):
        if self.clock() - at >= self.ttl:
            return 'stale'
        if result.get('country') not in self.countries:
            return 'outsideGroup'
        if len(self.entries) >= self.LIMIT:
            return 'full'
        if not self.eligible(candidate(result)):
            return 'quarantined'
        others = [proxy for proxy, _ in self.entries.values()]
        active = self.active()
        if active:
            others.append(active)
        for other in others:
            if self.conflicts(result, other):
                return 'sameHost' if result['host'] == other['host'] else 'sameExit'
        return None

    def accept(self, result, *, at=None, refill=False):
        self.prune()
        at = self.clock() if at is None else at
        reason = self._admission_reason(result, at)
        if refill:
            self.counts[reason or 'added'] += 1
        if reason:
            return False
        key = candidate(result).key
        self.entries[key] = (result, at)
        self._tokens[key] = object()
        self._reserve_ids[key] = uuid4().hex
        self._changed.set()
        self.publish()
        return True

    def consume_for_offer(self, result):
        """Consume an observed winner, including a cancelled take's real success."""
        selected = candidate(result).key
        for key, (proxy, _) in list(self.entries.items()):
            if key == selected:
                self._remove(key)  # Normal use is not a reserve-loss event.
            elif self.conflicts(result, proxy):
                self._remove(key, 'sameHost' if result['host'] == proxy['host'] else 'sameExit',
                             stage='promotion')
        self.publish()

    def recovery_evidence_valid(self, result, at, lease):
        """A completed check may outlive its owner, never its lease generation."""
        key, entry, token, generation = lease
        if generation != self._generation or at - entry[1] >= self.ttl:
            return False
        current = self.entries.get(key)
        if current is entry:
            return self._tokens.get(key) is token
        if current is None:
            # A normally completed take consumes its winner before returning.
            return True
        # take itself may already have retained a fully checked runner-up. Do
        # not overwrite a replacement lease with older/different evidence.
        return current[0] == result and current[1] >= at

    def finish_recovery(self, winner, successes):
        """Reconcile completed leases atomically, before ordinary TTL pruning.

        A successful recheck at t=85 of a lease from t=0 remains fresh at t=95.
        Draining a losing branch must not first announce that lease as expired.
        Only exact generation/token/entry owners are detached; all other old
        leases still receive normal pruning and its real removal diagnostics.
        """
        detached = {}
        usable = []
        active = self.active()
        for result, at, lease in successes:
            if (self.clock() - at >= self.ttl or result.get('country') not in self.countries
                    or not self.eligible(candidate(result))
                    or active and self.conflicts(result, active)
                    or lease is not None and not self.recovery_evidence_valid(result, at, lease)):
                continue
            usable.append((result, at))
            if lease is not None:
                key, entry, token, generation = lease
                if (self.entries.get(key) is entry and self._tokens.get(key) is token
                        and self._generation == generation):
                    detached[key] = (entry, self._reserve_ids.get(key))
                    self._remove(key, wake_refill=False)
        self.prune()
        if winner is not None:
            self.consume_for_offer(winner)
        for result, at in usable:
            key = candidate(result).key
            previous = detached.get(key)
            if winner is not None and self.conflicts(winner, result):
                if previous and candidate(winner).key != key:
                    reason = 'sameHost' if winner['host'] == result['host'] else 'sameExit'
                    self.counts['removed'] += 1
                    self._record_removal(*previous, 'promotion', reason)
                    self._refill_needed.set()
                continue
            if key in self.entries:
                continue  # A newer lease, possibly retained by take(), owns it.
            reason = self._admission_reason(result, at)
            if self.accept(result, at=at):
                continue
            if previous:
                self.counts['removed'] += 1
                self._record_removal(*previous, 'promotion', reason or 'unknown')
                self._refill_needed.set()
        self.publish()

    async def _refresh_one(self, key, entry, token, generation):
        proxy, _ = entry
        result = await self.verify(candidate(proxy), lease=(key, entry, token, generation, 'maintenance'))
        self.prune()
        if (generation != self._generation or self._tokens.get(key) is not token
                or self.entries.get(key) is not entry):
            return
        reserve_id = self._reserve_ids[key]
        observation = self._lease_checks.get(reserve_id)
        self._remove(key, wake_refill=False)
        reason = self._admission_reason(result, self.clock()) if result else 'unknown'
        if not result or not self.accept(result):
            self._refill_needed.set()
            self.counts['removed'] += 1
            stage, reason, detail = observation or ('maintenance', reason or 'unknown', None)
            self._record_removal(entry, reserve_id, stage, reason, detail)
            if not result:
                self.exclude(candidate(proxy), 60)
        self.publish()

    def _start_refresh(self, key):
        existing = self._refresh_tasks.get(key)
        if existing is not None and not existing.done():
            return existing
        entry = self.entries.get(key)
        if entry is None:
            return None
        token = self._tokens.setdefault(key, object())
        task = asyncio.create_task(self._refresh_one(key, entry, token, self._generation))
        self._refresh_tasks[key] = task
        def finished(done):
            if self._refresh_tasks.get(key) is done:
                self._refresh_tasks.pop(key, None)
            # Retrieve exceptions even when maintenance did not explicitly await this task.
            if not done.cancelled():
                done.exception()
            self._changed.set()
        task.add_done_callback(finished)
        return task

    async def _refill(self):
        generation = self._generation
        self.prune()
        if len(self.entries) >= self.LIMIT:
            return
        self.counts['rounds'] += 1
        self.publish_snapshot()
        filtered = set()  # A scheduler can inspect the same endpoint many times this round.
        pending_results = set()
        checks_started = False

        def completed_round(warnings):
            if warnings:
                self.counts['roundsWithSourceWarnings'] += 1
            if not checks_started:
                self.counts['roundsWithoutChecks'] += 1

        def filtered_out(item, reason):
            self._count_once(filtered, item.key, reason)
            return False

        def allowed(item):
            if generation != self._generation:
                return False
            if not self.eligible(item):
                return filtered_out(item, 'quarantined')
            if item.key in self.entries or item.key in self._refresh_tasks:
                return filtered_out(item, 'alreadyReserved')
            active = self.active()
            if active and self.candidate_conflicts(item, active):
                return filtered_out(item, 'sameHost')
            return True

        async def probe(item):
            nonlocal checks_started
            checks_started = True
            self.counts['checked'] += 1
            try:
                result = await self.verify(item, speculative=True)
            except asyncio.CancelledError:
                self.counts['cancelled'] += 1
                raise
            if result:
                self.counts['qualified'] += 1
                self._count_once(self._qualified_keys, item.key, 'qualifiedUnique')
                pending_results.add(item.key)
            else:
                self.counts['checkFailed'] += 1
            return result

        def found(proxy):
            if generation != self._generation:
                return True
            pending_results.discard(candidate(proxy).key)
            self.accept(proxy, refill=True)
            return len(self.entries) >= self.LIMIT

        if self.stream_round is not None:
            async def check(item, _country, _slow):
                return await probe(item) if allowed(item) else None
            try:
                _, warnings = await self.stream_round(
                    check, allowed, on_result=found, slow_only=True,
                    concurrency=CheckBudget.LIMITS['speculative'],
                    on_quarantined=lambda item: filtered_out(item, 'quarantined'))
                completed_round(warnings)
            finally:
                # Already finished results can outlive a filled pool or a cancelled round.
                self.counts['unused'] += len(pending_results)
            return
        # One-cycle adapter for callers supplying only a completed candidate list.
        try:
            candidates, warnings = await self.discoverer(self.country)
        except Exception:
            completed_round(True)  # The list source itself failed before returning a result.
            raise
        if generation != self._generation:
            return
        candidates = [c for c in dict.fromkeys(candidates) if allowed(c)]
        if not candidates:
            completed_round(warnings)
            return
        # A round deadline can interrupt a healthy slow candidate started late.
        # Keep unfinished work ahead of completed failures, including across feed changes.
        available = {c.key: c for c in candidates}
        order = list(dict.fromkeys(self.pending + list(available)))
        queue = asyncio.Queue()
        for key in order:
            if key in available:
                queue.put_nowait(available[key])
        in_flight = {}
        async def worker():
            while not queue.empty() and len(self.entries) < self.LIMIT and generation == self._generation:
                item = queue.get_nowait()
                in_flight[item.key] = item
                result = await probe(item)
                in_flight.pop(item.key)
                if result:
                    found(result)
        tasks = [asyncio.create_task(worker()) for _ in range(min(3, len(candidates)))]
        try:
            async with asyncio.timeout(self.budget):
                await asyncio.gather(*tasks)
        except TimeoutError:
            pass
        finally:
            for task in tasks:
                if not task.cancelling():
                    task.cancel()
            async def finish():
                await asyncio.gather(*tasks, return_exceptions=True)
                # Unstarted candidates go first: three permanently slow checks must
                # not monopolize every round. Interrupted work gets another window.
                self.pending = []
                while not queue.empty():
                    self.pending.append(queue.get_nowait().key)
                self.pending.extend(in_flight)
            await await_cleanup(asyncio.create_task(finish()))
            self.counts['unused'] += len(pending_results)
        completed_round(warnings)

    async def refresh(self):
        """Explicit one-cycle compatibility API; production run() schedules due checks."""
        self.prune()
        tasks = [self._start_refresh(key) for key in list(self.entries)]
        await asyncio.gather(*(task for task in tasks if task is not None))
        self.publish()
        await self._refill()

    async def _maintain(self):
        while True:
            # Clear before reading entries. A completion while awaiting the event cannot
            # be lost and accepting a new reserve immediately recalculates its deadline.
            self._changed.clear()
            self.prune()
            now = self.clock()
            for key, (_, at) in list(self.entries.items()):
                if now >= at + self.interval:
                    self._start_refresh(key)
            self.checking = bool(self._refresh_tasks) or self._refill_busy
            self.publish()
            deadlines = [at + self.ttl for _, at in self.entries.values()]
            deadlines += [at + self.interval for key, (_, at) in self.entries.items()
                          if key not in self._refresh_tasks]
            if not deadlines:
                await self._changed.wait()
                continue
            try:
                await asyncio.wait_for(self._changed.wait(), max(0, min(deadlines) - self.clock()))
            except TimeoutError:
                pass

    async def _refill_loop(self):
        while True:
            await self.refill_allowed.wait()
            # Only vacancies wake discovery; successful maintenance also changes
            # _changed and must not trigger a busy retry of empty source rounds.
            self._refill_needed.clear()
            self._refill_busy = True
            self.checking = True
            try:
                await self._refill()
            except Exception:
                # Source acquisition is optional and cannot suspend reserve maintenance.
                pass
            finally:
                self._refill_busy = False
                self._changed.set()
            self.checking = bool(self._refresh_tasks)
            self.publish()
            # Discard vacancy events already satisfied by this round. A loss
            # during a genuinely empty round can cause at most one immediate
            # retry; an empty retry then uses the ordinary interval backoff.
            if len(self.entries) >= self.LIMIT:
                self._refill_needed.clear()
            try:
                await asyncio.wait_for(self._refill_needed.wait(), self.interval)
            except TimeoutError:
                pass

    async def run(self):
        if self._running:
            raise RuntimeError('reserve maintenance already running')
        self._running = True
        self._generation += 1
        tasks = [asyncio.create_task(self._maintain()), asyncio.create_task(self._refill_loop())]
        joined = asyncio.create_task(asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED))
        try:
            # Invalidate leases BEFORE propagating cancellation to owned children.
            done, _ = await asyncio.shield(joined)
            for task in done:
                task.result()
        finally:
            self._generation += 1
            owned = tasks + list(self._refresh_tasks.values())
            # Stop schedulers before yielding to cleanup, so no new-generation
            # refresh task can escape the ownership snapshot during cancellation.
            for task in owned:
                if not task.cancelling():
                    task.cancel()
            async def finish():
                await asyncio.gather(*owned, joined, return_exceptions=True)
                self._refresh_tasks.clear()
                self._refill_busy = self.checking = self._running = False
                self.publish()
            await await_cleanup(asyncio.create_task(finish()))

    async def take(self, *, on_result=None):
        """Race at most two privileged rechecks, then drain every owned child.

        The original leases stay in place until the race is settled. Cancellation
        is inconclusive and cannot renew them; a success already observed before
        cancellation keeps its real completion time, including for the runner-up.
        """
        async with self._take_lock:
            generation = self._generation
            self.prune()
            leases = [(key, entry, self._tokens.setdefault(key, object()))
                      for key, entry in list(self.entries.items())[:self.LIMIT]]
            if not leases:
                return None
            self.emit({'phase': 'reserve', 'proxy': None})
            ready = asyncio.Queue()
            results = {}
            order = []

            async def recheck(key, entry):
                def completed(result, at):
                    results[key] = (result, at)
                    order.append(key)
                    if on_result is not None and confirmed(key, *by_key[key]):
                        on_result(result, at, lease=(key, *by_key[key], generation))
                    ready.put_nowait(key)
                try:
                    result = await self.verify(candidate(entry[0]), on_result=completed,
                                               lease=(key, entry, by_key[key][1], generation, 'promotion'))
                    if result is None:
                        results[key] = (None, self.clock())
                finally:
                    # A check independently canceled by budget shutdown must also
                    # wake the race. Each endpoint is harvested only once below.
                    if key not in order:
                        order.append(key)
                        ready.put_nowait(key)

            def owns(key, entry, token):
                return (generation == self._generation
                        and self._tokens.get(key) is token
                        and self.entries.get(key) is entry)

            def confirmed(key, entry, token):
                result, at = results.get(key, (None, None))
                active = self.active()
                return (result is not None and owns(key, entry, token)
                        and at - entry[1] < self.ttl and self.clock() - at < self.ttl
                        and result.get('country') in self.countries
                        and self.eligible(candidate(result))
                        and not (active and self.conflicts(result, active)))

            tasks = [asyncio.create_task(recheck(key, entry)) for key, entry, _ in leases]
            by_key = {key: (entry, token) for key, entry, token in leases}
            try:
                seen = set()
                while len(seen) < len(leases):
                    key = await ready.get()
                    if key in seen:
                        continue
                    seen.add(key)
                    if confirmed(key, *by_key[key]):
                        break
            finally:
                for task in tasks:
                    if not task.done() and not task.cancelling():
                        task.cancel()
                async def finish():
                    await asyncio.gather(*tasks, return_exceptions=True)
                await await_cleanup(asyncio.create_task(finish()))

            if generation != self._generation:
                return None
            winner = next((key for key in order if confirmed(key, *by_key[key])), None)
            selected = results[winner][0] if winner is not None else None
            successes = []
            reserve_ids = {key: self._reserve_ids.get(key) for key, _, _ in leases}
            for key, entry, token in leases:
                if not owns(key, entry, token) or key not in results:
                    continue
                good = confirmed(key, entry, token)
                if good:
                    self._remove(key)
                else:
                    _, at = results[key]
                    expired = at - entry[1] >= self.ttl or self.clock() - at >= self.ttl
                    result, _ = results[key]
                    active = self.active()
                    reason = ('expired' if expired else
                              'outsideGroup' if result and result.get('country') not in self.countries else
                              'quarantined' if not self.eligible(candidate(entry[0])) else
                              ('sameHost' if result['host'] == active['host'] else 'sameExit')
                              if result and active and self.conflicts(result, active) else 'unknown')
                    self._remove(key, reason, stage='promotion')
                if good:
                    if key != winner:
                        successes.append((*results[key], entry, reserve_ids[key]))
                else:
                    result, at = results[key]
                    # An otherwise correct response that crossed a lease/TTL
                    # deadline is stale evidence, not a known endpoint failure.
                    if result is None or (at - entry[1] < self.ttl
                                          and self.clock() - at < self.ttl):
                        self.exclude(candidate(entry[0]), 60)
            # Inconclusive originals retain their original deadline, but cannot
            # share a host or egress with the route about to become active.
            if selected is not None:
                for key, (proxy, _) in list(self.entries.items()):
                    if self.conflicts(selected, proxy):
                        self._remove(key, 'sameHost' if selected['host'] == proxy['host'] else 'sameExit',
                                     stage='promotion')
            for result, at, entry, reserve_id in successes:
                reason = ('sameHost' if selected and selected['host'] == result['host'] else 'sameExit')
                if selected is None or not self.conflicts(selected, result):
                    reason = self._admission_reason(result, at)
                    if self.accept(result, at=at):
                        continue
                self.counts['removed'] += 1
                self._record_removal(entry, reserve_id, 'promotion', reason or 'unknown')
            self.publish()
            return selected
