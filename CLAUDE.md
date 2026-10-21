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
4. **No global state mutation.** Never write to `~/.claude/`. All hook
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

## Gotchas

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
