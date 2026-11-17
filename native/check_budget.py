"""Session-owned endpoint checks with reserved capacity and shared ownership."""
import asyncio
from dataclasses import dataclass


async def await_cleanup(task):
    """Drain owned cleanup despite repeated cancellation of the waiting parent.

    Shielding once is insufficient: a second parent.cancel() must not propagate
    through a subsequent bare await and interrupt the child's async finally.
    Cancellation is re-raised after cleanup, never turned into a success.
    """
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    result = task.result()
    if cancelled:
        raise asyncio.CancelledError
    return result


class SupplementalBudget:
    """At most two optional HTTPS transfers in one Session, with no queue.

    A permit belongs to its transfer task until that task has finished draining
    its subprocess. Callers must release it from the task's done callback, which
    also covers cancellation before the coroutine first runs.
    """

    LIMIT = 2

    def __init__(self):
        self._owners = set()

    @property
    def running(self):
        return len(self._owners)

    def acquire(self):
        if len(self._owners) >= self.LIMIT:
            return None
        owner = object()
        self._owners.add(owner)
        return owner

    def release(self, owner):
        self._owners.remove(owner)


@dataclass
class _Request:
    endpoint: str
    variant: object
    role: str
    operation: object
    task: object = None
    owners: int = 0
    started: bool = False


class CheckBudget:
    """One slot covers a complete endpoint check (both HTTPS requests).

    Active mode reserves 1 health / 2 reserve / 7 speculative slots. Inactive
    mode has ten foreground slots. No endpoint runs two variants concurrently.
    Identical endpoint/variant calls share work; the last owner leaving cancels
    and awaits it. Queued shared work can acquire a more urgent owner's role.
    """

    LIMIT = 10
    LIMITS = {'health': 1, 'reserve': 2, 'speculative': 7}
    PRIORITY = {'health': 0, 'reserve': 1, 'speculative': 2}

    def __init__(self):
        self.active = False
        self._closed = False
        self._transitioning = False
        self._condition = asyncio.Condition()
        self._transition_lock = asyncio.Lock()
        self._requests = {}
        self._running = {}
        self._counts = dict.fromkeys(self.LIMITS, 0)

    @property
    def snapshot(self):
        return {'active': self.active, 'closed': self._closed,
                'running': len(self._running), 'requests': len(self._requests),
                'roles': dict(self._counts)}

    def _available(self, request):
        if request.endpoint in self._running or len(self._running) >= self.LIMIT:
            return False
        return not self.active or self._counts[request.role] < self.LIMITS[request.role]

    async def _execute(self, request):
        acquired = False
        try:
            async with self._condition:
                await self._condition.wait_for(lambda: self._available(request))
                request.started = acquired = True
                self._running[request.endpoint] = request
                self._counts[request.role] += 1
            return await request.operation()
        finally:
            async with self._condition:
                if acquired:
                    self._running.pop(request.endpoint)
                    self._counts[request.role] -= 1
                key = (request.endpoint, request.variant)
                if self._requests.get(key) is request:
                    self._requests.pop(key)
                self._condition.notify_all()

    async def run(self, endpoint, variant, role, operation):
        role = 'speculative' if role == 'foreground' else role
        if role not in self.LIMITS:
            raise ValueError('unknown endpoint check role')
        async with self._condition:
            await self._condition.wait_for(lambda: not self._transitioning)
            if self._closed:
                raise asyncio.CancelledError('check budget closed')
            key = (endpoint, variant)
            request = self._requests.get(key)
            while request is not None and request.task.cancelling():
                # Do not attach a new owner to an abandoned operation. Its
                # cleanup must complete before a fresh variant can start.
                await self._condition.wait()
                await self._condition.wait_for(lambda: not self._transitioning)
                if self._closed:
                    raise asyncio.CancelledError('check budget closed')
                request = self._requests.get(key)
            if request is None:
                request = _Request(endpoint, variant, role, operation)
                self._requests[key] = request
                request.task = asyncio.create_task(self._execute(request))
            elif (not request.started and
                  self.PRIORITY[role] < self.PRIORITY[request.role]):
                request.role = role
                self._condition.notify_all()
            request.owners += 1
        try:
            return await asyncio.shield(request.task)
        finally:
            # No await between decrement and the last-owner decision: another
            # caller cannot accidentally cancel a worker still owned elsewhere.
            request.owners -= 1
            if not request.owners:
                if not request.task.done():
                    if not request.task.cancelling():
                        request.task.cancel()
                await await_cleanup(asyncio.create_task(self._forget_when_done(key, request)))

    async def _forget_when_done(self, key, request):
        await asyncio.gather(request.task, return_exceptions=True)
        async with self._condition:
            # A task cancelled before its first instruction never runs
            # _execute's finally block, so the owner also releases its
            # pending registry entry after awaiting cancellation.
            if self._requests.get(key) is request:
                self._requests.pop(key)
            self._condition.notify_all()

    async def _change_mode(self, active, close):
        async with self._transition_lock:
            async with self._condition:
                if self._closed or (self.active == active and not close):
                    return
                self._transitioning = True
                self._closed = close
                workers = [request.task for request in self._requests.values()]
            try:
                for worker in workers:
                    if not worker.cancelling():
                        worker.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
            finally:
                async with self._condition:
                    # Worker finally blocks have released every acquired slot.
                    # Also forget workers cancelled before _execute began.
                    for key, request in list(self._requests.items()):
                        if request.task in workers and request.task.done():
                            self._requests.pop(key)
                    self.active = active
                    self._transitioning = False
                    self._condition.notify_all()

    async def _transition(self, active, close=False):
        task = asyncio.create_task(self._change_mode(active, close))
        await await_cleanup(task)

    async def set_active(self, active):
        await self._transition(bool(active))

    async def close(self):
        await self._transition(False, close=True)
