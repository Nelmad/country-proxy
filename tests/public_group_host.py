"""Run the production host with a finite test budget and an optional fault on one health check."""
import argparse
import asyncio
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from offer_observer import OfferJournal
from native_probe_observer import NativeProbeObserver

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import core
import host


def monitor(directory, limit, *, observe_offers=False):
    # Each native physical check requires two HTTPS controls (optional bounded extras). Count starts, including
    # cancelled checks. Preserve the same cap if Chrome relaunches the native host.
    counts = directory / 'started'
    started = int(counts.read_text()) if counts.exists() else 0
    if observe_offers:
        NativeProbeObserver(core).attach()
    inspect = core.inspect_proxy
    fault = directory / 'fault'
    async def bounded(candidate, country, slow=False, **kwargs):
        nonlocal started
        if started >= limit:
            (directory / 'budget-reached').touch()
            # Normal Stop cancels any requests waiting here. Do not invent endpoint failures.
            await asyncio.Future()
        started += 1
        counts.write_text(str(started))
        return await inspect(candidate, country, slow, **kwargs)
    core.inspect_proxy = bounded
    original = core.Session._budgeted
    async def with_local_health_fault(self, item, country, slow, role):
        if role == 'health' and fault.exists() and item.key == fault.read_text():
            # Only the isolated helper's health observations of A fail. Production
            # timers, confirmation threshold, pool and all browser requests run normally.
            with (directory / 'health-faults').open('a') as stream:
                stream.write(f'{time.time_ns() // 1_000_000}\n')
            if observe_offers:
                self.qa_injected_health_fault(self.offer_attempt)
            return {'ok': False, 'reason': 'connect', 'code': 7}
        return await original(self, item, country, slow, role)
    core.Session._budgeted = with_local_health_fault
    if observe_offers:
        journal = OfferJournal(directory)
        session_factory = host.Session
        def observed_session(*args, **kwargs):
            return journal.attach(session_factory(*args, **kwargs))
        host.Session = observed_session


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('limit', type=int)
    args, _origin = parser.parse_known_args()
    monitor(args.directory, args.limit, observe_offers=True)
    asyncio.run(host.entry(args.directory / 'history'))
