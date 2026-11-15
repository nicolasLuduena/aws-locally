#!/usr/bin/env python3
"""Runs a command in a pseudo-terminal and relays it over stdin/stdout.

The Node server spawns this so the browser terminal gets a real TTY (colors,
line editing, vim, less) without a native Node module. Resize requests arrive
on fd 3 as lines of "rows cols".

usage: pty_bridge.py <cwd> <cmd> [args...]
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    cwd, argv = sys.argv[1], sys.argv[2:]
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(argv[0], argv, os.environ)

    set_size(fd, 30, 100)
    ctl = 3
    try:
        os.fstat(ctl)
    except OSError:
        ctl = None
    inputs = [0, fd] + ([ctl] if ctl is not None else [])
    ctl_buf = b""
    while True:
        try:
            ready, _, _ = select.select(inputs, [], [])
        except InterruptedError:
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(fd, data)
        if ctl is not None and ctl in ready:
            data = os.read(ctl, 1024)
            if not data:
                inputs.remove(ctl)
                ctl = None
                continue
            ctl_buf += data
            while b"\n" in ctl_buf:
                line, ctl_buf = ctl_buf.split(b"\n", 1)
                try:
                    rows, cols = (int(x) for x in line.split())
                    set_size(fd, rows, cols)
                    os.kill(pid, signal.SIGWINCH)
                except (ValueError, OSError):
                    pass
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
    os.waitpid(pid, 0)


if __name__ == "__main__":
    main()
