import json
import asyncio
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from public_probe_journal import write_probe, record_probe


class PublicProbeJournalTest(unittest.TestCase):
    def test_instrumentation_failure_is_flagged_without_replacing_result(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            with patch('public_probe_journal.write_probe',side_effect=OSError('PRIVATE')):
                self.assertFalse(record_probe(root,1,'http',False,'passed',{'ok':True},0))
            self.assertTrue((root/'probe-journal-error').exists())
            self.assertEqual((root/'probe-journal-error').read_text(),'')
            with patch('public_probe_journal.write_probe',side_effect=OSError('PRIVATE')), \
                    patch.object(Path,'touch',side_effect=OSError('PRIVATE')):
                self.assertFalse(record_probe(root,1,'http',False,'cancelled',None,0))

    def test_projection_never_writes_raw_result_or_address(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            write_probe(root, 1, 'socks4', True, 'failed',
                        {'reason':'tls','host':'PRIVATE','body':'PRIVATE'}, 0)
            text=(root/'native-probe-0001.json').read_text()
            self.assertNotIn('PRIVATE',text)
            self.assertEqual(json.loads(text),{'number':1,'scheme':'socks4','slow':True,
                'outcome':'failed','reason':'tls','nativeProbe':None})
            self.assertFalse(list(root.glob('*.tmp')))
            write_probe(root,2,'http',False,'cancelled',None,0)
            self.assertEqual(json.loads((root/'native-probe-0002.json').read_text())['outcome'],'cancelled')

    def test_invalid_bounds_and_enums_fail_before_write(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for number,scheme,slow,outcome in [(0,'http',True,'failed'),(361,'http',True,'failed'),
                    (True,'http',True,'failed'),(1,'PRIVATE',True,'failed'),
                    (1,'http',1,'failed'),(1,'http',True,'PRIVATE')]:
                with self.assertRaises(ValueError):
                    write_probe(root,number,scheme,slow,outcome,{'reason':'PRIVATE'},0)
            self.assertEqual(list(root.iterdir()),[])


class PublicProbeLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_actual_host_wrapper_preserves_success_and_cancel_on_journal_error(self):
        import public_refill_host as public
        core=public.core
        hold=asyncio.Event()
        async def inspect(candidate, *args, **kwargs):
            if candidate.port==2:
                hold.set()
                await asyncio.Future()
            return {'ok':True}
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(core,'inspect_proxy',inspect), patch.object(core,'process',core.process), \
                patch.object(core.Session,'_budgeted',core.Session._budgeted), \
                patch.object(public.host,'Session',public.host.Session), \
                patch('public_probe_journal.write_probe',side_effect=OSError('PRIVATE')):
            root=Path(folder)
            public.monitor(root,2)
            result=await core.inspect_proxy(core.Candidate('http','192.0.2.1',1),['AT','EE','NO'])
            self.assertTrue(result['ok'])
            task=asyncio.create_task(core.inspect_proxy(core.Candidate('http','192.0.2.1',2),['AT','EE','NO']))
            await asyncio.wait_for(hold.wait(),1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual((root/'started').read_text(),'2')
            self.assertTrue((root/'probe-journal-error').exists())
