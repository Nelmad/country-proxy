"""Bounded native-offer fixture; it does not discover or validate public proxies."""
import json
from pathlib import Path
import struct
import sys
import threading

output_lock = threading.Lock()


def emit(event):
    payload = json.dumps(event).encode()
    with output_lock:
        sys.stdout.buffer.write(struct.pack('=I', len(payload)) + payload)
        sys.stdout.buffer.flush()


def run(ports, journal, control=None):
    session = None
    attempt = 0
    stopped = threading.Event()

    def health_events():
        sequence = 0
        while not stopped.wait(.02):
            if not session:
                continue
            try:
                raw = control.read_bytes()
                if len(raw) > 8192:
                    return
                event = json.loads(raw)
            except (FileNotFoundError, ValueError):
                continue
            if event['sequence'] <= sequence:
                continue
            sequence = event['sequence']
            emit({'type': 'status', 'feedbackProtocol': 1, **session,
                  'phase': event['phase'], 'attempt': attempt, 'health': event['health'],
                  'proxy': {'scheme': 'http', 'host': '127.0.0.1',
                            'port': ports[(attempt - 1) % len(ports)],
                            'country': 'NO', 'exitIp': '8.8.4.10'}})

    if control is not None:
        threading.Thread(target=health_events, daemon=True).start()
    emit({'type': 'hello', 'feedbackProtocol': 1})
    while header := sys.stdin.buffer.read(4):
        if len(header) != 4:
            return
        size, = struct.unpack('=I', header)
        if not 0 < size <= 64_000:
            return
        body = sys.stdin.buffer.read(size)
        if len(body) != size:
            return
        message = json.loads(body)
        command = message.get('command')
        with journal.open('a') as out:
            print(json.dumps({'command': command, 'attempt': message.get('attempt'),
                              'reason': message.get('reason')}), file=out)
        if command == 'start':
            session = {'id': message['id'], 'countries': message['countries']}
            attempt = 1
        elif command == 'rotate' and session and message['id'] == session['id']:
            emit({'type': 'status', 'feedbackProtocol': 1, **session,
                  'phase': 'replacing', 'attempt': attempt, 'proxy': None})
            attempt += 1
        elif command == 'stop':
            stopped.set()
            return
        else:
            continue
        port = ports[(attempt - 1) % len(ports)]
        emit({'type': 'status', 'feedbackProtocol': 1, **session,
              'phase': 'connected', 'attempt': attempt,
              'proxy': {'scheme': 'http', 'host': '127.0.0.1', 'port': port,
                        'country': 'NO', 'exitIp': '8.8.4.10'}})


if __name__ == '__main__':
    run([int(sys.argv[1]), int(sys.argv[2])], Path(sys.argv[3]),
        Path(sys.argv[4]) if len(sys.argv) > 4 else None)
