"""Bounded, anonymous QA records for completed and interrupted public checks."""
import json
from contextvars import ContextVar
from native_probe_observer import project_native_probe

REASONS = frozenset(('connect', 'tls', 'transport', 'timeout', 'http', 'country',
                     'invalid_trace', 'unavailable', 'internal', 'unknown'))
ROLES = frozenset(('health', 'reserve', 'speculative', 'foreground', 'unknown'))
PURPOSES = frozenset(('health', 'refill', 'maintenance', 'promotion', 'discovery', 'unknown'))
SOURCE_GROUPS = frozenset(('proxy-scraper', 'hproxy', 'Proxifly', 'ProxyScrape', 'GeoNode',
                          'Litport', 'ProxMint', 'Databay', 'injected'))
probe_owner = ContextVar('qa_public_probe_owner', default=None)


def attribution_call(observer, method, *args):
    if observer is None:
        return None
    try:
        return getattr(observer, method)(*args)
    except Exception:
        observer.limited = True
        try:
            (observer.directory / 'probe-journal-error').touch(mode=0o600)
        except Exception:
            pass
        return None


def bounded_id(value, maximum=512, *, zero=False):
    return type(value) is int and (0 if zero else 1) <= value <= maximum


def project_owner(value):
    if not isinstance(value, dict) or value.get('role') not in ROLES or value.get('purpose') not in PURPOSES:
        raise ValueError('INVALID_PUBLIC_OWNER')
    result = {'role': value['role'], 'purpose': value['purpose']}
    for name in ('offerAttempt', 'refillRoundId', 'searchRoundId', 'maintenanceId', 'activeEndpointId', 'activeExitId'):
        field = value.get(name)
        if field is not None and not bounded_id(field, zero=name == 'offerAttempt'):
            raise ValueError('INVALID_PUBLIC_OWNER')
        result[name] = field
    return result


def project_attribution(value):
    if value is None:
        return None
    if not isinstance(value, dict) or not bounded_id(value.get('session'), 64):
        raise ValueError('INVALID_PUBLIC_ATTRIBUTION')
    out = {'session': value['session']}
    for name in ('endpointId', 'hostId', 'exitId'):
        field = value.get(name)
        if field is not None and not bounded_id(field):
            raise ValueError('INVALID_PUBLIC_ATTRIBUTION')
        out[name] = field
    if value.get('laneRole') not in ROLES or type(value.get('limited')) is not bool:
        raise ValueError('INVALID_PUBLIC_ATTRIBUTION')
    out.update(laneRole=value['laneRole'], firstOwner=project_owner(value.get('firstOwner')),
               limited=value['limited'])
    callers = value.get('logicalCallers')
    if not isinstance(callers, list) or not 1 <= len(callers) <= 8:
        raise ValueError('INVALID_PUBLIC_ATTRIBUTION')
    out['logicalCallers'] = [project_owner(row) for row in callers]
    if out['firstOwner'] not in out['logicalCallers']:
        raise ValueError('INVALID_PUBLIC_ATTRIBUTION')
    out['coalesced'] = len(callers) > 1
    if value.get('coalesced') is not out['coalesced']:
        raise ValueError('INVALID_PUBLIC_ATTRIBUTION')
    sources = value.get('sources')
    if not isinstance(sources, list) or len(sources) > 32 or value.get('sourceMode') not in ('unknown', 'terminal_group_union'):
        raise ValueError('INVALID_PUBLIC_ATTRIBUTION')
    out['sources'] = []
    for source in sources:
        if (not isinstance(source, dict) or source.get('group') not in SOURCE_GROUPS
                or not isinstance(source.get('country'), str) or len(source['country']) != 2
                or not source['country'].isascii() or not source['country'].isalpha() or not source['country'].isupper()):
            raise ValueError('INVALID_PUBLIC_SOURCE')
        row = {'group': source['group'], 'country': source['country']}
        if row in out['sources']:
            raise ValueError('INVALID_PUBLIC_SOURCE')
        out['sources'].append(row)
    out['sourceMode'] = value['sourceMode']
    if bool(out['sources']) != (out['sourceMode'] == 'terminal_group_union'):
        raise ValueError('INVALID_PUBLIC_SOURCE')
    return out


def save_record(directory, record):
    payload = json.dumps(record, allow_nan=False, separators=(',', ':')) + '\n'
    if len(payload.encode()) > 16384:
        raise ValueError('PUBLIC_PROBE_RECORD_LIMIT')
    path = directory / f'native-probe-{record["number"]:04d}.json'
    temp = path.with_suffix('.tmp')
    temp.write_text(payload)
    temp.replace(path)


class ProbeAttribution:
    """Read-only QA ownership, with bounded private identities and physical records.

    First-owner context survives task creation. Shared logical callers are added
    using the exact CheckBudget request object, never inferred from timestamps.
    Source unions are attached only from admitted candidates' terminal callbacks.
    """
    def __init__(self, session, number, directory):
        self.session, self.number, self.directory = session, number, directory
        self.endpoints, self.hosts, self.exits = {}, {}, {}
        self.owners, self.workers, self.records, self.metadata, self.search_probes = {}, {}, {}, {}, {}
        self.serial = 0
        self.limited = False

    def identity(self, mapping, key):
        if key is None:
            return None
        if key not in mapping:
            if len(mapping) >= 512:
                self.limited = True
                return None
            mapping[key] = len(mapping) + 1
        return mapping[key]

    def ids(self, proxy):
        if not isinstance(proxy, dict):
            return {'endpointId': None, 'hostId': None, 'exitId': None}
        key = tuple(proxy.get(name) for name in ('scheme', 'host', 'port'))
        return {'endpointId': self.identity(self.endpoints, key),
                'hostId': self.identity(self.hosts, proxy.get('host')),
                'exitId': self.identity(self.exits, proxy.get('exitIp'))}

    def enter(self, item, slow, role, purpose, refill=None, maintenance=None):
        if self.serial >= 512:
            self.limited = True
            return None
        self.serial += 1
        active = self.ids(self.session.active)
        owner = {'role': role, 'purpose': purpose, 'offerAttempt': self.session.offer_attempt,
                 'refillRoundId': refill, 'searchRoundId': (self.session.search.round_number or None)
                 if purpose in ('refill', 'discovery') else None,
                 'maintenanceId': maintenance, 'activeEndpointId': active['endpointId'], 'activeExitId': active['exitId']}
        request = self.session.check_budget._requests.get((item.key, bool(slow)))
        if (self.session.check_budget._transitioning or
                request is not None and request.task.cancelling()):
            request = None  # CheckBudget waits for cleanup instead of joining this request.
        entry = {'id': self.serial, 'owner': owner, 'request': request,
                 'key': (item.scheme, item.host, item.port)}
        self.owners[self.serial] = entry
        if request is not None:
            worker = self.workers.get(id(request))
            if worker is not None and worker[0] is request:
                self.add_caller(worker[1], owner)
        return entry

    def leave(self, entry):
        if entry is not None:
            self.owners.pop(entry['id'], None)

    def begin(self, number, item, entry):
        if entry is None or len(self.metadata) >= 360:
            self.limited = True
            return None
        request = self.session.check_budget._running.get(item.key)
        # The operation retains its creator's context even if that logical
        # owner left while the shared request was still queued.
        candidates = [entry['owner']] + [value['owner'] for value in self.owners.values()
                      if value is not entry and request is not None and value['request'] is request]
        ids = self.ids({'scheme': item.scheme, 'host': item.host, 'port': item.port})
        value = {'session': self.number, **ids, 'laneRole': getattr(request, 'role', 'unknown'),
                 'firstOwner': entry['owner'], 'logicalCallers': candidates[:8],
                 'coalesced': len(candidates[:8]) > 1, 'limited': self.limited or len(candidates) > 8,
                 'sources': [], 'sourceMode': 'unknown'}
        self.metadata[number] = value
        if request is not None:
            self.workers[id(request)] = (request, number)  # Strong ref prevents object-id reuse.
        round_id = entry['owner']['searchRoundId']
        if ids['endpointId'] is not None and round_id is not None and entry['owner']['purpose'] in ('refill', 'discovery'):
            self.search_probes.setdefault((round_id, ids['endpointId']), []).append(number)
        return value

    def add_caller(self, number, owner):
        value = self.metadata[number]
        if any(existing is owner for existing in value['logicalCallers']):
            return
        if len(value['logicalCallers']) < 8:
            value['logicalCallers'].append(owner)
            value['coalesced'] = True
        else:
            value['limited'] = True
        if owner['purpose'] in ('refill', 'discovery') and owner['searchRoundId'] is not None:
            numbers = self.search_probes.setdefault((owner['searchRoundId'], value['endpointId']), [])
            if number not in numbers:
                numbers.append(number)
        self.rewrite(number)

    def bind_result(self, entry, result):
        # A caller which waited through abandoned-work cleanup may attach to a
        # new request after enter(). Only the exact returned physical result can
        # close that late attribution; cancellation stays unknown.
        number = result.get('_qaPublicProbeNumber') if isinstance(result, dict) else None
        if (entry is not None and type(number) is int and number in self.metadata
                and self.metadata[number]['endpointId'] == self.endpoints.get(entry['key'])):
            self.add_caller(number, entry['owner'])

    def finish(self, number, result):
        value = self.metadata.get(number)
        if value is not None:
            proxy = result.get('proxy') if isinstance(result, dict) else None
            if proxy is not None:
                value['exitId'] = self.ids(proxy)['exitId']
            value['limited'] |= self.limited
        return value

    def remember(self, record):
        if len(self.records) < 360:
            self.records[record['number']] = record

    def rewrite(self, number):
        if number not in self.records:
            return
        try:
            self.records[number]['attribution'] = project_attribution(self.metadata[number])
            save_record(self.directory, self.records[number])
        except Exception:
            try:
                (self.directory / 'probe-journal-error').touch(mode=0o600)
            except Exception:
                pass

    def sources(self, item, round_id, observation):
        endpoint_id = self.endpoints.get((item.scheme, item.host, item.port))
        if endpoint_id is None:
            return
        for number in self.search_probes.get((round_id, endpoint_id), ()):
            value = self.metadata[number]
            for source in observation.get('sources', ()):
                group, country = source.get('group'), source.get('requestedCountry')
                if group not in SOURCE_GROUPS or country not in self.session.countries:
                    value['limited'] = True
                    continue
                row = {'group': group, 'country': country}
                if row not in value['sources']:
                    if len(value['sources']) < 32:
                        value['sources'].append(row)
                    else:
                        value['limited'] = True
            if value['sources']:
                value['sourceMode'] = 'terminal_group_union'
            self.rewrite(number)


def record_probe(directory, *args, attribution=None, observer=None):
    """Instrumentation failure must never replace a product result or cancellation."""
    try:
        record = write_probe(directory, *args, attribution=attribution)
        if observer is not None:
            observer.remember(record)
        return True
    except Exception:
        try:
            (directory / 'probe-journal-error').touch(mode=0o600)
        except Exception:
            # Final collection also checks contiguous coverage against started.
            pass
        return False


def write_probe(directory, number, scheme, slow, outcome, result, caller_ns, *, attribution=None):
    if type(number) is not int or not 1 <= number <= 360:
        raise ValueError('INVALID_PUBLIC_PROBE_NUMBER')
    if scheme not in ('http', 'https', 'socks4', 'socks5') or type(slow) is not bool:
        raise ValueError('INVALID_PUBLIC_PROBE_MODE')
    if outcome not in ('passed', 'failed', 'cancelled', 'error'):
        raise ValueError('INVALID_PUBLIC_PROBE_OUTCOME')
    reason = result.get('reason') if isinstance(result, dict) else None
    probe = result.get('_qaProbe') if isinstance(result, dict) else None
    record = {'number': number, 'scheme': scheme, 'slow': slow, 'outcome': outcome,
              'reason': reason if reason in REASONS else None,
              'nativeProbe': project_native_probe(probe, caller_ns) if probe is not None else None}
    if attribution is not None:
        record['attribution'] = project_attribution(attribution)
    save_record(directory, record)
    return record
