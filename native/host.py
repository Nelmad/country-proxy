#!/usr/bin/env python3
"""Native Messaging host: stdout contains framed JSON only; no listening socket."""
import argparse
import asyncio
import json
import signal
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_budget import await_cleanup
from core import Session, country_codes, selection_argument
from history import EndpointHistory
from history_store import HistoryPersistence

MAX_MESSAGE = 65536
FEEDBACK_PROTOCOL = 1


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


def start_selection(message):
    if 'countries' in message:
        if not isinstance(message['countries'], list):
            raise ValueError('countries must be an array')
        return country_codes(message['countries'])
    return country_codes(message.get('country'))


def status_message(request_id, countries, event):
    proxy = event.get('proxy')
    actual = proxy.get('country') if proxy else event.get('country')
    if actual not in countries:
        actual = countries[0] if len(countries) == 1 else None
    return {**event, 'type': 'status', 'id': request_id, 'countries': list(countries),
            'country': actual, 'feedbackProtocol': FEEDBACK_PROTOCOL}


async def main(data_dir=None, *, history=None):
    reader = asyncio.StreamReader(limit=MAX_MESSAGE + 4)
    await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    task = session = None
    shared = history if history is not None else EndpointHistory()
    storage = await HistoryPersistence.open(data_dir, shared)

    def history_status():
        return {'mode': storage.mode, 'records': len(shared.records)}

    request_id = ''
    try:
        send({'type': 'hello', 'sourceQuality': 1, 'history': history_status(), 'countrySets': True, 'feedbackProtocol': FEEDBACK_PROTOCOL,
              'version': json.loads((Path(__file__).resolve().parents[1] / 'extension/manifest.json').read_text())['version']})
        while True:
            message = await receive(reader)
            command = message.get('command')
            if command == 'start':
                countries = start_selection(message)
                request_id = message.get('id', '')
                if not isinstance(request_id, str) or not 1 <= len(request_id) <= 80:
                    raise ValueError('invalid id')
                if task:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                task = session = None
                if storage is None:
                    storage = await HistoryPersistence.open(data_dir, shared)
                def emit(event, rid=request_id, selected=countries):
                    send(status_message(rid, selected, {**event, 'history': history_status()}))
                version = message.get('feedbackProtocol')
                if type(version) is not int or version != FEEDBACK_PROTOCOL:
                    emit({'phase': 'error', 'proxy': None,
                          'error': 'Версии расширения и помощника несовместимы. Обновите оба из одного комплекта.'})
                    continue
                session = Session(selection_argument(countries), emit)
                session.history = shared
                session.wait_for_browser = True
                async def run(current=session, output=emit):
                    try:
                        await current.run()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        output({'phase': 'error', 'proxy': None, 'error': 'Ошибка помощника. Переподключитесь.'})
                task = asyncio.create_task(run())
            elif command == 'sourceQuality' and session:
                country, token = message.get('country'), message.get('token')
                if (message.get('id') == request_id and country in countries and
                        isinstance(token, str) and 0 < len(token) <= 64):
                    send({'type': 'sourceQuality', 'id': request_id, 'token': token,
                          'report': session.source_report(country)})
            elif command in ('check', 'rotate', 'reject', 'confirm') and session:
                if message.get('id') != request_id:
                    continue
                if command in ('check', 'rotate'):
                    session.nudge(command == 'rotate')
                else:
                    session.browser_feedback(command, message.get('attempt'), message.get('proxy'), message.get('reason'))
            elif command == 'stop':
                if task:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                task = session = None
                if storage is not None:
                    await storage.close()
                    storage = None
                    if data_dir is not None and history is None:
                        shared = EndpointHistory()
                send({'type': 'stopped'})
    except (asyncio.IncompleteReadError, BrokenPipeError):
        pass
    except (ValueError, UnicodeDecodeError):
        send({'type': 'error', 'error': 'Некорректная команда'})
    finally:
        async def shutdown():
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if storage is not None:
                await storage.close()
        await await_cleanup(asyncio.create_task(shutdown()))


async def entry(data_dir):
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        await main(data_dir)
    except asyncio.CancelledError:
        pass
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path)
    # Chrome may append its extension origin (and platform-specific metadata).
    args, _ = parser.parse_known_args()
    asyncio.run(entry(args.data_dir))
