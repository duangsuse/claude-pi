# cld-pi

**English** · [简体中文](./README.zh-CN.md)

An interactive shell around [Claude Code](https://code.claude.com), forked from
[smithersai/claude-p](https://github.com/smithersai/claude-p).

- `npx cld-pi` with **no arguments** opens Claude Code (fullscreen TUI) inside a
  thin wrapper that adds prefix completion, overlays and JS plugins on top.
- `npx cld-pi "prompt"` keeps the original behaviour: a drop-in for `claude -p`.

The wrapper never rewrites Claude Code's output. It forwards every byte,
mirrors the screen in a [ghostty-vt](https://github.com/ghostty-org/ghostty)
grid, and paints its own layer on top.

## Run

```sh
npx cld-pi                               # interactive
npx cld-pi -r [id]                       # interactive, resume a session (-c: continue)
npx cld-pi "explain this repo"           # same output as `claude -p`
npx cld-pi .json "summarize" < diff.txt  # .text / .json / .stream-json = --output-format
npx cld-pi -r <id> "and now?"            # -p mode in an existing session
```

Requires `claude` on `$PATH`, Node ≥ 18, macOS or Linux.

`npm i -g cld-pi` installs the same thing as the `claude-p` command (and
`cld-pi`). On first run it prints a one-liner that binds **Ctrl+P** in your
shell to `claude-p`. Nothing is written to your rc files for you.

Interactive mode forces `/tui fullscreen` and registers `Notification`,
`Stop` and `SessionStart` hooks through `--settings`. It keeps its files in
`~/claude/-p/`:

| File | What |
|---|---|
| `scr` | Plain-text dump of the current screen, refreshed every frame |
| `host.log` | Log of the node sidecar |
| `inspect` | DevTools URL of the sidecar |
| `*.js` | Your plugins (from P3) |

## Keys

| Key | In the input box |
|---|---|
| `./…` + Tab | fzf over files in CC's current dir → inserts `@path ` (ctrl-d: the file's folder) |
| `/~/…` + Tab | same, under `~` |
| Ctrl+C | clears the caret's line and the lines below, caret stays on a fresh line; empty box → Claude Code's own Ctrl+C |
| Enter on a single line `/~/dir` | creates `~/dir` if needed, `/add-dir` if outside, `/clear`, then `! cd` there |

## Debugging plugins (F12)

The node sidecar runs with the inspector on by default, listening on
`127.0.0.1:9229` (a random port if taken; see `~/claude/-p/inspect`). Open
`chrome://inspect` → *inspect*, and the global `pi` is there:

```js
pi`/help`            // type a line into Claude Code + Enter
pi.BUFFER = 'draft'  // replace the input box text, no Enter (write-only)
pi.arg.fzf = "--pointer '▶' --height=60%"   // fzf options for Tab completion
await pi.on.stop      // wait for the next Stop hook
```

`CLAUDE_P_INSPECT=0` turns it off, `CLAUDE_P_INSPECT=<port>` picks a port.
Anything on your machine that can reach that local port can run code as
you, so turn it off on shared hosts.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| P0 | Passthrough, ghostty-vt grid, `scr`, hooks, node sidecar | ✅ done |
| P1 | Input box detection, `./` `/~/` completion, Ctrl+C, path → `cd` | ✅ done |
| P2 | Overlays (menu / dialog / paint), Ctrl+Enter, `notify-send` | |
| P3 | Plugin API, `/m` `/w` `/ad` | |
| P4 | Ctrl+P settings panel | |
| P5 | Chrome tabs: `//` screenshot, `//gh/` URLs, WebMCP | |
| P6 | Conversation outline WebUI | |

Full design: [goal-v1.md](./goal-v1.md) · plugin API draft: [goal-v1.ts](./goal-v1.ts).

## Build from source

```sh
mise install            # Zig 0.15.2, pinned in mise.toml
zig build test          # Zig unit tests
node --test js/test/*.test.js
zig build -Doptimize=ReleaseSafe
./zig-out/bin/claude-p
```

On Linux the default target is musl (static binary, same as releases).

## License

[MIT](./LICENSE). Based on claude-p by smithersai, also MIT.
