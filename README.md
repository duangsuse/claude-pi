# cld-pi

**English** · [简体中文](./README.zh-CN.md)

An interactive shell around [Claude Code](https://code.claude.com), forked from
[smithersai/claude-p](https://github.com/smithersai/claude-p).

- `claude-p` with **no arguments** opens Claude Code (fullscreen TUI) inside a
  thin wrapper that adds prefix completion, overlays and JS plugins on top.
- `claude-p "prompt"` keeps the original behaviour: a drop-in for `claude -p`.

The wrapper never rewrites Claude Code's output. It forwards every byte,
mirrors the screen in a [ghostty-vt](https://github.com/ghostty-org/ghostty)
grid, and paints its own layer on top.

## Install

```sh
npm i -g cld-pi        # installs the `claude-p` command
```

Requires `claude` on `$PATH`, Node ≥ 18, macOS or Linux.

On first run `claude-p` prints a one-liner that binds **Ctrl+P** in your shell
to launch it. Nothing is written to your rc files for you.

## Use

```sh
claude-p                                   # interactive
claude-p "explain this repo"               # same output as `claude -p`
claude-p --output-format json "summarize" < diff.txt
```

Interactive mode forces `/tui fullscreen` and registers `Notification`,
`Stop` and `SessionStart` hooks through `--settings`. It keeps its files in
`~/claude/-p/`:

| File | What |
|---|---|
| `scr` | Plain-text dump of the current screen, refreshed every frame |
| `host.log` | Log of the node sidecar |
| `*.js` | Your plugins (from P3) |

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| P0 | Passthrough, ghostty-vt grid, `scr`, hooks, node sidecar | ✅ done |
| P1 | Input box detection, `./` `/~/` completion, Ctrl+C, path → `cd` | |
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
