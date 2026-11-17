"""Optional, bounded local persistence. All filesystem I/O stays off the event loop."""
import asyncio
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import uuid
from check_budget import await_cleanup

MAX_BYTES = 2 * 1024 * 1024
HISTORY = 'endpoint-history.json'
LOCK = 'endpoint-history.lock'
TEMP = re.compile(r'\.endpoint-history-[0-9a-f]{32}\.tmp\Z')
FORBIDDEN = {'.git', '.ssh', '.aws', '.gnupg', 'credentials', 'secrets', 'vault',
             'strongbox', 'keepassxc'}
SOURCE_ROOT = Path(__file__).resolve().parents[1]


def checked_directory(value, *, create=False):
    """Walk descriptor-relative; never chmod Home, parents or existing directories."""
    path = Path(value).expanduser()
    if not path.is_absolute() or '..' in path.parts or len(path.parts) < 2 or str(path).startswith('//'):
        raise ValueError('History directory must be an exact absolute path')
    if any(part.casefold() in FORBIDDEN for part in path.parts):
        raise ValueError('Sensitive/history path is forbidden')
    if path == Path.home() or path == Path('/'):
        raise ValueError('History needs a dedicated private directory')
    if path == SOURCE_ROOT or SOURCE_ROOT in path.parents:
        relative = path.relative_to(SOURCE_ROOT)
        if not relative.parts or relative.parts[0] != '.runtime':
            raise ValueError('History must not be placed in package source directories')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, component in enumerate(path.parts[1:]):
            final = index == len(path.parts) - 2
            try:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                  dir_fd=descriptor)
            except FileNotFoundError:
                if not (create and final):
                    raise
                os.mkdir(component, mode=0o700, dir_fd=descriptor)
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                  dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
            info = os.fstat(descriptor)
            if info.st_uid not in (0, os.getuid()):
                raise ValueError('History path has another owner')
            if final and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
                raise ValueError('History directory must be owned by this user with mode 0700')
        return descriptor, path
    except BaseException:
        os.close(descriptor)
        raise


def _safe_file(info, *, limit=MAX_BYTES):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
        raise ValueError('History file must be an owner-only ordinary file')
    if info.st_size > limit:
        raise OverflowError('History file exceeds size limit')


class FileHistoryStore:
    """Synchronous descriptor-based adapter; caller owns scheduling and schema."""
    def __init__(self, data_dir, *, create=True):
        self.directory, self.path = checked_directory(data_dir, create=create)
        self.lease = None
        self.mode = 'unavailable'
        try:
            self.lease = self._open_file(LOCK, create=True, limit=0)
            try:
                fcntl.flock(self.lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.mode = 'busy'
                self.close()
                return
            self.mode = 'persistent'
        except BaseException:
            self.close()
            raise

    def _directory_current(self):
        descriptor, _ = checked_directory(self.path)
        try:
            current, held = os.fstat(descriptor), os.fstat(self.directory)
            if (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
                raise ValueError('History directory changed')
        finally:
            os.close(descriptor)

    def _open_file(self, name, *, create=False, limit=MAX_BYTES):
        self._directory_current()
        if create:
            try:
                fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=self.directory)
            except FileExistsError:
                fd = None
        else:
            fd = None
        if fd is None:
            # Metadata and size are checked before any content read.
            info = os.stat(name, dir_fd=self.directory, follow_symlinks=False)
            _safe_file(info, limit=limit)
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=self.directory)
            actual = os.fstat(fd)
            if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                os.close(fd)
                raise ValueError('History file changed')
        try:
            _safe_file(os.fstat(fd), limit=limit)
            return fd
        except BaseException:
            os.close(fd)
            raise

    def load(self):
        if self.mode != 'persistent':
            return None
        try:
            descriptor = self._open_file(HISTORY)
        except (FileNotFoundError, OverflowError):
            return None
        with os.fdopen(descriptor, 'rb') as stream:
            raw = stream.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            return None
        try:
            def unique_object(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError('Duplicate history JSON key')
                    result[key] = value
                return result
            return json.loads(raw, object_pairs_hook=unique_object)
        except (ValueError, UnicodeError, RecursionError):
            return None

    def save(self, document):
        if self.lease is None or self.mode == 'busy':
            return False
        data = json.dumps(document, separators=(',', ':'), ensure_ascii=False,
                          allow_nan=False).encode('utf-8')
        if len(data) > MAX_BYTES:
            raise ValueError('History snapshot exceeds size limit')
        self._directory_current()
        temporary = '.endpoint-history-' + uuid.uuid4().hex + '.tmp'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.directory)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                info = os.stat(HISTORY, dir_fd=self.directory, follow_symlinks=False)
                _safe_file(info, limit=MAX_BYTES)
            except FileNotFoundError:
                pass
            except OverflowError:
                # An oversized but private ordinary cache is safe to replace.
                pass
            self._directory_current()
            os.replace(temporary, HISTORY, src_dir_fd=self.directory, dst_dir_fd=self.directory)
            os.fsync(self.directory)
            return True
        finally:
            try:
                os.unlink(temporary, dir_fd=self.directory)
            except FileNotFoundError:
                pass

    def clear(self):
        if self.mode != 'persistent' or self.lease is None:
            raise BlockingIOError(errno.EWOULDBLOCK, 'History is in use; stop the helper before clearing')
        self._directory_current()
        names = [name for name in os.listdir(self.directory) if name == HISTORY or TEMP.fullmatch(name)]
        # Validate every intended file before deleting any.
        for name in names:
            try:
                _safe_file(os.stat(name, dir_fd=self.directory, follow_symlinks=False))
            except OverflowError:
                pass
        for name in names:
            os.unlink(name, dir_fd=self.directory)
        os.fsync(self.directory)
        return len(names)

    def close(self):
        if self.lease is not None:
            os.close(self.lease)
            self.lease = None
        if self.directory is not None:
            os.close(self.directory)
            self.directory = None


class HistoryPersistence:
    """One background writer, coalesced 30s snapshots and an orderly final flush."""
    def __init__(self, history, *, interval=30):
        self.history = history
        self.mode = 'memory'
        self.store = None
        self.interval = max(30, interval)
        self.task = None
        self.lock = asyncio.Lock()
        self.saved_revision = -1
        self.last_attempt = float('-inf')
        self.close_task = None

    @classmethod
    async def open(cls, data_dir, history, *, interval=30):
        self = cls(history, interval=interval)
        if data_dir is None:
            return self
        def open_and_read():
            store = FileHistoryStore(data_dir)
            try:
                return store, store.load() if store.mode == 'persistent' else None
            except BaseException:
                store.close()
                raise
        opening = asyncio.create_task(asyncio.to_thread(open_and_read))
        try:
            try:
                self.store, document = await asyncio.shield(opening)
            except asyncio.CancelledError:
                async def finish_open():
                    result = await asyncio.gather(opening, return_exceptions=True)
                    if isinstance(result[0], tuple):
                        await asyncio.to_thread(result[0][0].close)
                await await_cleanup(asyncio.create_task(finish_open()))
                raise
            self.mode = self.store.mode
            if self.mode == 'persistent':
                if document is not None:
                    try:
                        history.restore(document)
                    except (ValueError, TypeError, OverflowError, RecursionError):
                        pass
                # First periodic write refreshes expired/invalid disk rows even
                # when no endpoint is observed after startup.
                self.saved_revision = -1
                self.task = asyncio.create_task(self._periodic())
        except (OSError, ValueError, OverflowError):
            self.mode = 'unavailable'
            if self.store is not None:
                await await_cleanup(asyncio.create_task(asyncio.to_thread(self.store.close)))
                self.store = None
        return self

    async def _periodic(self):
        while True:
            await asyncio.sleep(self.interval)
            await self.flush()

    async def flush(self, *, final=False):
        if self.store is None or self.store.lease is None:
            return False
        async with self.lock:
            try:
                now = asyncio.get_running_loop().time()
                if not final and now - self.last_attempt < self.interval:
                    return False
                self.history.prune()
                revision = self.history.revision
                if revision == self.saved_revision and not final:
                    return True
                document = self.history.snapshot()
                self.last_attempt = now
                # Shield the write: cancellation must not release its lease while
                # the worker thread can still replace a file.
                writer = asyncio.create_task(asyncio.to_thread(self.store.save, document))
                try:
                    result = await asyncio.shield(writer)
                except asyncio.CancelledError:
                    async def finish_write():
                        await asyncio.gather(writer, return_exceptions=True)
                    await await_cleanup(asyncio.create_task(finish_write()))
                    raise
                if result:
                    self.saved_revision = revision
                    self.mode = 'persistent'
                return result
            except (OSError, ValueError, OverflowError, TypeError):
                self.mode = 'unavailable'
                return False

    async def close(self):
        if self.close_task is None:
            self.close_task = asyncio.create_task(self._close())
        await await_cleanup(self.close_task)

    async def _close(self):
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None
        await self.flush(final=True)
        if self.store is not None:
            await asyncio.to_thread(self.store.close)
            self.store = None
