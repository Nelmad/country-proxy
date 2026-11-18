"""Wake completion cannot consume a session or reserve owner's cancellation."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from core import Candidate, Session
from pool import ReservePool
from core import process
from library_source import URLS, verified_fetch


class ObservedEvent(asyncio.Event):
    """Signal precisely when the real wait starts and completes, without sleeps."""
    def __init__(self):
        super().__init__()
        self.entered = asyncio.Event()
        self.completed = asyncio.Event()

    async def wait(self):
        self.entered.set()
        result = await super().wait()
        self.completed.set()
        return result


class WaitCancellation(unittest.IsolatedAsyncioTestCase):
    async def assert_wake_cancel(self, operation, event):
        task = asyncio.create_task(operation())
        try:
            async with asyncio.timeout(1):
                await event.entered.wait()
                event.set()
                await event.completed.wait()
            # The wait's result is ready in this turn. A separate wait_for
            # child can swallow cancellation here on Python 3.11.
            task.cancel()
            done, _ = await asyncio.wait({task}, timeout=.2)
            self.assertIn(task, done, 'owner ignored its first cancellation')
            self.assertTrue(task.cancelled(), 'owner completed after cancellation')
        finally:
            # Cleanup follows the assertions; a second cancel cannot make the
            # cancellation regression pass accidentally.
            if not task.done():
                task.cancel()
            done, _ = await asyncio.wait({task}, timeout=1)
            self.assertIn(task, done, 'failed regression did not drain')
            await asyncio.gather(task, return_exceptions=True)

    def pool(self):
        async def discover(_):
            return [], []
        async def check(*_):
            return None
        return ReservePool('EE', discover, check, lambda: None,
                           lambda _: True, lambda *_: None, lambda *_: None,
                           interval=60)

    async def test_session_pause_wake_cannot_consume_owner_cancel(self):
        session = Session('EE', lambda _: None)
        session.wake = event = ObservedEvent()
        async def run():
            while True:
                await session.pause(60)
        await self.assert_wake_cancel(run, event)
        await session.check_budget.close()

    async def test_reserve_maintenance_wake_cannot_consume_owner_cancel(self):
        pool = self.pool()
        item = Candidate('http', '8.8.8.8', 80)
        pool.accept(dict(scheme=item.scheme, host=item.host, port=item.port,
                         country='EE', exitIp=item.host, latencyMs=1, checkedAt=1))
        pool._changed = event = ObservedEvent()
        await self.assert_wake_cancel(pool._maintain, event)

    async def test_reserve_refill_wake_cannot_consume_owner_cancel(self):
        pool = self.pool()
        pool._refill_needed = event = ObservedEvent()
        await self.assert_wake_cancel(pool._refill_loop, event)

    async def test_session_pause_consumes_wake_and_times_out_again(self):
        session = Session('EE', lambda _: None)
        session.wake.set()
        await session.pause(60)
        self.assertFalse(session.wake.is_set())
        task = asyncio.create_task(session.pause(.01))
        await asyncio.sleep(0)
        self.assertFalse(task.done(), 'old wake bypassed the next deadline')
        done, _ = await asyncio.wait({task}, timeout=1)
        self.assertIn(task, done)
        self.assertIsNone(task.result())
        self.assertFalse(session.wake.is_set())
        await session.check_budget.close()

    async def test_nonpositive_catalogue_budget_does_not_open_connection(self):
        async def connect(*args, **kwargs):
            self.fail('expired budget opened a catalogue connection')
        with patch('asyncio.open_connection', connect):
            for timeout in (0, -1):
                with self.subTest(timeout=timeout), self.assertRaises(TimeoutError):
                    await verified_fetch(next(iter(URLS)), timeout)

    async def test_nonpositive_process_budget_reaps_before_reading(self):
        for timeout in (0, -1):
            with self.subTest(timeout=timeout):
                calls = []
                class Pipe:
                    async def read(self, _):
                        calls.append('read')
                        return b''
                class Child:
                    returncode = None
                    stdout = Pipe()
                    def kill(self):
                        calls.append('kill')
                        self.returncode = -9
                    async def wait(self):
                        calls.append('wait')
                        return self.returncode
                async def launch(*args, **kwargs):
                    calls.append('launch')
                    return Child()
                with patch('asyncio.create_subprocess_exec', launch):
                    with self.assertRaises(TimeoutError):
                        await process(['unused'], timeout)
                self.assertEqual(calls, ['launch', 'kill', 'read', 'wait'])


if __name__ == '__main__':
    unittest.main()
