# CLAUDE.md — agent instructions for this repo

> **READ THIS BEFORE TOUCHING CODE.** If you joined the session mid-flight
> (via context compaction, resume, or a fresh invocation), the first thing you
> do is re-read **[SPEC.md](./SPEC.md)** and **[README.md](./README.md)** so the
> architecture and end-user contract are in front of you. They are the source
> of truth — this conversation is not.

## Project

`claude-p` — a Zig CLI/library that emulates `claude -p` by driving the
interactive `claude` binary inside an in-process [zmux] PTY session,
capturing the final assistant message via a `Stop` hook, and emitting it in
`claude -p` wire-compatible format.

[zmux]: https://github.com/smithersai/zmux

## How to work in this repo

1. **Spec first, code second.** Any non-trivial change starts in `SPEC.md`.
   If you find yourself making a load-bearing decision the spec doesn't
   cover, update the spec in the same change.
2. **TDD.** Write the failing test, then the code. The test order documented
   in §6 of `SPEC.md` is the implementation order. Don't skip ahead — each
   layer is consumed by the next.
3. **Output is a contract.** `claude-p` output for a given prompt must be
   byte-for-byte equal to `claude -p`'s output for the same prompt. Golden
   files live in `tests/fixtures/`. If you change a formatter, regenerate
   goldens with `zig build update-fixtures` and review the diff carefully.
4. **No global state mutation.** Never write to `~/.claude/` — with one
   user-requested exception: in interactive mode, quitting CC with Ctrl+C
   moves that session's transcript to `~/claude/last` and prints the `mv`
   that restores it (`src/pi/convo.zig`, path-checked; empty sessions are
   left alone). All hook
   scripts, settings, FIFOs live under `$TMPDIR/claude-p-<pid>/` and are
   cleaned up on exit (including via signal-safe cleanup paths).
5. **Vendored zmux.** `zmux` is pulled in via `zig fetch` and the
   resolved SHA is pinned in `build.zig.zon`. Do not bump casually — bump
   only with a passing real-claude integration run
   (`CLAUDE_P_E2E=1 zig build test-integration`).

## Build & test

```bash
# Unit tests (no external deps).
zig build test
node --test js/test/*.test.js

# End-to-end against the real `claude` binary (must be on $PATH).
CLAUDE_P_E2E=1 zig build test-integration
```

We don't use mocks for end-to-end testing — `tests/integration.zig`
runs the real `claude` binary.

## Files of note

| Path | Purpose |
| ---- | ------- |
| `SPEC.md` | Architecture, API, formats, exit codes, test plan. |
| `README.md` | End-user CLI/library contract. |
| `src/main.zig` | CLI entry point. |
| `src/root.zig` | Public Zig library API. |
| `src/args.zig` | Argparse. |
| `src/terminal.zig` | DEC/XTerm query responder (stateless). |
| `src/hook.zig` | Inline-settings + hook script generator. |
| `src/driver.zig` | zmux session lifecycle + FIFO poll loop. |
| `src/transcript.zig` | Session JSONL parser. |
| `src/emit.zig` | Output formatters. |
| `tests/integration.zig` | Real-claude end-to-end tests (gated). |
| `src/pi/main.zig` | Interactive mode (no args): raw passthrough, hook FIFO, `scr` dump (only while the file exists; `scr` / `host.log` are deleted on exit), wheel-scroll overlay debounce. |
| `src/pi/grid.zig` | ghostty-vt grid mirroring CC's screen. |
| `src/pi/term.zig` | Raw mode, winsize, SIGWINCH self-pipe. |
| `src/pi/sidecar.zig` | Spawns `js/host.js`, JSON-lines RPC. |
| `src/pi/screen.zig` | **All** rules for reading CC's UI off the grid (input box, busy, …). Glyphs / keywords are `screen.Rules` (CC's by default, `pi.arg` overrides for `cld-pi -a <tui>`). |
| `src/pi/input.zig` | Pure key logic: Tab prefixes, Ctrl+C plan, path → cd target. |
| `src/pi/steps.zig` | Non-blocking queue of pty writes + waits (cd flow). |
| `src/pi/fzf.zig` | fzf on the real tty (main.zig pauses output, repaints from grid). |
| `src/pi/overlay.zig` | Dialog / menu / row paints, appended after every CC chunk. |
| `js/plugins/*.js` | Default plugins: `notify.js` (desktop notification), `herdry.js` (spinning tab title), `pace.js` (last ● duration + 3-minute cost, bottom-right snack). |
| `js/rpc.js` | `pi` API + plugin registry (AsyncLocalStorage ownership, timer hooks, ◆ badge list). |
| `js/session.js` | Transcript cost / name, status-line parsing (effort, mode), Bash output rows. Prices from the claude-api skill. |
| `js/plugins/panel.js` | Ctrl+P panel: rows of buttons (`eachRow [4,5,3,3,4]`), relabeled via the dialog handle once CC agrees. |
| `js/tab.js` | Tab-title backends (Yakuake / Konsole / Guake over D-Bus) for `pi.tui.title`. |
| `js/plugins/f12.js`, `js/cdp.js` | P5: `//` tab screenshot, `//gh/` URLs (tabs + History), `pi.ext.f12.addTrust` → `~/.F12-mcp.json`, MCP install hint. `cdp.js` = stdlib CDP client + Chrome discovery (`CLAUDE_P_CDP` or `DevToolsActivePort`). Tests inject `home` / `cdp`: never let them touch the real `~/.F12-mcp.json` or the user's Chrome. |
| `js/plugins/{add-dir,webpane,magpie}.js` | `/ad`, `/w` (+ `pi.ext.webpane`), `/m` (via `pi.sh`). Tests fake `pi`; don't run `/w` / `/m` for real in tests (npx server, desktop app). |
| `goal-v1.ipynb` | `%%js` cell magic (stdlib CDP client, default :9229) + API examples. Agents test it against a sidecar on :9224. |
| `src/pi/testdata/*.vt` | Raw CC output streams (100x30) replayed by screen/grid tests. |
| `scripts/cc-probe.py` | Drive real CC through claude-p, record `.vt` + `scr` per step (it touches `scr` in its data dir to opt in). |
| `scripts/vt-view.mjs` | Page through `.vt` files (←/→) by replaying them. |
| `scripts/cdp-eval.mjs` | Evaluate JS in a sidecar over CDP (default :9224), like F12. |
| `js/host.js`, `js/rpc.js` | node sidecar; plugin API grows here (see `goal-v1.ts`). |
| `goal-v1.md` | Interactive-mode design + phases (P0–P6). |

## Agent testing (interactive mode)

- The user may have a real claude-p running. **Agent tests use port 9224 for
  every CDP endpoint** (sidecar inspector: `CLAUDE_P_INSPECT=9224`; the browser
  too: `CLAUDE_P_CDP=9224` + `chromium --remote-debugging-port=9224
  --user-data-dir=<tmp>`, never the user's Chrome) and their own data dir
  (`CLAUDE_P_DIR=...`). `scripts/cc-probe.py` sets both.
- `cc-probe.py` has no terminal emulator in front of it: it can't show what
  the user actually sees (fzf panels, repaints). For that run claude-p in
  `tmux -L <own socket> new-session -x 100 -y 30 ...` and `capture-pane`.
- Probes never submit a prompt unless a step does. Note `! cmd` starts a
  model turn after the command (Esc it) — keep those runs few.
- New CC screen states → record with cc-probe, copy the `.vt` into
  `src/pi/testdata/` (scrub account details), add a `screen.zig` test.

## Gotchas

- **Typing into CC from the wrapper**: a write glued to the previous one is
  taken as a paste (`\r` → newline); text and `\r` split apart lets CC's
  suggestion popup eat the Enter. `Keys.submit` = quiet gap, one write,
  then Enter again if text is still in the box (a popup can still take the
  first one — seen in tmux). Command lines that end in a path get a trailing
  space so no suggestion pops up at all.
- **CC is "busy" while a `!` command runs** (`⎿ Running…`). Esc then
  cancels the command and puts it back in the box.
- **Overlays never use DECSC/DECRC** (CC uses them); the cursor and SGR
  are put back from the grid (`Grid.restoreCursor`). Each CC chunk + the
  overlay go out in one `?2026` synchronized write.
- **herdry renames real tabs** (Yakuake/Konsole/Guake over D-Bus). Tests
  pass a fake `io.tab` to `createHost`; never call `pickTab()`'s `set` from a test.
- **Tests that trigger Stop/Notification or Ctrl+Enter**: put fakes for
  `notify-send` / `wl-paste` first in PATH — otherwise you pop notifications
  on the user's desktop or submit their real clipboard to the model.
- **`/clear` resets CC's cwd** to the start dir, and `! cd` outside the
  allowed dirs is reset too — why `/~/name` opens a *new* cld-pi via a
  copied launch command instead of moving this session.
- **Interactive mode (`src/pi/`) must not use `terminal.zig`.** The real
  terminal answers CC's DEC queries; fake replies would double up.
- **zmux never emits `session_exited` on pty EOF** — it only marks the
  session `.terminated`. `pi/main.zig` polls `state()` and calls
  `handle.reapExited()` to get the exit code.
- **Native glibc link fails on Zig 0.15** with newer toolchains
  (`unhandled relocation type R_X86_64_PC64 ... .sframe`). `build.zig`
  defaults Linux to musl for that reason.
- **Fetching deps behind an HTTP proxy**: Zig 0.15's client often fails
  through `HTTPS_PROXY`. Download the tarball with curl and `zig fetch <file>`;
  the content hash is identical.
- **ghostty requests many lazy deps** (fonts, gtk, …) at configure time even
  though only `ghostty-vt` is used. They're downloaded once into the cache;
  nothing from them is compiled.

- **Don't call back into zmux from inside the EventSink callback for the
  same session.** The reader thread runs the callback; re-entering
  `writeInput` from it would re-enter zmux's own locks. Queue bytes in a
  mutex-guarded buffer and let the main loop flush.
- **Ink hangs without DA/XTVERSION replies.** `terminal.respondToDecQueries`
  is load-bearing. The EventSink callback must run it on every chunk of
  PTY output. Do not remove it without testing against real claude.
- **Hook FIFO ordering.** Both `SessionStart` and `Stop` write to the same
  FIFO; the driver must tag each line by event name and handle out-of-order
  arrivals.
- **Multiple Stop events.** `Stop` fires after every assistant turn. For
  single-turn print-mode emulation, take the first `Stop` and tear down.
- **Stop / transcript race.** The Stop hook can fire a few ms before the
  transcript JSONL is flushed. Retry `parseFile` (20×, 50 ms) and fall back
  to `last_assistant_message` from the Stop payload.

## When in doubt

- Re-read `SPEC.md`.
- zmux source / API: <https://github.com/smithersai/zmux>.
- Live Claude Code hooks reference: <https://code.claude.com/docs/en/hooks>.

## Conventions

- Zig **0.15.2** (matches zmux's `comptime` pin).
- Allocator-per-function: every public API takes a `std.mem.Allocator`.
- Errors are `error{...}` unions, never `anyerror` in public APIs.
- No `std.debug.print` in non-test code — use the `log` module gated on
  `--debug`.
- No silent fallbacks: if something we expected isn't there (e.g.
  `transcript_path` missing from a Stop payload), error loudly with context.
