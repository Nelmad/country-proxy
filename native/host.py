#!/usr/bin/env python3
"""Native Messaging host: stdout contains framed JSON only; no listening socket."""
import asyncio
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from core import Session, country_code

MAX_MESSAGE = 65536


def encode(message):
    payload = json.dumps(message, ensure_ascii=False, separators=(',', ':')).encode()
    if len(payload) > MAX_MESSAGE:
        raise ValueError('message too large')
    return struct.pack('=I', len(payload)) + payload


async def receive(reader):
    header = await reader.readexactly(4)
    size = struct.unpack('=I', header)[0]
    if size > MAX_MESSAGE or size < 2:
        raise ValueError('invalid frame length')
    message = json.loads(await reader.readexactly(size))
    if not isinstance(message, dict):
        raise ValueError('object required')
    return message


def send(message):
    sys.stdout.buffer.write(encode(message))
    sys.stdout.buffer.flush()


async def main():
    reader = asyncio.StreamReader(limit=MAX_MESSAGE + 4)
    await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    task = session = None
    request_id = ''
    try:
        send({'type': 'hello', 'version': '0.1.0'})
        while True:
            message = await receive(reader)
            command = message.get('command')
            if command == 'start':
                country = country_code(message.get('country'))
                request_id = message.get('id', '')
                if not isinstance(request_id, str) or len(request_id) > 80:
                    raise ValueError('invalid id')
                if task:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                def emit(event, rid=request_id, cc=country):
                    send({'type': 'status', 'id': rid, 'country': cc, **event})
                session = Session(country, emit)
                async def run(current=session, output=emit):
                    try:
                        await current.run()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        output({'phase': 'error', 'proxy': None, 'error': 'Ошибка помощника. Переподключитесь.'})
                task = asyncio.create_task(run())
            elif command in ('check', 'rotate') and session:
                session.nudge(command == 'rotate')
            elif command == 'stop':
                if task:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                task = session = None
                send({'type': 'stopped'})
    except (asyncio.IncompleteReadError, BrokenPipeError):
        pass
    except (ValueError, UnicodeDecodeError):
        send({'type': 'error', 'error': 'Некорректная команда'})
    finally:
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


if __name__ == '__main__':
    asyncio.run(main())
