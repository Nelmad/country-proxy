"""Bounded QA-only refill lifecycle; endpoint identities never enter the journal."""
import asyncio
from contextvars import ContextVar
import json
import time

from offer_observer import SessionObserver, SESSION_LIMIT, LIMIT, endpoint, now_ms, elapsed_ms
from native_probe_observer import project_native_probe
from public_probe_journal import ProbeAttribution, probe_owner, attribution_call


COUNTERS = frozenset(('rounds', 'roundsWithSourceWarnings', 'roundsWithoutChecks', 'checked',
                     'cancelled', 'qualified', 'qualifiedUnique', 'checkFailed', 'added', 'unused',
                     'quarantined', 'alreadyReserved', 'sameHost', 'sameExit', 'outsideGroup',
                     'stale', 'full', 'expired', 'removed'))
STATS = frozenset(('admissions', 'checks', 'fast', 'slow', 'peak_checks', 'country_starts', 'dropped'))


def numbers(value, names):
    return {k: v for k, v in value.items() if k in names and type(v) is int and 0 <= v <= 1000000}


def fault_target(raw, session, item):
    """A stale stage/offer cannot fault a new Session or a reused endpoint."""
    if not isinstance(raw, dict) or set(raw) != {'stage', 'session', 'attempt', 'endpoint'}:
        return False
    return (type(raw['stage']) is int and raw['stage'] in (1, 2)
            and type(raw['session']) is int and raw['session'] == session.qa_session_number
            and type(raw['attempt']) is int and raw['attempt'] == session.offer_attempt
            and isinstance(raw['endpoint'], str) and raw['endpoint'] == item.key
            and session.active is not None and endpoint(session.active) == (item.scheme, item.host, item.port))


class RefillJournal:
    def __init__(self, directory):
        self.directory = directory

    def attach(self, session):
        for number in range(1, SESSION_LIMIT + 1):
            observer = RefillObserver(self.directory, number)
            try:
                observer.save(create=True)
            except FileExistsError:
                continue
            observer.attach(session)
            return session
        raise RuntimeError('QA session journal limit')


class RefillObserver(SessionObserver):
    def __init__(self, directory, number):
        super().__init__(directory, number)
        self.data.update(refillVersion=1, lifecycle={'running': False, 'startedAtMs': None, 'stoppedAtMs': None},
                         refillRounds=[], admissions=[], faults=[], exclusions=[], liveAdmissions=[], maintenance=[])
        self.refill = ContextVar('qa_refill_round', default=None)
        self.renewal = ContextVar('qa_refill_renewal', default=None)
        self.maintenance = ContextVar('qa_maintenance_check', default=None)
        self.lineages = {}  # Private endpoint tuple -> bounded admission ordinal.
        self.promoted = {}  # Exact returned objects, never a later endpoint lookup.
        self.first_hosts = {}  # Private bounded identities; zero means previously offered/active.
        self.first_exits = {}

    def first_admission(self, identities, identity, number):
        if identity not in identities:
            if len(identities) >= LIMIT:
                self.data['truncated'] = True
                return None  # Unknown can never qualify as a new address.
            identities[identity] = number
        return identities[identity]

    def remember_route(self, proxy):
        if isinstance(proxy, dict):
            self.first_admission(self.first_hosts, proxy.get('host'), 0)
            self.first_admission(self.first_exits, proxy.get('exitIp'), 0)

    def attach(self, session):
        super().attach(session)
        attribution = ProbeAttribution(session, self.data['session'], self.path.parent)
        self.attribution = attribution
        session.qa_session_number = self.data['session']
        session.qa_refill_fault = self.note_fault
        pool = session.pool
        refill, accept, publish = pool._refill, pool.accept, pool.publish_snapshot
        remove, refresh, take = pool._remove, pool._refresh_one, pool.take
        budgeted, output, run = session._budgeted, session.output, session.run
        exclude = session.exclude

        def exclude_observed(item, seconds=180):
            value = exclude(item, seconds)
            if session.active and item.host == session.active['host'] and self.room('exclusions'):
                remaining = max(0, session.excluded.get(item.host, 0) - time.monotonic())
                self.data['exclusions'].append({'attempt': session.offer_attempt, 'atMs': now_ms(),
                                                'untilMs': now_ms() + round(remaining * 1000)})
                self.save()
            return value

        def publish_observed():
            live = sorted({self.lineages[endpoint(proxy)] for proxy, _ in pool.entries.values()
                           if endpoint(proxy) in self.lineages})
            if live != self.data['liveAdmissions']:
                self.data['liveAdmissions'] = live
                self.save()
            return publish()

        def accept_observed(result, *, at=None, refill=False):
            accepted = accept(result, at=at, refill=refill)
            key = endpoint(result)
            renewal = self.renewal.get()
            if accepted and not refill:
                if renewal is not None and key == renewal[0]:
                    if renewal[1] is not None:
                        self.lineages[key] = renewal[1]
                    else:
                        self.lineages.pop(key, None)
                    maintained = self.maintenance.get()
                    if maintained is not None:
                        maintained['renewed'] = True
                        maintained['nativeCheckedAt'] = result.get('checkedAt')
                else:
                    self.lineages.pop(key, None)
                publish_observed()
            if accepted and refill and self.room('admissions'):
                number = len(self.data['admissions']) + 1
                self.lineages[key] = number
                self.remember_route(session.active)
                # The production admission has already checked host exclusions,
                # history, country, TTL and independence. Record only the fact.
                row = {'id': number, 'atMs': now_ms(), 'attempt': session.offer_attempt,
                       'nativeCheckedAt': result.get('checkedAt'), 'country': result.get('country'),
                       'eligibleAtAdmission': True,
                       'firstHostAdmissionId': self.first_admission(self.first_hosts, result.get('host'), number),
                       'firstExitAdmissionId': self.first_admission(self.first_exits, result.get('exitIp'), number),
                       'confirmedAttemptAtAdmission': session.confirmed_attempt}
                row.update(attribution_call(attribution, 'ids', result) or {})
                self.data['admissions'].append(row)
                publish_observed()
                self.save()
            return accepted

        def remove_observed(key, *args, **kwargs):
            value = remove(key, *args, **kwargs)
            if value is not None:
                self.lineages.pop(endpoint(value[0]), None)
            return value

        async def refresh_observed(key, entry, *args):
            identity = endpoint(entry[0])
            admission = self.lineages.get(identity)
            token = self.renewal.set((identity, admission))
            row = None
            if self.room('maintenance'):
                row = {'id': len(self.data['maintenance']) + 1, 'admissionId': admission,
                       'attempt': session.offer_attempt, 'atMs': now_ms(), 'elapsedMs': None,
                       'outcome': 'pending', 'renewed': False, 'nativeCheckedAt': None,
                       'ok': None, 'check': None, 'nativeProbe': None}
                row.update(attribution_call(attribution, 'ids', entry[0]) or {})
                self.data['maintenance'].append(row)
                self.save()
            maintained = self.maintenance.set(row)
            start = time.monotonic_ns()
            try:
                result = await refresh(key, entry, *args)
                if row is not None:
                    row['outcome'] = 'completed'
                return result
            except asyncio.CancelledError:
                if row is not None:
                    row['outcome'] = 'cancelled'
                raise
            except Exception:
                if row is not None:
                    row['outcome'] = 'error'
                raise
            finally:
                self.maintenance.reset(maintained)
                self.renewal.reset(token)
                if row is not None:
                    row['elapsedMs'] = elapsed_ms(start)
                    self.save()

        async def take_observed(*args, **kwargs):
            callback = kwargs.get('on_result')
            if callback is not None:
                def capture(result, at, **details):
                    admission = self.lineages.get(endpoint(result))
                    if admission is not None:
                        if len(self.promoted) >= 128:
                            self.promoted.pop(next(iter(self.promoted)))
                        self.promoted[id(result)] = (result, admission)
                    return callback(result, at, **details)
                kwargs['on_result'] = capture
            return await take(*args, **kwargs)

        async def refill_observed():
            row = None
            start = time.monotonic_ns()
            round_before = session.search.round_number
            before = numbers(pool.counts, COUNTERS)
            if self.room('refillRounds'):
                row = {'id': len(self.data['refillRounds']) + 1, 'startedAtMs': now_ms(),
                       'attempt': session.offer_attempt, 'outcome': 'pending', 'elapsedMs': None,
                       'checks': 0, 'failures': [], 'counts': {}, 'scheduler': {}}
                self.data['refillRounds'].append(row)
                self.save()
            token = self.refill.set(row)
            try:
                result = await refill()
                if row is not None:
                    row['outcome'] = 'completed'
                return result
            except asyncio.CancelledError:
                if row is not None:
                    row['outcome'] = 'cancelled'
                raise
            except Exception:
                if row is not None:
                    row['outcome'] = 'error'
                raise
            finally:
                self.refill.reset(token)
                if row is not None:
                    row['elapsedMs'] = elapsed_ms(start)
                    row['counts'] = {k: max(0, v - before.get(k, 0))
                                     for k, v in numbers(pool.counts, COUNTERS).items()}
                    row['scheduler'] = (numbers(session.search.last_stats, STATS)
                                        if session.search.round_number != round_before else {})
                    self.save()

        async def budgeted_result(item, country, slow, role):
            caller_started = time.monotonic_ns()
            row = self.refill.get()
            if role == 'speculative' and row is not None:
                row['checks'] += 1
                self.save()
            result = await budgeted(item, country, slow, role)
            maintained = self.maintenance.get()
            if role == 'reserve' and maintained is not None:
                maintained['ok'] = result.get('ok') is True
                maintained['check'] = pool._check_detail(result)
                maintained['nativeProbe'] = project_native_probe(result.get('_qaProbe'), caller_started)
                self.save()
            if role == 'speculative' and row is not None and not result.get('ok'):
                detail = pool._check_detail(result) or {'reason': 'unknown'}
                detail.pop('latencyMs', None)  # Stable cause buckets, not one bucket per duration.
                existing = next((r for r in row['failures'] if r['check'] == detail), None)
                if existing:
                    existing['count'] += 1
                elif len(row['failures']) < 32:
                    row['failures'].append({'check': detail, 'count': 1})
                else:
                    self.data['truncated'] = True
                self.save()
            return result

        async def budgeted_observed(item, country, slow, role):
            refill_row, maintenance_row = self.refill.get(), self.maintenance.get()
            purpose = ('health' if role == 'health' else 'maintenance' if maintenance_row is not None
                       else 'promotion' if self.take.get() is not None and role == 'reserve'
                       else 'refill' if role == 'speculative' and refill_row is not None
                       else 'discovery' if role in ('foreground', 'speculative') else 'unknown')
            owner = attribution_call(attribution, 'enter', item, slow, role, purpose,
                                     refill_row['id'] if refill_row is not None else None,
                                     maintenance_row['id'] if maintenance_row is not None else None)
            token = probe_owner.set((attribution, owner))
            try:
                result = await budgeted_result(item, country, slow, role)
                attribution_call(attribution, 'bind_result', owner, result)
                return result
            finally:
                probe_owner.reset(token)
                attribution_call(attribution, 'leave', owner)

        def output_observed(event):
            value = output(event)
            attempt = event.get('attempt')
            if event.get('phase') == 'connected' and attempt in self.by_attempt:
                self.remember_route(event.get('proxy'))
                row = self.by_attempt[attempt][0]
                row.update(attribution_call(attribution, 'ids', event.get('proxy')) or {})
                if row['origin'] == 'pool':
                    result = event.get('proxy')
                    returned, admission = self.promoted.get(id(result), (None, None))
                    if returned is result and admission is not None and row.get('refillAdmissionId') != admission:
                        row['refillAdmissionId'] = admission
                        self.save()
                self.save()
            return value

        async def run_observed():
            self.data['lifecycle'].update(running=True, startedAtMs=now_ms())
            self.save()
            try:
                return await run()
            finally:
                self.data['lifecycle'].update(running=False, stoppedAtMs=now_ms())
                self.save()

        pool._refill, pool.accept, pool.publish_snapshot = refill_observed, accept_observed, publish_observed
        pool._remove, pool._refresh_one, pool.take = remove_observed, refresh_observed, take_observed
        session._budgeted, session.output, session.run = budgeted_observed, output_observed, run_observed
        session.exclude = exclude_observed

        def trace_round(operation):
            async def traced(*args, **kwargs):
                terminal = kwargs.get('on_terminal')
                if terminal is not None:
                    def observed(item, observation, report):
                        try:
                            return terminal(item, observation, report)
                        finally:
                            attribution_call(attribution, 'sources', item, session.search.round_number, observation)
                    kwargs['on_terminal'] = observed
                return await operation(*args, **kwargs)
            return traced
        session.search.run_round = trace_round(session.search.run_round)
        if pool.stream_round is not None:
            pool.stream_round = trace_round(pool.stream_round)

    def note_fault(self, stage, attempt):
        if self.room('faults'):
            self.data['faults'].append({'stage': stage, 'attempt': attempt, 'atMs': now_ms(),
                                        'admissionCount': len(self.data['admissions'])})
            self.save()
        self.note_injected(attempt)

