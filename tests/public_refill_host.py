"""Real helper with one shared QA budget and offer-addressed two-stage health faults."""
import argparse
import asyncio
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from refill_observer import RefillJournal, fault_target
from native_probe_observer import NativeProbeObserver
from public_probe_journal import record_probe, probe_owner, attribution_call
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import core
import host


def monitor(directory, limit):
    counts = directory / 'started'
    started = int(counts.read_text()) if counts.exists() else 0
    NativeProbeObserver(core).attach()
    inspect = core.inspect_proxy
    async def bounded(candidate, country, slow=False, **kwargs):
        nonlocal started
        if started >= limit:
            (directory / 'budget-reached').touch()
            await asyncio.Future()
        started += 1
        number = started
        counts.write_text(str(started))
        caller_ns = time.monotonic_ns()
        context = probe_owner.get()
        attribution, owner = context if context is not None else (None, None)
        attribution_call(attribution, 'begin', number, candidate, owner)
        result, outcome = None, 'error'
        try:
            result = await inspect(candidate, country, slow, **kwargs)
            if isinstance(result, dict):
                result['_qaPublicProbeNumber'] = number
            outcome = 'passed' if result.get('ok') is True else 'failed'
            return result
        except asyncio.CancelledError:
            outcome = 'cancelled'
            raise
        finally:
            metadata = attribution_call(attribution, 'finish', number, result)
            record_probe(directory, number, candidate.scheme, bool(slow), outcome, result, caller_ns,
                         attribution=metadata, observer=attribution)
    core.inspect_proxy = bounded
    original = core.Session._budgeted
    async def faulted(self, item, country, slow, role):
        if role == 'health':
            try:
                raw = (directory / 'fault.json').read_text()
                target = json.loads(raw) if len(raw) <= 1024 else None
            except (FileNotFoundError, ValueError):
                target = None
            if fault_target(target, self, item):
                self.qa_refill_fault(target['stage'], self.offer_attempt)
                return {'ok': False, 'reason': 'connect', 'code': 7}
        return await original(self, item, country, slow, role)
    core.Session._budgeted = faulted
    journal, factory = RefillJournal(directory), host.Session
    host.Session = lambda *args, **kwargs: journal.attach(factory(*args, **kwargs))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('limit', type=int)
    args, _origin = parser.parse_known_args()
    monitor(args.directory, args.limit)
    asyncio.run(host.entry(args.directory / 'history'))
