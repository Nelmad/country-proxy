"""Test-only observer of production offers, reserve promotion and addressed browser feedback."""
import asyncio
from contextvars import ContextVar
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time
from native_probe_observer import project_native_probe

REASONS = frozenset(('connect', 'tls', 'transport', 'timeout', 'http', 'country',
                     'invalid_trace', 'unavailable', 'internal', 'unknown'))
LIMIT = 512
SESSION_LIMIT = 64
ORIGIN_LIMIT = 128  # One round: at most 120 discovery candidates + two reserves.
REMOVAL_STAGES = frozenset(('prune', 'maintenance', 'promotion'))
REMOVAL_REASONS = frozenset(('expired', 'quarantined', 'outsideGroup', 'sameHost',
                           'sameExit', 'full', 'stale', 'checkFailed', 'unknown'))


def now_ms():
    return time.time_ns() // 1_000_000


def elapsed_ms(start):
    return (time.monotonic_ns() - start) // 1_000_000


def endpoint(proxy):
    return tuple(proxy.get(key) for key in ('scheme', 'host', 'port'))


class OfferJournal:
    def __init__(self, directory):
        self.directory = Path(directory)

    def attach(self, session):
        for number in range(1, SESSION_LIMIT + 1):
            observer = SessionObserver(self.directory, number)
            try:
                observer.save(create=True)
            except FileExistsError:
                continue
            observer.attach(session)
            break
        else:
            (self.directory / 'offers-overflow').touch(mode=0o600)
            session.qa_injected_health_fault = lambda _attempt: None
        return session


class SessionObserver:
    def __init__(self, directory, number):
        self.path = directory / f'offers-{number:04d}.json'
        self.data = {'version': 1, 'session': number, 'truncated': False, 'offers': [], 'takes': [], 'removals': []}
        self.by_attempt = {}
        # Foreground branches run in child tasks. Keep bounded strong references
        # to the exact returned objects; ContextVar writes do not reach their parent.
        self.origins = {}
        self.take = ContextVar('pool_take', default=None)
        self.check = ContextVar('reserve_recheck', default=None)
        self.last_removal_id = 0

    def remember_origin(self, result, origin, age=None):
        if len(self.origins) >= ORIGIN_LIMIT:
            self.origins.pop(next(iter(self.origins)))
        self.origins[id(result)] = (result, origin, age)

    def save(self, *, create=False):
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix='.offer-')
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(self.data, stream, separators=(',', ':'))
            if create:
                # Claim the ordinal only after the complete initial snapshot exists.
                os.link(tmp, self.path)
            else:
                os.replace(tmp, self.path)
        finally:
            Path(tmp).unlink(missing_ok=True)

    def room(self, field):
        if len(self.data[field]) < LIMIT:
            return True
        if not self.data['truncated']:
            self.data['truncated'] = True
            self.save()
        return False

    def collect_removals(self, pool):
        """Copy final, addressed pool decisions; never infer them from a later check."""
        rows = pool.diagnostic_snapshot(False).get('removals', ())
        dirty = False
        for record in rows:
            serial = record.get('id')
            if type(serial) is not int or serial <= 0:
                self.data['truncated'] = dirty = True
                continue
            if serial <= self.last_removal_id:
                continue
            if serial != self.last_removal_id + 1:
                self.data['truncated'] = True
            self.last_removal_id = serial
            if not self.room('removals'):
                continue
            # This QA journal may be exported. Copy only the bounded diagnostic
            # schema, even if a future production snapshot carries extra fields.
            reserve_id = record.get('reserveId')
            row = {'id': serial,
                   'reserveId': reserve_id if isinstance(reserve_id, str) and re.fullmatch(r'[0-9a-f]{32}', reserve_id) else None,
                   'atMs': record.get('atMs') if type(record.get('atMs')) is int and record['atMs'] >= 0 else None,
                   'ageMs': record.get('ageMs') if type(record.get('ageMs')) is int and record['ageMs'] >= 0 else None,
                   'stage': record.get('stage') if record.get('stage') in REMOVAL_STAGES else 'unknown',
                   'reason': record.get('reason') if record.get('reason') in REMOVAL_REASONS else 'unknown'}
            detail = record.get('check')
            if isinstance(detail, dict):
                check = {'reason': detail.get('reason') if detail.get('reason') in REASONS else 'unknown'}
                if detail.get('endpoint') in ('trace', 'target'):
                    check['endpoint'] = detail['endpoint']
                if type(detail.get('code')) is int and 0 <= detail['code'] <= 999:
                    check['code'] = detail['code']
                if type(detail.get('status')) is int and 100 <= detail['status'] <= 599:
                    check['status'] = detail['status']
                latency = detail.get('latencyMs')
                if type(latency) in (int, float) and math.isfinite(latency) and 0 <= latency <= 86400000:
                    check['latencyMs'] = latency
                row['check'] = check
            self.data['removals'].append(row)
            dirty = True
        if dirty:
            self.save()

    def attach(self, session):
        pool = session.pool
        take, search = pool.take, session.search.run_round
        verify, budgeted = pool.verify, session._budgeted
        refresh, prune = pool._refresh_one, pool.prune
        output, feedback = session.output, session.browser_feedback

        async def take_observed(*args, **kwargs):
            # Observe this take independently of the parallel discovery branch.
            # Never prune, renew, or participate in winner selection here.
            at = pool.clock()
            ages = {endpoint(proxy): max(0, round(1000 * (at - checked)))
                    for proxy, checked in pool.entries.values()}
            row = None
            if ages and self.room('takes'):
                row = {'atMs': now_ms(), 'elapsedMs': None, 'leaseAgesMs': list(ages.values()),
                       'result': 'error', 'rechecks': []}
            token = self.take.set(row)
            start = time.monotonic_ns()
            completed = kwargs.get('on_result')
            if completed is not None:
                def capture(result, at, **details):
                    self.remember_origin(result, 'pool', ages.get(endpoint(result)))
                    return completed(result, at, **details)
                kwargs['on_result'] = capture
            try:
                result = await take(*args, **kwargs)
                if result is not None:
                    self.remember_origin(result, 'pool', ages.get(endpoint(result)))
                if row is not None:
                    row['result'] = 'selected' if result is not None else 'noEligible'
                return result
            except asyncio.CancelledError:
                if row is not None:
                    row['result'] = 'cancelled'
                raise
            finally:
                self.take.reset(token)
                if row is not None:
                    row['elapsedMs'] = elapsed_ms(start)
                    self.data['takes'].append(row)
                    self.save()
                self.collect_removals(pool)

        async def verify_observed(*args, **kwargs):
            row = self.take.get()
            if row is None:
                return await verify(*args, **kwargs)
            check = {'reason': None, 'outcome': 'error'}
            token = self.check.set(check)
            # The race receives the callback before verify drains its child tasks.
            # Cancellation during that cleanup must preserve the accepted result.
            completed = kwargs.get('on_result')
            if completed is not None:
                def capture(result, at):
                    check['outcome'] = 'passed' if result is not None else 'failed'
                    return completed(result, at)
                kwargs['on_result'] = capture
            try:
                result = await verify(*args, **kwargs)
                check['outcome'] = 'passed' if result is not None else 'failed'
                return result
            except asyncio.CancelledError:
                if check['outcome'] == 'error':
                    check['outcome'] = 'cancelled'
                raise
            finally:
                self.check.reset(token)
                row['rechecks'].append(check)

        async def budgeted_observed(item, country, slow, role):
            caller_started = time.monotonic_ns()
            report = await budgeted(item, country, slow, role)
            check = self.check.get()
            if role == 'reserve' and check is not None and '_qaProbe' in report:
                # Bind only to this returned physical report; a joined shared check
                # may have started earlier than this logical reserve recheck.
                probe = project_native_probe(report['_qaProbe'], caller_started)
                if probe is not None:
                    check['nativeProbe'] = probe
            if role == 'reserve' and not report.get('ok'):
                reason = report.get('reason')
                reason = reason if reason in REASONS else 'unknown'
                if check is not None:
                    check['reason'] = reason
            return report

        async def refresh_observed(*args, **kwargs):
            try:
                return await refresh(*args, **kwargs)
            finally:
                self.collect_removals(pool)

        def prune_observed(*args, **kwargs):
            try:
                return prune(*args, **kwargs)
            finally:
                self.collect_removals(pool)

        async def search_observed(*args, **kwargs):
            terminal = kwargs.get('on_terminal')
            if terminal is not None:
                def capture(item, observation, report):
                    value = terminal(item, observation, report)
                    if isinstance(report, dict) and report.get('ok') is True and report.get('proxy') is not None:
                        self.remember_origin(report['proxy'], 'discovery')
                    return value
                kwargs['on_terminal'] = capture
            result = await search(*args, **kwargs)
            if result[0] is not None:
                self.remember_origin(result[0], 'discovery')
            return result

        def emit_observed(event):
            self.collect_removals(pool)
            attempt = event.get('attempt')
            if (event.get('phase') == 'connected' and type(attempt) is int
                    and attempt not in self.by_attempt and self.room('offers')):
                proxy = event.get('proxy')
                returned, origin, age = self.origins.get(id(proxy), (None, 'unknown', None))
                self.origins.clear()
                if returned is not proxy or proxy is None:
                    origin, age = 'unknown', None
                checked = (proxy or {}).get('checkedAt')
                row = {'attempt': attempt, 'offeredAtMs': now_ms(), 'checkedAt': checked if type(checked) is int else None,
                       'origin': origin, 'reserveLeaseAgeMs': age, 'feedback': 'pending', 'feedbackMs': None,
                       'reason': None, 'injectedHealthFailures': 0, 'recheckRejection': None}
                self.data['offers'].append(row)
                self.by_attempt[attempt] = (row, time.monotonic_ns())
                self.save()
            return output(event)

        def feedback_observed(command, attempt, proxy, reason=None):
            at = time.monotonic_ns()
            accepted = feedback(command, attempt, proxy, reason)
            if accepted and attempt in self.by_attempt and command in ('confirm', 'reject'):
                row, start = self.by_attempt[attempt]
                if row['feedback'] == 'pending':
                    row.update(feedback=command, feedbackMs=(at - start) // 1_000_000,
                               reason=reason if command == 'reject' and reason in REASONS else None)
                    self.save()
                elif row['feedback'] == 'confirm' and command == 'reject' and row['recheckRejection'] is None:
                    checked = (session.active or {}).get('checkedAt')
                    row['recheckRejection'] = {'atMs': now_ms(), 'checkedAt': checked if type(checked) is int else None,
                                               'reason': reason if reason in REASONS else 'unknown'}
                    self.save()
            return accepted

        session.pool.take = take_observed
        session.pool.verify = verify_observed
        session.pool.prune = prune_observed
        session.pool._refresh_one = refresh_observed
        session.search.run_round = search_observed
        session._budgeted = budgeted_observed
        session.output = emit_observed
        session.browser_feedback = feedback_observed
        session.qa_injected_health_fault = self.note_injected

    def note_injected(self, attempt):
        if attempt in self.by_attempt:
            self.by_attempt[attempt][0]['injectedHealthFailures'] += 1
            self.save()
