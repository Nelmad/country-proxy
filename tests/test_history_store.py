import asyncio
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'native'))
from core import Candidate
from history import EndpointHistory
import history_store as disk


class StoreFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.data = self.root/'history'

    def model(self):
        history = EndpointHistory()
        history.seen(Candidate('http', '8.8.8.8', 8080), ('fixture',))
        return history

    def store(self):
        store = disk.FileHistoryStore(self.data)
        self.addCleanup(store.close)
        return store

    def write(self, raw, mode=0o600):
        path = self.data/disk.HISTORY
        path.write_bytes(raw)
        path.chmod(mode)
        return path


class FileStoreTests(StoreFixture, unittest.TestCase):
    def test_roundtrip_private_atomic_unique_files_and_exact_clear(self):
        store = self.store()
        document = self.model().snapshot()
        self.assertTrue(store.save(document))
        self.assertEqual(store.load(), document)
        self.assertEqual(self.data.stat().st_mode & 0o777, 0o700)
        for name in (disk.HISTORY, disk.LOCK):
            self.assertEqual((self.data/name).stat().st_mode & 0o777, 0o600)
        unrelated = self.data/'unrelated.txt'
        unrelated.write_text('keep')
        stale = self.data/('.endpoint-history-'+'a'*32+'.tmp')
        stale.write_text('stale')
        stale.chmod(0o600)
        self.assertEqual(store.clear(), 2)
        self.assertTrue(unrelated.exists())
        self.assertTrue((self.data/disk.LOCK).exists())
        self.assertEqual(sorted(p.name for p in self.data.iterdir()), [disk.LOCK, 'unrelated.txt'])

    def test_second_process_cannot_get_writer_lease_or_clear(self):
        store = self.store()
        code = "import sys;sys.path.insert(0,sys.argv[1]);from history_store import FileHistoryStore;s=FileHistoryStore(sys.argv[2]);print(s.mode);s.close()"
        result = subprocess.run([sys.executable, '-I', '-B', '-c', code,
                                 str(Path(disk.__file__).parent), str(self.data)],
                                capture_output=True, text=True, check=True, timeout=10)
        self.assertEqual(result.stdout.strip(), 'busy')
        other = disk.FileHistoryStore(self.data)
        try:
            self.assertEqual(other.mode, 'busy')
            with self.assertRaises(BlockingIOError):
                other.clear()
        finally:
            other.close()
        store.close()
        replacement = self.store()
        self.assertEqual(replacement.mode, 'persistent')

    def test_rejects_symlink_ancestors_relative_sensitive_home_and_source_paths(self):
        link = self.root/'link'
        link.symlink_to(self.root, target_is_directory=True)
        cases = [link/'child', Path('relative'), self.root/'.git'/'cache',
                 self.root/'.ssh', Path.home(), disk.SOURCE_ROOT/'native/cache']
        for path in cases:
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                disk.checked_directory(path, create=True)
        self.assertFalse((self.root/'child').exists())

    def test_existing_directory_permissions_never_repaired(self):
        self.data.mkdir(mode=0o755)
        with self.assertRaisesRegex(ValueError, '0700'):
            disk.FileHistoryStore(self.data)
        self.assertEqual(self.data.stat().st_mode & 0o777, 0o755)

    def test_foreign_owner_and_unsafe_lock_are_rejected(self):
        self.data.mkdir(mode=0o700)
        with patch.object(disk.os, 'getuid', return_value=os.getuid()+1):
            with self.assertRaisesRegex(ValueError, 'owner'):
                disk.FileHistoryStore(self.data)
        (self.data/disk.LOCK).write_bytes(b'')
        (self.data/disk.LOCK).chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'owner-only'):
            disk.FileHistoryStore(self.data)
        self.assertEqual((self.data/disk.LOCK).stat().st_mode & 0o777, 0o644)

    def test_file_permissions_symlinks_hardlinks_and_fifo_rejected_before_read(self):
        store = self.store()
        victim = self.root/'victim'
        victim.write_bytes(b'secret')
        path = self.data/disk.HISTORY
        path.symlink_to(victim)
        with self.assertRaises(ValueError):
            store.load()
        path.unlink()
        os.link(victim, path)
        with self.assertRaises(ValueError):
            store.load()
        path.unlink()
        os.mkfifo(path, 0o600)
        with self.assertRaises(ValueError):
            store.load()
        path.unlink()
        self.write(b'{}', 0o644)
        with self.assertRaises(ValueError):
            store.load()
        self.assertEqual(victim.read_bytes(), b'secret')

    def test_oversize_is_checked_before_read_and_corrupt_json_loads_cold(self):
        store = self.store()
        path = self.write(b'')
        with path.open('wb') as stream:
            stream.truncate(disk.MAX_BYTES+1)
        with patch.object(disk.os, 'fdopen', side_effect=AssertionError('must not read')):
            self.assertIsNone(store.load())
        self.write(b'{corrupt')
        self.assertIsNone(store.load())
        self.write(b'{"schemaVersion":1,"schemaVersion":2}')
        self.assertIsNone(store.load())
        store.save(self.model().snapshot())
        self.assertIsNotNone(store.load())

    def test_diskfull_rename_and_permission_failure_preserve_previous_snapshot(self):
        store = self.store()
        original = self.model().snapshot()
        store.save(original)
        before = (self.data/disk.HISTORY).read_bytes()
        for operation, failure in [('fsync', OSError(errno.ENOSPC, 'disk full')),
                                    ('replace', OSError(errno.EIO, 'rename failed')),
                                    ('open', PermissionError(errno.EACCES, 'denied'))]:
            with self.subTest(operation=operation), patch.object(disk.os, operation, side_effect=failure):
                with self.assertRaises(OSError):
                    store.save(original)
            self.assertEqual((self.data/disk.HISTORY).read_bytes(), before)
            self.assertFalse(any(disk.TEMP.fullmatch(p.name) for p in self.data.iterdir()))

    def test_changed_directory_or_hostile_clear_target_is_preserved(self):
        store = self.store()
        self.write(b'{}')
        hostile = self.data/('.endpoint-history-'+'a'*32+'.tmp')
        hostile.symlink_to(self.root/'victim')
        with self.assertRaises(ValueError):
            store.clear()
        self.assertTrue((self.data/disk.HISTORY).exists())
        hostile.unlink()
        self.data.rename(self.root/'moved')
        self.data.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, 'changed'):
            store.save(self.model().snapshot())
        self.assertEqual(list(self.data.iterdir()), [])

    def test_cleanup_cli_is_exact_and_refuses_an_active_lease(self):
        store = self.store()
        store.save(self.model().snapshot())
        command = [sys.executable, '-I', '-B', str(disk.SOURCE_ROOT/'scripts/history.py'),
                   'clear', '--data-dir', str(self.data)]
        busy = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(busy.returncode, 0)
        self.assertTrue((self.data/disk.HISTORY).exists())
        store.close()
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.data/disk.HISTORY).exists())


class PersistenceTests(StoreFixture, unittest.IsolatedAsyncioTestCase):
    async def test_open_cancel_waits_for_thread_and_releases_lease(self):
        started, release = threading.Event(), threading.Event()
        actual_open = disk.FileHistoryStore
        def slow_open(path):
            store = actual_open(path)
            started.set()
            if not release.wait(3):
                store.close()
                raise AssertionError('open did not release')
            return store
        with patch.object(disk, 'FileHistoryStore', side_effect=slow_open):
            task = asyncio.create_task(disk.HistoryPersistence.open(self.data, self.model()))
            await asyncio.wait_for(asyncio.to_thread(started.wait), 1)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        replacement = self.store()
        self.assertEqual(replacement.mode, 'persistent')

    async def test_memory_and_busy_do_not_read_or_write(self):
        model = self.model()
        with patch.object(disk, 'FileHistoryStore', side_effect=AssertionError('memory does no I/O')):
            memory = await disk.HistoryPersistence.open(None, model)
            self.assertEqual(memory.mode, 'memory')
            await memory.close()
        store = self.store()
        busy = await disk.HistoryPersistence.open(self.data, model)
        self.assertEqual(busy.mode, 'busy')
        self.assertFalse(await busy.flush(final=True))
        await busy.close()
        self.assertFalse((self.data/disk.HISTORY).exists())

    async def test_restart_schema_validation_unknown_version_and_clock_rollback(self):
        original = self.model()
        store = self.store()
        document = original.snapshot()
        store.save(document)
        store.close()
        recovered = EndpointHistory()
        persistent = await disk.HistoryPersistence.open(self.data, recovered)
        self.assertEqual(persistent.mode, 'persistent')
        self.assertEqual(len(recovered.records), 1)
        await persistent.close()
        for transform in [lambda doc: {**doc, 'schemaVersion': 999},
                          lambda doc: {**doc, 'savedAt': 10**12},
                          lambda doc: {**doc, 'records': [{'host':'invalid'}]}]:
            self.write(json.dumps(transform(document)).encode())
            recovered = EndpointHistory()
            persistent = await disk.HistoryPersistence.open(self.data, recovered)
            self.assertEqual(persistent.mode, 'persistent')
            self.assertEqual(len(recovered.records), 0)
            await persistent.close()

    async def test_rate_limit_coalesces_and_final_flush_retains_then_releases_lease(self):
        model = self.model()
        persistent = await disk.HistoryPersistence.open(self.data, model)
        with patch.object(persistent.store, 'save', wraps=persistent.store.save) as save:
            self.assertTrue(await persistent.flush())
            model.seen(Candidate('http', '1.1.1.1', 8080))
            self.assertFalse(await persistent.flush())
            self.assertEqual(save.call_count, 1)
            self.assertTrue(await persistent.flush(final=True))
            self.assertEqual(save.call_count, 2)
            competitor = disk.FileHistoryStore(self.data)
            self.assertEqual(competitor.mode, 'busy')
            competitor.close()
        await persistent.close()
        replacement = self.store()
        self.assertEqual(len(replacement.load()['records']), 2)

    async def test_io_failure_does_not_escape_and_later_flush_can_recover(self):
        persistent = await disk.HistoryPersistence.open(self.data, self.model())
        with patch.object(persistent.store, 'save', side_effect=OSError(errno.ENOSPC, 'full')):
            self.assertFalse(await persistent.flush(final=True))
            self.assertEqual(persistent.mode, 'unavailable')
        self.assertTrue(await persistent.flush(final=True))
        self.assertEqual(persistent.mode, 'persistent')
        await persistent.close()

    async def test_disk_write_off_event_loop_and_cancellation_waits_before_unlock(self):
        persistent = await disk.HistoryPersistence.open(self.data, self.model())
        started, release = threading.Event(), threading.Event()
        actual_save = persistent.store.save
        main_thread = threading.get_ident()
        def slow_save(document):
            self.assertNotEqual(threading.get_ident(), main_thread)
            started.set()
            if not release.wait(3):
                raise AssertionError('thread did not release')
            return actual_save(document)
        with patch.object(persistent.store, 'save', side_effect=slow_save):
            task = asyncio.create_task(persistent.flush(final=True))
            await asyncio.wait_for(asyncio.to_thread(started.wait), 1)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            competitor = disk.FileHistoryStore(self.data)
            self.assertEqual(competitor.mode, 'busy')
            competitor.close()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        await persistent.close()

    async def test_close_repeated_cancel_drains_write_before_unlock(self):
        persistent = await disk.HistoryPersistence.open(self.data, self.model())
        started, release = threading.Event(), threading.Event()
        actual_save = persistent.store.save
        def slow_save(document):
            started.set()
            if not release.wait(3):
                raise AssertionError('close write did not release')
            return actual_save(document)
        with patch.object(persistent.store, 'save', side_effect=slow_save):
            task = asyncio.create_task(persistent.close())
            await asyncio.wait_for(asyncio.to_thread(started.wait), 1)
            for _ in range(3):
                task.cancel()
                await asyncio.sleep(0)
            self.assertFalse(task.done())
            competitor = disk.FileHistoryStore(self.data)
            self.assertEqual(competitor.mode, 'busy')
            competitor.close()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertIsNone(persistent.store)
        replacement = self.store()
        self.assertEqual(replacement.mode, 'persistent')
        self.assertEqual(len(replacement.load()['records']), 1)

    async def test_periodic_task_saves_while_session_is_idle(self):
        original = self.model()
        original.seen(Candidate('http', '1.1.1.1', 8080))
        document = original.snapshot()
        old = document['savedAt'] - 7*24*3600 - 1
        document['records'][0].update(firstSeen=old, lastSeen=old)
        store = self.store()
        store.save(document)
        store.close()
        model = EndpointHistory()
        persistent = await disk.HistoryPersistence.open(self.data, model)
        self.assertEqual(len(model.records), 1)
        self.assertEqual(len(json.loads((self.data/disk.HISTORY).read_bytes())['records']), 2)
        wake = asyncio.Event()
        entered = asyncio.Event()
        real_sleep = asyncio.sleep
        async def gated_sleep(seconds):
            self.assertEqual(seconds, 30)
            entered.set()
            await wake.wait()
            wake.clear()
        with patch.object(disk.asyncio, 'sleep', side_effect=gated_sleep):
            await asyncio.wait_for(entered.wait(), 1)
            wake.set()
            for _ in range(100):
                if len(json.loads((self.data/disk.HISTORY).read_bytes())['records']) == 1:
                    break
                await real_sleep(0.01)
            self.assertEqual(len(json.loads((self.data/disk.HISTORY).read_bytes())['records']), 1)
        await persistent.close()


if __name__ == '__main__':
    unittest.main()
