"""Framed local native sink: records commands, emits hello, never offers a proxy."""
import json
from pathlib import Path
import struct
import sys

journal = Path(sys.argv[1])
payload = json.dumps({'type': 'hello', 'feedbackProtocol': 1}).encode()
sys.stdout.buffer.write(struct.pack('=I', len(payload)) + payload)
sys.stdout.buffer.flush()
while header := sys.stdin.buffer.read(4):
    if len(header) != 4:
        break
    length, = struct.unpack('=I', header)
    if not 0 < length <= 64000:
        break
    body = sys.stdin.buffer.read(length)
    if len(body) != length:
        break
    message = json.loads(body)
    with journal.open('a') as stream:
        print(json.dumps(message), file=stream)
    if message.get('command') == 'stop':
        break
