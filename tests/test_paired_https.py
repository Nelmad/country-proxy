"""Completed paired controls must retain explicit country rejection evidence."""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import core
from check_budget import SupplementalBudget
from host import encode, receive, status_message


ITEM = core.Candidate('http', '8.8.8.8', 3128)
SELECTED = ('AT', 'EE', 'NO')
ORDERS = (('target', 'trace'), ('trace', 'target'))


def trace(country='NO', ip='9.9.9.9'):
    return 0, '200', f'loc={country}\nip={ip}\n'


class PairedHTTPS(unittest.IsolatedAsyncioTestCase):
    async def paired_report(self, order, trace_answer, target_answer):
        ready = asyncio.Event()
        controls, completed, transfers = {}, [], []

        async def curl(url, *_):
            name = 'trace' if url == core.TRACE else 'target'
            transfers.append(asyncio.current_task())
            controls[name] = asyncio.get_running_loop().create_future()
            if len(controls) == 2:
                ready.set()
            answer = await controls[name]
            completed.append(name)
            return answer

        with patch.object(core, 'curl', curl):
            owner = asyncio.create_task(core.inspect_proxy(ITEM, SELECTED, slow=True))
            try:
                await asyncio.wait_for(ready.wait(), 1)
                # Resolve both before yielding: only completion order changes,
                # and both control results exist when aggregation resumes.
                answers = {'trace': trace_answer, 'target': target_answer}
                for name in order:
                    controls[name].set_result(answers[name])
                report = await asyncio.wait_for(owner, 1)
                self.assertEqual(completed, list(order))
                self.assertTrue(all(task.done() for task in transfers))
                return report
            finally:
                owner.cancel()
                await asyncio.gather(owner, return_exceptions=True)

    async def test_completed_country_negative_beats_target_timeout_in_both_orders(self):
        for order in ORDERS:
            with self.subTest(order=order):
                report = await self.paired_report(order, trace('JP'), (28, '000', ''))
                self.assertEqual((report['ok'], report['reason'], report['endpoint'], report.get('country')),
                                 (False, 'country', 'trace', 'JP'))
                self.assertNotIn('proxy', report)

    async def test_allowed_trace_does_not_mask_target_timeout(self):
        for country in SELECTED:
            for order in ORDERS:
                with self.subTest(country=country, order=order):
                    report = await self.paired_report(order, trace(country), (28, '000', ''))
                    self.assertEqual((report['reason'], report['endpoint']), ('timeout', 'target'))
                    self.assertNotIn('proxy', report)

    async def test_invalid_trace_cannot_supply_country_evidence_or_success(self):
        for order in ORDERS:
            with self.subTest(order=order):
                report = await self.paired_report(order, trace('JP', '127.0.0.1'), (28, '000', ''))
                self.assertFalse(report['ok'])
                self.assertIn(report['reason'], ('timeout', 'invalid_trace'))
                self.assertNotIn('country', report)
                self.assertNotIn('proxy', report)
        report = await self.paired_report(ORDERS[0], trace('JP', '127.0.0.1'), (0, '204', ''))
        self.assertEqual((report['reason'], report['endpoint']), ('invalid_trace', 'trace'))

    async def test_both_https_controls_and_certificates_remain_required(self):
        for country in SELECTED:
            for order in ORDERS:
                with self.subTest(country=country, order=order):
                    report = await self.paired_report(order, trace(country), (0, '204', ''))
                    self.assertTrue(report['ok'])
                    self.assertEqual(report['proxy']['country'], country)
        for endpoint in ('trace', 'target'):
            for order in ORDERS:
                with self.subTest(endpoint=endpoint, order=order):
                    report = await self.paired_report(order,
                        (60, '000', '') if endpoint == 'trace' else trace(),
                        (60, '000', '') if endpoint == 'target' else (0, '204', ''))
                    self.assertEqual((report['reason'], report['endpoint'], report['code']),
                                     ('tls', endpoint, 60))
                    self.assertNotIn('proxy', report)

    async def test_pending_trace_is_cancelled_promptly_and_drained_before_return(self):
        entered, cancelling, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        transfers = []

        async def curl(url, *_):
            transfers.append(asyncio.current_task())
            if url == core.TARGET:
                await entered.wait()
                return 28, '000', ''
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cancelling.set()
                await release.wait()

        with patch.object(core, 'curl', curl):
            owner = asyncio.create_task(core.inspect_proxy(ITEM, SELECTED, slow=True))
            try:
                # No trace result can arrive: fail fast must start cancellation
                # rather than wait for another network response or deadline.
                await asyncio.wait_for(cancelling.wait(), .5)
                self.assertFalse(owner.done(), 'return must wait for owned transfer cleanup')
                release.set()
                report = await asyncio.wait_for(owner, .5)
                self.assertEqual((report['reason'], report['endpoint']), ('timeout', 'target'))
                self.assertTrue(all(task.done() for task in transfers))
            finally:
                release.set()
                owner.cancel()
                await asyncio.gather(owner, return_exceptions=True)

    async def test_owner_cancellation_drains_both_pending_controls(self):
        entered, cleanup, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        transfers, drained = [], []

        async def curl(url, *_):
            transfers.append(asyncio.current_task())
            if len(transfers) == 2:
                entered.set()
            try:
                await asyncio.Future()
            finally:
                cleanup.set()
                await release.wait()
                drained.append(url)

        with patch.object(core, 'curl', curl):
            owner = asyncio.create_task(core.inspect_proxy(ITEM, SELECTED, slow=True))
            try:
                await asyncio.wait_for(entered.wait(), 1)
                owner.cancel()
                await asyncio.wait_for(cleanup.wait(), 1)
                owner.cancel()
                await asyncio.sleep(0)
                self.assertFalse(owner.done())
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(owner, 1)
                self.assertCountEqual(drained, [core.TRACE, core.TARGET])
                self.assertTrue(all(task.done() for task in transfers))
            finally:
                release.set()
                owner.cancel()
                await asyncio.gather(owner, return_exceptions=True)

    async def test_session_host_frames_keep_same_country_rejection_for_both_orders(self):
        for country in SELECTED:
            for order in ORDERS:
                with self.subTest(country=country, order=order):
                    await self.session_host_report(country, order)

    async def test_completed_extra_country_beats_primary_tls_in_both_orders(self):
        for order in (('primary', 'extra'), ('extra', 'primary')):
            with self.subTest(order=order):
                controls = {}
                ready = asyncio.Event()
                budget = SupplementalBudget()
                transfers = []

                async def curl(url, *_):
                    transfers.append(asyncio.current_task())
                    if url == core.TARGET:
                        return 0, '204', ''
                    name = 'primary' if not controls else 'extra'
                    controls[name] = asyncio.get_running_loop().create_future()
                    if len(controls) == 2:
                        ready.set()
                    return await controls[name]

                with (patch.object(core, 'curl', curl),
                      patch.object(core, 'RESERVE_EXTRA_DELAY', .001)):
                    owner = asyncio.create_task(core.inspect_proxy(ITEM, SELECTED, True, extras=budget))
                    try:
                        await asyncio.wait_for(ready.wait(), 1)
                        answers = {'primary': (60, '000', ''), 'extra': trace('JP')}
                        for name in order:
                            controls[name].set_result(answers[name])
                        report = await asyncio.wait_for(owner, 1)
                        self.assertEqual((report['reason'], report['endpoint'], report.get('country')),
                                         ('country', 'trace', 'JP'))
                        self.assertTrue(all(task.done() for task in transfers))
                        self.assertEqual(budget.running, 0)
                    finally:
                        owner.cancel()
                        await asyncio.gather(owner, return_exceptions=True)

    async def test_target_timeout_cannot_hide_country_while_trace_control_drains(self):
        cleanup, release = asyncio.Event(), asyncio.Event()
        budget = SupplementalBudget()
        trace_calls = 0
        transfers = {}

        async def curl(url, *_):
            nonlocal trace_calls
            if url == core.TARGET:
                transfers['target'] = asyncio.current_task()
                await cleanup.wait()
                return 28, '000', ''
            trace_calls += 1
            if trace_calls > 1:
                return trace('JP')
            transfers['primary'] = asyncio.current_task()
            try:
                await asyncio.Future()
            finally:
                cleanup.set()
                await release.wait()

        with (patch.object(core, 'curl', curl),
              patch.object(core, 'RESERVE_EXTRA_DELAY', .001)):
            owner = asyncio.create_task(core.inspect_proxy(ITEM, SELECTED, True, extras=budget))
            try:
                await asyncio.wait_for(cleanup.wait(), 1)
                async with asyncio.timeout(1):
                    while not transfers['target'].done():
                        await asyncio.sleep(0)
                self.assertFalse(owner.done())
                release.set()
                report = await asyncio.wait_for(owner, 1)
                self.assertEqual((report['reason'], report['endpoint'], report.get('country')),
                                 ('country', 'trace', 'JP'))
                self.assertTrue(all(task.done() for task in transfers.values()))
                self.assertEqual(budget.running, 0)
            finally:
                release.set()
                owner.cancel()
                await asyncio.gather(owner, return_exceptions=True)

    async def test_country_evidence_survives_deadline_while_losing_transfer_drains(self):
        cleanup, target_cancelled, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        budget = SupplementalBudget()
        transfers = []
        trace_calls = 0

        async def curl(url, *_):
            nonlocal trace_calls
            transfers.append(asyncio.current_task())
            if url == core.TARGET:
                try:
                    await asyncio.Future()
                finally:
                    target_cancelled.set()
            trace_calls += 1
            if trace_calls > 1:
                return trace('JP')
            try:
                await asyncio.Future()
            finally:
                cleanup.set()
                await release.wait()

        with (patch.object(core, 'curl', curl),
              patch.object(core, 'RESERVE_EXTRA_DELAY', .001),
              patch.object(core, 'RESERVE_PROBE_TIMEOUT', .03)):
            owner = asyncio.create_task(core.inspect_proxy(ITEM, SELECTED, True, extras=budget))
            try:
                await asyncio.wait_for(cleanup.wait(), 1)
                # The unchanged shared deadline must cancel the pending target
                # even though trace cleanup has not returned its control result.
                await asyncio.wait_for(target_cancelled.wait(), .5)
                self.assertFalse(owner.done())
                release.set()
                report = await asyncio.wait_for(owner, 1)
                self.assertEqual((report['reason'], report['endpoint'], report.get('country')),
                                 ('country', 'trace', 'JP'))
                self.assertTrue(all(task.done() for task in transfers))
                self.assertEqual(budget.running, 0)
            finally:
                release.set()
                owner.cancel()
                await asyncio.gather(owner, return_exceptions=True)

    async def session_host_report(self, country, order):
        events = asyncio.Queue()
        ready = asyncio.Event()
        controls = {}
        mode = 'initial'

        async def discover(_):
            return [ITEM], []

        async def curl(url, *_):
            if mode == 'initial':
                return trace(country) if url == core.TRACE else (0, '204', '')
            name = 'trace' if url == core.TRACE else 'target'
            controls[name] = asyncio.get_running_loop().create_future()
            if len(controls) == 2:
                ready.set()
            return await controls[name]

        def emit(event):
            if event['phase'] in ('connected', 'confirming', 'replacing'):
                events.put_nowait(status_message('paired-session', SELECTED, event))

        with patch.object(core, 'curl', curl):
            session = core.Session(SELECTED, emit, discoverer=discover, interval=60)
            session.wait_for_browser = True
            owner = asyncio.create_task(session.run())
            try:
                first = await asyncio.wait_for(events.get(), 2)
                address = {key: first['proxy'][key] for key in ('scheme', 'host', 'port')}
                self.assertTrue(session.browser_feedback('confirm', first['attempt'], address))
                mode = 'paired'
                session.nudge()
                await asyncio.wait_for(ready.wait(), 1)
                answers = {'trace': trace('JP'), 'target': (28, '000', '')}
                for name in order:
                    controls[name].set_result(answers[name])
                event = await asyncio.wait_for(events.get(), 1)
                reader = asyncio.StreamReader()
                reader.feed_data(encode(event))
                reader.feed_eof()
                frame = await receive(reader)
                self.assertEqual((frame['id'], frame['phase'], frame['attempt']),
                                 ('paired-session', 'confirming', first['attempt']))
                self.assertEqual(frame['proxy'], first['proxy'])
                self.assertEqual(frame['country'], country)
                self.assertEqual(frame['countries'], list(SELECTED))
                self.assertEqual(frame['health'],
                                 {'ok': False, 'reason': 'country', 'endpoint': 'trace', 'country': 'JP'})
            finally:
                owner.cancel()
                await asyncio.gather(owner, return_exceptions=True)
