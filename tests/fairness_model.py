"""Executable specification of discovery/admission fairness, not production code.

Logical time and opaque endpoint identifiers stand in for network operations.
Events record checker dispatch after acquiring one of ten slots, not merely a
credit grant. No real HTTPS, GeoIP, browser, persistence or success is simulated.
"""
from collections import deque
from dataclasses import dataclass
import heapq
import math


CAP = 120
JOBS = 3
SLOTS = 10
DISCOVERY_SECONDS = 45.0
MAX_CHECK_SECONDS = 47.0


def probe_bound(country_count):
    """Maximum inclusive rounds from readiness, including its partial round."""
    if not 1 <= country_count <= 249:
        raise ValueError('country count must be 1..249')
    return 1 + math.ceil(country_count / CAP)


def discovery_bound(country_count):
    if not 1 <= country_count <= 249:
        raise ValueError('country count must be 1..249')
    return math.ceil(country_count / JOBS)


@dataclass(frozen=True)
class Candidate:
    key: str
    fast_seconds: float = 0.1
    slow_seconds: float | None = None

    def __post_init__(self):
        for duration in (self.fast_seconds, self.slow_seconds):
            if duration is not None and not (
                    math.isfinite(duration) and 0 < duration <= MAX_CHECK_SECONDS):
                raise ValueError('checker duration must be finite and bounded')


@dataclass(frozen=True)
class Feed:
    at: float
    candidates: tuple[Candidate, ...]


@dataclass(frozen=True)
class Producer:
    # None means a hung producer, cancelled at the round discovery deadline.
    finish: float | None = None
    feeds: tuple[Feed, ...] = ()

    def __post_init__(self):
        if self.finish is not None and (
                not math.isfinite(self.finish) or self.finish < 0):
            raise ValueError('invalid completion time')
        for feed in self.feeds:
            if not math.isfinite(feed.at) or feed.at < 0:
                raise ValueError('invalid feed time')
            if self.finish is not None and feed.at > self.finish:
                raise ValueError('feed cannot arrive after producer completion')


class FairModel:
    """A deterministic event machine for a fixed selected country set.

    `order` is a once-sampled random ring, supplied explicitly for reproducible
    tests. Selection order and labels do not determine scheduling. Neither cursor
    is reset between rounds. A changed selected set starts a new generation.

    At most 120 retained queue references per country; existing references are
    never evicted by incoming results. An endpoint shared by country queues is
    admitted once per round and its checker serves every already-known owner.
    """

    def __init__(self, selected, order, *, credit_cursor=0, discovery_cursor=0):
        self.order = tuple(order)
        if (not 1 <= len(self.order) <= 249 or
                len(set(self.order)) != len(self.order) or
                set(selected) != set(self.order)):
            raise ValueError('order must be an exact permutation of selection')
        self.n = len(self.order)
        self.credit_cursor = credit_cursor % self.n
        self.discovery_cursor = discovery_cursor % self.n
        self.admission_cursor = 0
        self.pending = {country: deque() for country in self.order}
        self.records = {}
        self.events = []
        self.now = 0.0
        self.round = 0
        self.high_water = {'jobs': 0, 'checks': 0, 'pending': 0}
        self.serial = 0

    def emit(self, kind, **detail):
        self.events.append({'kind': kind, 'round': self.round,
                            'time': self.now, **detail})

    def offer(self, country, candidate):
        """Accept readiness only after bounded queue admission.

        Returning False means bounded backpressure/drop, not a retained eligible
        candidate. Existing queue heads survive source-cache eviction by design.
        """
        queue = self.pending[country]
        if candidate.key in queue:
            return True
        if len(queue) >= CAP:
            self.emit('queue_full', country=country, endpoint=candidate.key)
            return False
        record = self.records.get(candidate.key)
        if record is None:
            record = {'candidate': candidate, 'owners': set()}
            self.records[candidate.key] = record
        elif record['candidate'] != candidate:
            raise ValueError('same endpoint must have the same fixture behavior')
        record['owners'].add(country)
        queue.append(candidate.key)
        self.emit('ready', country=country, endpoint=candidate.key)
        self.high_water['pending'] = max(
            self.high_water['pending'], sum(map(len, self.pending.values())))
        return True

    def _schedule(self, when, kind, value=None):
        self.serial += 1
        heapq.heappush(self.heap, (when, self.serial, kind, value))

    def _eligible(self, country):
        return next((key for key in self.pending[country]
                     if key not in self.admitted), None)

    def _release(self):
        # A pending or running producer keeps its unspent share, even if empty.
        # Only a terminal producer with no usable queue may lend those tickets.
        for country in self.order:
            if self.status[country] == 'done' and self._eligible(country) is None:
                self.shared += self.credits[country]
                self.credits[country] = 0

    def _pump(self):
        self._release()
        while len(self.admitted) < CAP:
            chosen = None
            for offset in range(self.n):
                index = (self.admission_cursor + offset) % self.n
                country = self.order[index]
                key = self._eligible(country)
                if key is not None and (self.credits[country] or self.shared):
                    chosen = (index, country, key)
                    break
            if chosen is None:
                break
            index, country, key = chosen
            self.admission_cursor = (index + 1) % self.n
            if self.credits[country]:
                self.credits[country] -= 1
            else:
                self.shared -= 1
            record = self.records.pop(key)
            owners = tuple(cc for cc in self.order if cc in record['owners'])
            for owner in owners:
                self.pending[owner].remove(key)
            self.admitted.add(key)
            self.emit('admit', country=country, endpoint=key, owners=owners)
            self.check_queue.append((record['candidate'], country, owners, 'fast'))
            self._release()
        self._dispatch_checks()

    def _dispatch_checks(self):
        while self.check_queue and self.active_checks < SLOTS:
            candidate, country, owners, phase = self.check_queue.popleft()
            self.active_checks += 1
            self.high_water['checks'] = max(self.high_water['checks'], self.active_checks)
            self.emit('checker_start', country=country, endpoint=candidate.key,
                      owners=owners, phase=phase, active=self.active_checks)
            duration = candidate.fast_seconds if phase == 'fast' else candidate.slow_seconds
            self._schedule(self.now + duration, 'check_done',
                           (candidate, country, owners, phase))

    def _start_jobs(self):
        while (self.active_jobs < JOBS and len(self.started) < self.n and
               self.now < self.deadline):
            country = self.order[self.discovery_cursor]
            self.discovery_cursor = (self.discovery_cursor + 1) % self.n
            # One turn visits each country at most once. Actual starts move the
            # cursor; merely queuing or expiring unstarted work never does.
            assert country not in self.started
            self.started.add(country)
            self.status[country] = 'running'
            self.active_jobs += 1
            self.high_water['jobs'] = max(self.high_water['jobs'], self.active_jobs)
            self.emit('discovery_start', country=country, active=self.active_jobs)
            producer = self.producers.get(country, Producer())
            for feed in producer.feeds:
                if self.now + feed.at < self.deadline:
                    self._schedule(self.now + feed.at, 'feed', (country, feed))
            if producer.finish is not None and self.now + producer.finish < self.deadline:
                self._schedule(self.now + producer.finish, 'producer_done', country)

    def run_round(self, producers=None):
        self.round += 1
        self.heap = []
        self.producers = producers or {}
        if not set(self.producers).issubset(self.pending):
            raise ValueError('producer outside selection')
        self.credits = {country: 0 for country in self.order}
        for offset in range(CAP):
            self.credits[self.order[(self.credit_cursor + offset) % self.n]] += 1
        self.credit_cursor = (self.credit_cursor + CAP) % self.n
        self.emit('credit_grant', credits=dict(self.credits))
        self.shared = 0
        self.admitted = set()
        self.started = set()
        self.status = {country: 'pending' for country in self.order}
        self.active_jobs = self.active_checks = 0
        self.check_queue = deque()
        self.deadline = self.now + DISCOVERY_SECONDS
        self._schedule(self.deadline, 'deadline')
        self._pump()
        self._start_jobs()
        while self.heap:
            self.now, _, kind, value = heapq.heappop(self.heap)
            if kind == 'feed':
                country, feed = value
                for candidate in feed.candidates[:CAP]:
                    self.offer(country, candidate)
            elif kind == 'producer_done':
                self.status[value] = 'done'
                self.active_jobs -= 1
                self.emit('discovery_done', country=value)
                self._start_jobs()
            elif kind == 'deadline':
                for country in self.order:
                    if self.status[country] != 'done':
                        self.emit('discovery_timeout', country=country,
                                  started=country in self.started)
                    self.status[country] = 'done'
                self.active_jobs = 0
            elif kind == 'check_done':
                candidate, country, owners, phase = value
                self.active_checks -= 1
                self.emit('checker_end', country=country,
                          endpoint=candidate.key, phase=phase)
                if phase == 'fast' and candidate.slow_seconds is not None:
                    self.check_queue.append((candidate, country, owners, 'slow'))
            self._pump()
        assert not self.check_queue and self.active_checks == self.active_jobs == 0
        self.emit('round_end', admissions=len(self.admitted))
        return self.round

    def starts(self, *, round_number=None, country=None, phase='fast'):
        return [event for event in self.events
                if event['kind'] == 'checker_start' and event['phase'] == phase
                and (round_number is None or event['round'] == round_number)
                and (country is None or country in event['owners'])]
