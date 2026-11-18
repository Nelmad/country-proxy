"""Public proxy discovery and bounded HTTPS checks; no browser traffic passes here."""
import asyncio
import ipaddress
import json
import os
import random
import re
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from check_budget import CheckBudget, SupplementalBudget, await_cleanup

ROOT = Path(__file__).resolve().parents[1]
COUNTRIES = set(json.loads((ROOT / 'extension/countries.json').read_text()))
SCHEMES = ('http', 'socks4', 'socks5')
TRACE = 'https://www.cloudflare.com/cdn-cgi/trace'
TARGET = 'https://www.google.com/generate_204'
CANDIDATE_LIMIT = 120
DISCOVERY_CONCURRENCY = 3
DISCOVERY_BUDGET = 45
SCAN_CONCURRENCY = 10
RESERVE_EXTRA_DELAY = 5.0
RESERVE_PROBE_TIMEOUT = 47.0  # Existing slow curl limit (45 s) plus process grace.


def country_code(value):
    if not isinstance(value, str) or value.upper() not in COUNTRIES:
        raise ValueError('Нужен код страны ISO 3166-1 alpha-2')
    return value.upper()


def country_codes(value):
    """Canonical unordered selection; legacy single-country callers remain valid."""
    values = [value] if isinstance(value, str) else value
    if not isinstance(values, (list, tuple)) or not 1 <= len(values) <= len(COUNTRIES):
        raise ValueError('Выберите хотя бы одну страну из каталога')
    return tuple(sorted({country_code(item) for item in values}))


def selection_argument(countries):
    """Keep injected legacy single-country sources/checkers compatible."""
    return countries[0] if len(countries) == 1 else countries


@dataclass(frozen=True)
class Candidate:
    scheme: str
    host: str
    port: int

    @property
    def url(self):
        scheme = 'socks5h' if self.scheme == 'socks5' else self.scheme
        return f'{scheme}://{self.host}:{self.port}'

    @property
    def key(self):
        return f'{self.scheme}://{self.host}:{self.port}'


def parse_candidates(text):
    """Lists are untrusted: accept public literal IPv4 only, never credentials or URLs."""
    result = []
    for line in text.splitlines():
        m = re.fullmatch(r'(?:(https|http|socks4|socks5)://)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})', line.strip())
        if not m:
            continue
        scheme, host, port = m.groups()
        try:
            ip = ipaddress.ip_address(host)
            if not ip.is_global or ip.is_multicast or not 0 < int(port) < 65536:
                continue
        except ValueError:
            continue
        result.extend(Candidate(s, host, int(port)) for s in ([scheme] if scheme else SCHEMES))
    return list(dict.fromkeys(result))


async def process(argv, timeout, max_bytes=2_000_000):
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'SSL_CERT_FILE') if k in os.environ}
    # A winning endpoint can cancel other feeds during subprocess creation.
    # Keep ownership until the handle exists, including when cancellation repeats.
    launch = asyncio.create_task(asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=env))

    async def reap(child):
        if child.returncode is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass
        # A full pipe may otherwise keep wait() pending after the child exited.
        while await child.stdout.read(16384):
            pass
        await child.wait()

    try:
        proc = await asyncio.shield(launch)
    except asyncio.CancelledError:
        async def finish_launch():
            try:
                child = await launch
            except Exception:
                return  # Nothing was spawned.
            await reap(child)
        await await_cleanup(asyncio.create_task(finish_launch()))
        raise
    async def bounded_read():
        chunks, size = [], 0
        while chunk := await proc.stdout.read(16384):
            size += len(chunk)
            if size > max_bytes:
                raise ValueError('response too large')
            chunks.append(chunk)
        await proc.wait()
        return b''.join(chunks)
    try:
        if timeout is not None and timeout <= 0:
            raise TimeoutError
        async with asyncio.timeout(timeout):
            data = await bounded_read()
        return proc.returncode, data.decode('utf-8', errors='replace')
    finally:
        await await_cleanup(asyncio.create_task(reap(proc)))


async def curl(url, proxy=None, slow=False):
    total = 45 if slow else 12
    argv = ['/usr/bin/curl', '--disable', '--silent', '--show-error', '--connect-timeout',
            str(30 if slow else 7), '--max-time', str(total), '--max-filesize', '2000000',
            '--proto', '=https', '--noproxy', '', '--proxy', proxy.url if proxy else '',
            '--write-out', '\n%{http_code}', url]
    code, text = await process(argv, total + 2)
    body, _, status = text.rpartition('\n')
    return code, status, body


async def library_candidates(country):
    country = country_code(country)
    code, raw = await process([sys.executable, '-I', str(ROOT / 'native/library_source.py'), country], 28)
    if code:
        raise RuntimeError('proxy-scraper недоступен')
    return parse_candidates(raw)


def stream_country(country):
    from sources import stream_feeds
    country = country_code(country)
    return stream_feeds(country, curl, parse_candidates, lambda: library_candidates(country))


async def discover(country, cap=120):
    """Compatibility API for tools explicitly requesting a completed list."""
    from sources import collect
    country = country_code(country)
    return await collect(country, curl, parse_candidates, lambda: library_candidates(country), cap)


async def discover_selection(countries, discoverer=discover, cap=CANDIDATE_LIMIT, shuffle=None,
                             budget=DISCOVERY_BUDGET):
    """Fetch at most three countries at once, then fairly share one candidate budget.

    Input order carries no priority. Randomizing the canonical set gives every
    country a chance at early probe slots, including when the set exceeds cap.
    """
    from sources import fair_merge
    order = list(country_codes(countries))
    cap = max(0, min(cap, CANDIDATE_LIMIT))
    if not cap:
        return [], []
    (shuffle or random.SystemRandom().shuffle)(order)
    queue = asyncio.Queue()
    for cc in order:
        queue.put_nowait(cc)
    results = {}
    async def worker():
        while not queue.empty():
            cc = queue.get_nowait()
            try:
                candidates, warnings = await discoverer(cc)
                results[cc] = (list(dict.fromkeys(candidates))[:cap], list(warnings))
            except Exception:
                results[cc] = ([], ['Источники временно недоступны; поиск повторится автоматически'])
    tasks = [asyncio.create_task(worker()) for _ in range(min(DISCOVERY_CONCURRENCY, len(order)))]
    try:
        async with asyncio.timeout(budget):
            await asyncio.gather(*tasks)
    except TimeoutError:
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    # Bound diagnostics as well: a large selection must fit the native frame.
    warnings = [f'{cc}: {warning}' for cc in order for warning in results.get(cc, ([], []))[1]]
    if len(warnings) > 12:
        warnings = warnings[:12] + [f'Ещё предупреждений источников: {len(warnings) - 12}']
    if len(results) < len(order):
        warnings.append(f'Поиск источников не завершён для {len(order) - len(results)} стран; повторится автоматически')
    return fair_merge([results.get(cc, ([], []))[0] for cc in order], cap), warnings


async def inspect_proxy(candidate, country, slow=False, *, extras=None):
    """Both HTTPS controls must pass; reserve extras cannot extend the deadline."""
    countries = country_codes(country)
    started = time.monotonic()
    supplemental = extras is not None and slow

    async def inspect_attempt(endpoint, url, expected):
        def failure(reason, **detail):
            return {'ok': False, 'reason': reason, 'endpoint': endpoint, **detail}
        try:
            rc, status, body = await curl(url, candidate, slow)
        except (FileNotFoundError, PermissionError):
            return failure('internal')
        except TimeoutError:
            return failure('timeout')
        except Exception:
            return failure('transport')
        if rc:
            reason = ('timeout' if rc == 28 else 'tls' if rc in (35, 51, 58, 59, 60, 64, 66, 77, 80, 82, 83, 90, 91)
                      else 'connect' if rc in (5, 6, 7, 97) else 'transport')
            return failure(reason, code=rc)
        if status != expected:
            return failure('http', status=status)
        if endpoint == 'target':
            return {'ok': True}
        fields = dict(line.split('=', 1) for line in body.splitlines() if '=' in line)
        try:
            ip = ipaddress.ip_address(fields.get('ip', ''))
            if not ip.is_global or ip.is_multicast or not re.fullmatch('[A-Z]{2}', fields.get('loc', '')):
                raise ValueError('invalid trace')
        except ValueError:
            return failure('invalid_trace')
        if fields['loc'] not in countries:
            return failure('country', country=fields['loc'])
        return {'ok': True, 'country': fields['loc'], 'exitIp': fields['ip']}

    async def inspect_control(endpoint, url, expected):
        if not supplemental:
            return await inspect_attempt(endpoint, url, expected)
        primary = asyncio.create_task(inspect_attempt(endpoint, url, expected))
        timer = asyncio.create_task(asyncio.sleep(RESERVE_EXTRA_DELAY))
        owned = [primary, timer]
        extra = None
        extra_attempted = False
        completed = asyncio.Queue()
        primary.add_done_callback(completed.put_nowait)
        timer.add_done_callback(completed.put_nowait)

        def start_extra():
            nonlocal extra, extra_attempted
            if not extra_attempted:
                # The timer and a SOCKS negotiation failure share one allowance.
                # A denied permit consumes it too: optional work never queues.
                extra_attempted = True
                owner = extras.acquire()
                if owner is not None:
                    extra = asyncio.create_task(inspect_attempt(endpoint, url, expected))
                    owned.append(extra)
                    # Retain capacity until the transfer has drained, including
                    # cancellation before the coroutine's first instruction.
                    extra.add_done_callback(lambda _, token=owner: extras.release(token))
                    extra.add_done_callback(completed.put_nowait)
            return extra

        def retryable(result):
            return candidate.scheme in ('socks4', 'socks5') and result.get('code') == 97

        def may_wait_existing(result):
            # A curl timeout may use only a transfer already admitted by the
            # timer. It never starts work, acquires a permit or renews the clock.
            return (result.get('code') == 28 and extra is not None and not extra.cancelled()
                    and (not extra.done() or extra.result()['ok']))

        def completed_failure():
            # Callback queue order cannot hide a completed security/control
            # rejection behind another connection's successful response.
            for attempt in owned:
                if attempt is not timer and attempt.done() and not attempt.cancelled():
                    result = attempt.result()
                    if result.get('reason') in ('tls', 'internal', 'http', 'country', 'invalid_trace'):
                        return result
            if primary.done() and not primary.cancelled():
                result = primary.result()
                if not result['ok'] and not retryable(result) and not may_wait_existing(result):
                    return result
            return None

        try:
            while True:
                task = await completed.get()
                if task is timer:
                    if not primary.done():
                        start_extra()
                    continue
                result = task.result()
                rejection = completed_failure()
                if rejection is not None:
                    result = rejection
                    break
                if result['ok']:
                    break
                if task is primary:
                    if retryable(result):
                        retry = start_extra()
                        if retry is not None:
                            if not retry.done():
                                continue
                            result = retry.result()
                    elif may_wait_existing(result):
                        if not extra.done():
                            continue
                        result = extra.result()
                    break
                # Failure of an optional connection alone must not reject a
                # pending primary. A completed SOCKS97 primary has no third try.
                if primary.done():
                    primary_result = primary.result()
                    if not retryable(primary_result) and not may_wait_existing(primary_result):
                        result = primary_result
                    break
        finally:
            for task in owned:
                if not task.done() and not task.cancelling():
                    task.cancel()
            await await_cleanup(asyncio.gather(*owned, return_exceptions=True))
        # A losing transfer can finish with a rejection while cancellation drains.
        # Parent cancellation still propagates through finally without a result.
        rejection = completed_failure()
        return rejection if rejection is not None else result

    tasks = [asyncio.create_task(inspect_control('trace', TRACE, '200')),
             asyncio.create_task(inspect_control('target', TARGET, '204'))]
    try:
        try:
            async with asyncio.timeout(RESERVE_PROBE_TIMEOUT if supplemental else None):
                for completed in asyncio.as_completed(tasks):
                    result = await completed
                    if not result['ok']:
                        return {**result, 'latencyMs': round((time.monotonic() - started) * 1000)}
        except TimeoutError:
            return {'ok': False, 'reason': 'timeout',
                    'latencyMs': round((time.monotonic() - started) * 1000)}
        trace = tasks[0].result()
        proxy = {**asdict(candidate), 'country': trace['country'], 'exitIp': trace['exitIp'],
                 'latencyMs': round((time.monotonic() - started) * 1000),
                 'checkedAt': int(time.time() * 1000)}
        return {'ok': True, 'proxy': proxy}
    finally:
        pending = [task for task in tasks if not task.done()]
        for task in pending:
            if not task.cancelling():
                task.cancel()
        if pending:
            await await_cleanup(asyncio.gather(*pending, return_exceptions=True))


async def check(candidate, country, slow=False):
    return (await inspect_proxy(candidate, country, slow)).get('proxy')


async def scan(candidates, country, on_progress, checker=check, concurrency=10):
    """Fast pass, then a generous retry for every country. Cancel all probes on first success."""
    candidates = list(dict.fromkeys(candidates))[:CANDIDATE_LIMIT]
    concurrency = max(1, min(concurrency, SCAN_CONCURRENCY))
    for slow in (False, True):
        queue = asyncio.Queue()
        for candidate in candidates:
            queue.put_nowait(candidate)
        completed, found = 0, asyncio.get_running_loop().create_future()
        async def worker():
            nonlocal completed
            while not queue.empty() and not found.done():
                item = queue.get_nowait()
                result = await checker(item, country, slow)
                completed += 1
                on_progress('slow' if slow else 'checking', completed, len(candidates))
                if result and not found.done():
                    found.set_result(result)
        tasks = [asyncio.create_task(worker()) for _ in range(min(concurrency, len(candidates)))]
        if not tasks:
            return None
        all_done = asyncio.gather(*tasks)
        try:
            await asyncio.wait([found, all_done], return_when=asyncio.FIRST_COMPLETED)
            if found.done():
                return found.result()
            await all_done
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.gather(all_done, return_exceptions=True)
            if not found.done():
                found.cancel()
    return None


class Session:
    def __init__(self, country, emit, discoverer=discover, checker=check, interval=30, retry=60,
                 pool_factory=None, *, source_stream=None, source_groups=None, shuffle=None, history=None, feed_cache=None):
        from history import EndpointHistory
        from pool import ReservePool
        from source_quality import SourceQuality
        from sources import CACHE, provider_groups, SourceBatch
        from stream_search import StreamSearch
        self.countries = country_codes(country)
        self.country = selection_argument(self.countries)
        self.diagnostics = {'attempts': 0, 'passed': 0, 'failures': {}}
        self.output = emit
        self.raw_discoverer, self.raw_checker = discoverer, checker
        # Keep injected single-country discovery compatible. Each country still
        # produces independently; production yields a batch for every completed feed.
        if source_stream is None and discoverer is discover:
            source_stream, source_groups = stream_country, provider_groups()
            feed_cache = CACHE
        elif source_stream is None:
            async def source_stream(cc):
                items, warnings = await discoverer(cc)
                yield SourceBatch('injected', 'injected', tuple(items[:CANDIDATE_LIMIT]),
                                  '; '.join(str(w)[:140] for w in warnings[:3]) or None,
                                  time.time(), True)
            source_groups = ('injected',)
        elif not source_groups:
            raise ValueError('Streaming sources must declare their provider groups')
        self.feed_cache = feed_cache
        self.quality = SourceQuality(self.countries, source_groups)
        self.search = StreamSearch(self.countries, source_groups, source_stream, shuffle=shuffle, quality=self.quality,
                                   history=EndpointHistory() if history is None else history)
        self.check_budget = CheckBudget()
        self.supplemental_budget = SupplementalBudget()
        self.discoverer, self.checker = self.discover, self.checked
        self.interval, self.retry = interval, retry
        self.active = None
        self.previous = None
        self.offer_attempt = 0
        self.reserve_failures = {}
        self.confirmed_attempt = 0
        self.browser_confirmed = self.browser_rejected = 0
        self.wait_for_browser = False
        self.wake = asyncio.Event()
        self.force_rotate = False
        self.rotation = asyncio.Event()
        self.excluded = {}
        self.pool_task = None
        self.pool = (pool_factory or ReservePool)(self.country, self.discoverer, self.reserve_checked,
            lambda: self.active or self.previous, self.eligible, self.exclude, self.emit)
        self.pool.refill_checker = self.speculative_checked
        self.pool.report_checker = self.reserve_report
        self.pool.stream_round = self.search.run_round

    def emit(self, event):
        # Counts are session-local attempts, including retries/health/reserve, not unique IPs.
        snapshot = {**self.diagnostics, 'failures': dict(self.diagnostics['failures'])}
        if hasattr(self.pool, 'diagnostic_snapshot'):
            reserve = self.pool.diagnostic_snapshot(self.active is not None and not self.force_rotate)
            reserve['failures'] = dict(self.reserve_failures)
            reserve['counts'].update(offered=self.offer_attempt, confirmed=self.browser_confirmed,
                                     rejected=self.browser_rejected)
            snapshot['reserve'] = reserve
        proxy = event.get('proxy') or self.active
        actual = proxy['country'] if proxy else (self.countries[0] if len(self.countries) == 1 else None)
        if event.get('phase') in ('connected', 'confirming') and self.active:
            event = {**event, 'attempt': self.offer_attempt}
        self.output({**event, 'countries': list(self.countries), 'country': actual, 'diagnostics': snapshot})

    def source_report(self, country):
        summary = self.quality.summary(country)
        summary['feeds'] = self.feed_cache.metrics(country) if self.feed_cache is not None else []
        return summary

    async def discover(self, country):
        return await discover_selection(country, self.raw_discoverer)

    @property
    def history(self):
        return self.search.history

    @history.setter
    def history(self, value):
        self.search.history = value

    async def checked(self, item, country, slow=False):
        return (await self.scan_report(item, country, slow)).get('proxy')

    async def scan_report(self, item, country, slow=False):
        return await self._budgeted(item, country, slow, 'foreground')

    async def speculative_checked(self, item, country, slow=False):
        return await self._single_check(item, country, slow, 'speculative')

    async def reserve_checked(self, item, country, slow=False):
        return await self._single_check(item, country, slow, 'reserve')

    async def reserve_report(self, item, country, slow=False):
        return await self._single_report(item, country, slow, 'reserve')

    async def _single_check(self, item, country, slow, role):
        return (await self._single_report(item, country, slow, role)).get('proxy')

    async def _single_report(self, item, country, slow, role):
        report = await self._budgeted(item, country, slow, role)
        if role == 'speculative':
            # This is a slow discovery probe for a new reserve. Maintenance and
            # promotion can recheck an old reserve, but do not earn new votes.
            self.quality.terminal(item, report)
            if not report.get('ok'):
                reason = report.get('reason')
                if reason not in ('timeout', 'tls', 'connect', 'http', 'country', 'invalid_trace',
                                  'transport', 'internal', 'unavailable'):
                    reason = 'unknown'
                self.reserve_failures[reason] = self.reserve_failures.get(reason, 0) + 1
        self.remember_check(item, {}, report)
        return report

    async def _budgeted(self, item, country, slow, role):
        # Coalesced work retains its first owner's policy. Joining an already
        # running foreground probe does not create another endpoint check.
        extras = self.supplemental_budget if role == 'reserve' else None
        return await self.check_budget.run(item.key, bool(slow), role,
            lambda: self._raw_report(item, country, slow, extras))

    async def _raw_report(self, item, country, slow=False, extras=None):
        try:
            if self.raw_checker is check:
                if extras is None:
                    report = await inspect_proxy(item, country, slow)
                else:
                    report = await inspect_proxy(item, country, slow, extras=extras)
            else:
                started = time.monotonic()
                result = await self.raw_checker(item, country, slow)
                report = ({'ok': True, 'proxy': result, 'latencyMs': round((time.monotonic() - started) * 1000)}
                          if result else {'ok': False, 'reason': 'unavailable'})
            result = report.get('proxy')
            if result and result.get('country') not in self.countries:
                report = {'ok': False, 'reason': 'country', 'country': result.get('country')}
        except Exception:
            report = {'ok': False, 'reason': 'internal'}
        self.diagnostics['attempts'] += 1
        if report.get('proxy'):
            self.diagnostics['passed'] += 1
        else:
            reason = report['reason']
            failures = self.diagnostics['failures']
            failures[reason] = failures.get(reason, 0) + 1
        return report

    def remember_check(self, item, observation, report):
        # Shared physical checks have one report. Fast failures reach this hook
        # only if the logical attempt has reached its terminal slow result.
        if observation.get('endpoint') and report is not None:
            self.quality.terminal(item, report)
        if report is None or report.get('_remembered'):
            return
        report['_remembered'] = True
        proxy = report.get('proxy')
        groups = [source['group'] for source in observation.get('sources', ())]
        if proxy:
            self.history.observe(item, 'success', country=proxy['country'],
                                 latency_ms=proxy.get('latencyMs', report.get('latencyMs')), groups=groups)
        else:
            reason = report.get('reason')
            if reason in ('internal', 'neutral', 'cancel', 'cancelled') or (reason == 'tls' and report.get('code') in (58, 59, 77, 82)):
                return
            # A curl TLS error alone cannot attribute a broken trust chain to this proxy.
            kind = {'invalid_trace': 'endpoint_failure', 'country': 'country'}.get(reason, 'unknown')
            hint = report.get('country')
            self.history.observe(item, kind, country=hint if hint in COUNTRIES else None, groups=groups, reason=reason)

    async def health(self, item, *, confirming_failure=False):
        # Browser rejection must not wait for a slow curl before a ready reserve is tried.
        probe = asyncio.create_task(self._budgeted(item, self.country, True, 'health'))
        rotate = asyncio.create_task(self.rotation.wait())
        try:
            await asyncio.wait((probe, rotate), return_when=asyncio.FIRST_COMPLETED)
            if self.force_rotate:
                return None
            report = await probe
            if report.get('ok') or confirming_failure:
                self.remember_check(item, {}, report)
            return report.get('proxy')
        finally:
            for task in (probe, rotate):
                if not task.cancelling():
                    task.cancel()
            await await_cleanup(asyncio.gather(probe, rotate, return_exceptions=True))

    def eligible(self, candidate):
        now = time.monotonic()
        self.excluded = {host: until for host, until in self.excluded.items() if until > now}
        return candidate.host not in self.excluded and self.history.eligible(candidate)

    def exclude(self, candidate, seconds=180):
        self.excluded[candidate.host] = max(self.excluded.get(candidate.host, 0), time.monotonic() + seconds)

    def nudge(self, rotate=False):
        if self.active:
            self.force_rotate |= rotate
            if rotate:
                self.rotation.set()
            self.wake.set()

    def browser_feedback(self, command, attempt, proxy, reason=None):
        """The host fences the session id. Match the exact native offer within it."""
        if (not self.active or self.force_rotate or type(attempt) is not int
                or attempt != self.offer_attempt or not isinstance(proxy, dict)
                or type(proxy.get('port')) is not int
                or proxy != {k: self.active[k] for k in ('scheme', 'host', 'port')}):
            return False
        if command == 'reject' and reason in ('country', 'invalid_trace', 'http',
                                               'timeout', 'transport', 'unknown'):
            self.browser_rejected += 1
            self.remember_check(Candidate(**proxy), {}, {'reason': reason})
            self.nudge(rotate=True)
        elif command == 'confirm' and self.wait_for_browser:
            self.quality.confirm(Candidate(**proxy), attempt)
            self.pool.refill_allowed.set()
            if attempt == self.confirmed_attempt:
                return True
            self.confirmed_attempt = attempt
            self.browser_confirmed += 1
        else:
            return False
        publish_snapshot = getattr(self.pool, 'publish_snapshot', None)
        if publish_snapshot is not None:
            publish_snapshot()
        return True

    async def pause(self, seconds):
        try:
            # Keep the wait in this task: Python 3.11 wait_for can consume
            # owner cancellation when its separate child finishes at once.
            async with asyncio.timeout(seconds):
                await self.wake.wait()
        except asyncio.TimeoutError:
            pass
        self.wake.clear()

    async def stop_pool(self):
        if self.pool_task:
            task = self.pool_task
            if not task.cancelling():
                task.cancel()
            try:
                await await_cleanup(asyncio.gather(task, return_exceptions=True))
            finally:
                if self.pool_task is task:
                    self.pool_task = None
                self.pool.checking = False
        self.pool.checking = False

    async def acquire(self):
        """Race a single fair discovery round with fresh reserve rechecks.

        Every owner is drained before an offer or a budget mode transition. A
        completed, unused success may refill the reserve, with its original
        monotonic completion time; cancelled work is never promoted as success.
        """
        if hasattr(self.pool, 'prune'):
            self.pool.prune()
        leases = list(self.pool.entries.values())
        clock = getattr(self.pool, 'clock', time.monotonic)
        ttl = getattr(self.pool, 'ttl', 90)
        successes = {}
        completed = asyncio.Queue()
        warnings = []

        def conflicts(left, right):
            method = getattr(self.pool, 'conflicts', None)
            return method(left, right) if method else (left['host'] == right['host'] or left['exitIp'] == right['exitIp'])

        def candidate_conflicts(item, other):
            method = getattr(self.pool, 'candidate_conflicts', None)
            return method(item, other) if method else item.host == other['host']

        def valid(proxy, at, lease=None):
            return (proxy is not None and clock() - at < ttl
                    and proxy.get('country') in self.countries
                    and self.eligible(Candidate(proxy['scheme'], proxy['host'], proxy['port']))
                    and not (self.previous and conflicts(proxy, self.previous))
                    and (lease is None or self.pool.recovery_evidence_valid(proxy, at, lease)))

        def eligible(item):
            return (self.eligible(item)
                    and not (self.previous and candidate_conflicts(item, self.previous))
                    and not any(candidate_conflicts(item, proxy) for proxy, _ in leases))

        def observed(proxy, at, *, lease=None):
            if proxy is not None:
                key = Candidate(proxy['scheme'], proxy['host'], proxy['port']).key
                successes[key] = (proxy, at, lease)

        async def scan(item, country, slow):
            report = await self.scan_report(item, country, slow)
            # Capture before run_round cancels/drains siblings. Its terminal
            # hook below only keeps genuinely completed (not cancelled) checks.
            if report.get('proxy'):
                report['_completed_at'] = clock()
            return report

        def terminal(item, observation, report):
            self.remember_check(item, observation, report)
            if report is not None and report.get('ok') and '_completed_at' in report:
                observed(report.get('proxy'), report['_completed_at'])

        def accept_search(proxy):
            # A healthy exit equal to the failed route is not an independent
            # replacement. Keep this round running for another country/address.
            return valid(proxy, clock())

        async def discover():
            self.emit({'phase': 'searching', 'proxy': None})
            return await self.search.run_round(
                scan, eligible,
                lambda phase, done, total: self.emit({'phase': phase, 'done': done, 'total': total}),
                on_result=accept_search, on_terminal=terminal,
                concurrency=8 if leases else 10)

        async def reserve():
            proxy = await self.pool.take(on_result=observed)
            return proxy, []

        tasks = [asyncio.create_task(reserve())] if leases else []
        tasks.append(asyncio.create_task(discover()))
        for task in tasks:
            task.add_done_callback(completed.put_nowait)
        winner, winner_evidence = None, None
        try:
            for _ in tasks:
                task = await completed.get()
                if task.cancelled():
                    continue
                try:
                    proxy, errors = task.result()
                except Exception:
                    warnings.append('Temporary recovery branch failure')
                    continue
                warnings.extend(errors)
                if proxy is not None:
                    key = Candidate(proxy['scheme'], proxy['host'], proxy['port']).key
                    evidence = successes.get(key, (proxy, clock(), None))
                    if valid(*evidence):
                        winner, winner_evidence = proxy, evidence
                        break
        finally:
            for task in tasks:
                if not task.done() and not task.cancelling():
                    task.cancel()
            await await_cleanup(asyncio.gather(*tasks, return_exceptions=True))
        # This is reached only by a live owner, after every sibling has stopped.
        # Keeping successes must not extend their lifetime by time spent cleanup.
        if winner is None or not valid(*winner_evidence):
            winner = next((proxy for proxy, at, lease in sorted(successes.values(), key=lambda row: row[1])
                           if valid(proxy, at, lease)), None)
        finish = getattr(self.pool, 'finish_recovery', None)
        if finish is not None:
            finish(winner, list(successes.values()))
        return winner, warnings

    async def run(self):
        failures = 0
        try:
            while True:
                if not self.active:
                    candidate_proxy, errors = await self.acquire()
                    if not candidate_proxy:
                        self.emit({'phase': 'empty', 'proxy': None, 'warnings': errors, 'retrySeconds': self.retry})
                        await self.pause(self.retry)
                        continue
                    await self.check_budget.set_active(True)
                    self.active = candidate_proxy
                    self.offer_attempt += 1
                    offered = Candidate(candidate_proxy['scheme'], candidate_proxy['host'], candidate_proxy['port'])
                    self.quality.native_offer(offered, self.offer_attempt)
                    if self.wait_for_browser:
                        self.pool.refill_allowed.clear()
                    failures = 0
                    self.force_rotate = False
                    self.rotation.clear()
                    self.wake.clear()
                    self.emit({'phase': 'connected', 'proxy': self.active})
                    self.pool_task = asyncio.create_task(self.pool.run())
                await self.pause(self.interval)
                candidate = Candidate(self.active['scheme'], self.active['host'], self.active['port'])
                result = None if self.force_rotate else await self.health(candidate, confirming_failure=failures > 0)
                # A browser rejection can arrive while the native health request is still in flight.
                if self.force_rotate:
                    result = None
                if result:
                    failures = 0
                    self.active = result
                    self.emit({'phase': 'connected', 'proxy': result})
                else:
                    failures += 1
                    if self.force_rotate or failures >= 2:
                        self.exclude(candidate)
                        await self.stop_pool()
                        self.previous = self.active
                        await self.check_budget.set_active(False)
                        self.active, self.force_rotate = None, False
                        self.emit({'phase': 'replacing', 'proxy': None, 'attempt': self.offer_attempt})
                        self.pool.publish()
                    else:
                        self.emit({'phase': 'confirming', 'proxy': self.active})
        finally:
            try:
                await self.stop_pool()
            finally:
                self.pool.entries.clear()
                self.search.clear_pending()
                await self.check_budget.close()
