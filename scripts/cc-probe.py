#!/usr/bin/env python3
"""Drive claude-p (real `claude`) in a pty and record what CC draws.

    scripts/cc-probe.py OUTDIR '[["hello", 1], ["\\x03", 0.5]]' [--cwd DIR]

Each step is [keys, seconds]: keys are written (Python escapes like \\r,
\\x1b[A are decoded), then output is collected for `seconds`. Per step it
saves OUTDIR/<i>.vt (whole stream so far, replayable, see vt-view.mjs),
<i>.delta (just that step) and <i>.scr (claude-p's grid dump), and prints the
bottom of the screen. The pty answers the basic DEC queries a terminal would.

Runs at 100x30 (the size src/pi/testdata/ fixtures assume). Agent-test
isolation: the sidecar inspector goes to :9224 and claude-p's data dir to
OUTDIR/data, so a real claude-p session on the same machine is untouched.
Nothing is submitted to the model unless your steps do it.
"""
import fcntl, json, os, pty, select, struct, sys, termios, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLS, ROWS = 100, 30


def main():
    args = sys.argv[1:]
    cwd = ROOT
    if '--cwd' in args:
        i = args.index('--cwd')
        cwd = args[i + 1]
        del args[i:i + 2]
    if len(args) != 2:
        sys.exit(__doc__)
    outdir, steps = os.path.abspath(args[0]), json.loads(args[1])
    data = os.path.join(outdir, 'data')
    os.makedirs(data, exist_ok=True)
    open(os.path.join(data, 'scr'), 'a').close()  # opt in to the grid dump
    binp = os.path.join(ROOT, 'zig-out', 'bin', 'claude-p')

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        # 9224 for every CDP endpoint: the sidecar's inspector and the browser
        # f12.js talks to (never the user's Chrome).
        env = dict(os.environ, CLAUDE_P_INSPECT='9224', CLAUDE_P_CDP='9224', CLAUDE_P_DIR=data)
        os.execve(binp, [binp], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))

    out = bytearray()

    def pump(t):
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if not r:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            out.extend(chunk)
            if b'\x1b[c' in chunk or b'\x1b[0c' in chunk:
                os.write(fd, b'\x1b[?62;22c')
            if b'\x1b[>q' in chunk or b'\x1b[>0q' in chunk:
                os.write(fd, b'\x1bP>|xterm(390)\x1b\\')
            if b'\x1b[6n' in chunk:
                os.write(fd, b'\x1b[1;1R')

    pump(6)  # CC boot
    scr = os.path.join(data, 'scr')
    for i, (keys, wait) in enumerate(steps):
        mark = len(out)
        if keys:
            os.write(fd, keys.encode('utf-8').decode('unicode_escape').encode('latin-1'))
        pump(wait)
        with open(f'{outdir}/{i}.vt', 'wb') as f:
            f.write(out)
        with open(f'{outdir}/{i}.delta', 'wb') as f:
            f.write(out[mark:])
        text = open(scr).read() if os.path.exists(scr) else ''
        with open(f'{outdir}/{i}.scr', 'w') as f:
            f.write(text)
        print(f'=== step {i} keys={keys!r}')
        print('\n'.join(l.rstrip() for l in text.splitlines()[-9:]))

    for _ in range(3):  # Ctrl+C until CC exits
        os.write(fd, b'\x03')
        pump(0.6)
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass


if __name__ == '__main__':
    main()
