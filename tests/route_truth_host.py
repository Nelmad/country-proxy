"""Native Messaging fixture. Offers loopback endpoints and records addressed feedback."""
import json
import struct
import sys
from pathlib import Path


def send(message):
    payload = json.dumps(message).encode()
    sys.stdout.buffer.write(struct.pack('=I', len(payload)) + payload)
    sys.stdout.buffer.flush()


def run(ports, journal, after_reject=False):
    current = None
    send({'type': 'hello', 'feedbackProtocol': 1})
    while header := sys.stdin.buffer.read(4):
        if len(header) != 4:
            return
        size, = struct.unpack('=I', header)
        if not 0 < size <= 64_000:
            return
        msg = json.loads(sys.stdin.buffer.read(size))
        command = msg['command']
        with journal.open('a') as log:
            print(json.dumps({'command': command, 'attempt': msg.get('attempt')}), file=log)
        if command == 'start':
            current = {'type': 'status', 'feedbackProtocol': 1, 'id': msg['id'],
                       'countries': msg['countries']}
            send_offer(current, 1, ports[0])
        elif (command == 'rotate' or (after_reject and command == 'reject' and msg['attempt'] == 1)) and current and msg['id'] == current['id']:
            send({**current, 'phase': 'replacing', 'proxy': None, 'attempt': 1})
            send_offer(current, 2, ports[1])
        elif command == 'stop':
            return


def send_offer(current, attempt, port):
    send({**current, 'phase': 'connected', 'attempt': attempt,
          'proxy': {'scheme': 'http', 'host': '127.0.0.1', 'port': port,
                    'country': 'NO', 'exitIp': '192.0.2.10'}})


if __name__ == '__main__':
    run([int(sys.argv[1]), int(sys.argv[2])], Path(sys.argv[3]), after_reject='--after-reject' in sys.argv[4:])
