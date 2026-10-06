#!/usr/bin/env python3
import base64
import fcntl
import json
import os
import pty
import struct
import sys
import termios

request = json.loads(sys.stdin.read())
argv = request["argv"]
width = int(request.get("width", 80))
env = os.environ.copy()
env.update(request.get("env", {}))
for key in request.get("unsetEnv", []):
    env.pop(key, None)
env["COLUMNS"] = str(width)

pid, fd = pty.fork()
if pid == 0:
    os.execve(argv[0], argv, env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, width, 0, 0))
chunks = []
while True:
    try:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    except OSError:
        break

_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.stdout.write(json.dumps({"exitCode": code, "outputBase64": base64.b64encode(b"".join(chunks)).decode("ascii")}))
