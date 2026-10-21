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
npx cld-pi -a codex                      # wrap another TUI (set pi.arg.prompt / busy / … for its screen)
```

Requires `claude` on `$PATH`, Node ≥ 18, macOS or Linux.

`npm i -g cld-pi` installs the same thing as the `claude-p` command (and
`cld-pi`). On first run it prints a one-liner that binds **Ctrl+P** in your
shell to `claude-p`. Nothing is written to your rc files for you.

Interactive mode forces `/tui fullscreen` and registers `Notification`,
`Stop` and `SessionStart` hooks through `--settings`; Stop / Notification
pop a desktop notification (`notify-send`) when the terminal isn't focused, and the
default `herdry` plugin spins the tab title (`✻ message`) in Yakuake / Konsole / Guake
(window title elsewhere) until you focus it. It keeps its files in
`~/claude/-p/`:

| File | What |
|---|---|
| `scr` | Plain-text dump of the current screen, refreshed every frame — only while the file exists (`touch` it to turn it on; removed on exit) |
| `host.log` | Log of the node sidecar — same opt-in: written only if it exists, removed on exit |
| `inspect` | DevTools URL of the sidecar |
| `*.js` | Your plugins: `export default pi => { … }` (ES module) |

The `◆ plugins n/m` badge in the top-right corner lists every plugin; click it
to turn one off — its listeners, `pi.sed`s and timers go away with it. A plugin can
put its own text there with `pi.notify(msg, 'snack')` (bottom-right: `'snackRD'`);
the default `pace` plugin shows how long the last ● took and what the last 3 minutes
cost in the bottom-right corner. Both corners open the plugin list.

## Keys

| Key | In the input box |
|---|---|
| `./…` + Tab | fzf over files in CC's current dir → inserts `@path ` (ctrl-d: the file's folder) |
| `/~/…` + Tab | same, under `~` |
| `//…` + Tab | fzf over your Chrome tabs → screenshots the pick, inserts `@/tmp/….png ` |
| `//gh/…` + Tab | URLs on that site (`gh` → github.com) from your tabs and Chrome history |
| Ctrl+C | clears the caret's line and the lines below, caret stays on a fresh line; empty box → Claude Code's own Ctrl+C |
| Ctrl+Enter | paste the clipboard and submit (needs a kitty-protocol or modifyOtherKeys terminal) |
| Ctrl+P | settings panel: session name + cost, model / effort / mode, file / web permissions, hide Bash output, CtrlO / CtrlR / Undo / Copy |
| quitting with Ctrl+C | moves that conversation out of `~/.claude/projects/` to `~/claude/last` (replacing the previous one) and prints `To restore #> mv ~/claude/last …`; an empty session prints nothing (quit with `/exit` to keep it) |
| mouse wheel | goes to Claude Code untouched; overlays step aside until it stops (`pi.arg.whlSpeed = n`: n notches = one PgUp / PgDn instead) |
| double click | pages (PgUp / PgDn) the way the wheel last went |
| Enter on a single line `/~/name` | creates `~/claude/name` and copies `cd … && npx cld-pi` to paste in a new terminal |

## Commands

Typed as a single line in the input box; Claude Code never sees them.

| Command | |
|---|---|
| `/ad <dir>` | `/add-dir` it (confirms the dialog), then `!tree -L 2 <dir>` |
| `/w` | cloudcli web UI on `:3001` (started in the background if nothing serves it); shows localhost / LAN / tailscale URLs, with buttons to copy the LAN or tailscale URL or show the tailscale one as a QR code (`npx qrcode-terminal`) |
| `/m` | `~/.local/bin/magpie panel` |

## Chrome

`//` needs remote debugging on in your Chrome: open
`chrome://inspect/#remote-debugging` and allow it (Chrome 144+; Chrome asks you
to *Allow* cld-pi once per session). Every site you pick with `//` or `//gh/` is
added to `allowedUrlPattern` in `~/.F12-mcp.json`, the config of the
chrome-devtools MCP that lets Claude drive the same browser. The first `//`
offers its install command:

```sh
claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest \
  --autoConnect --config ~/.F12-mcp.json --watchConfig
```

`CLAUDE_P_CDP=9222` (a port or a `ws://` URL) connects to another browser instead.

## Plugins

A plugin is an ES module in `~/claude/-p/` exporting a function of `pi`:

```js
// ~/claude/-p/hello.js
export default pi => {
  pi.command('hi', ([name = 'there']) => pi.dialog({ body: `hello ${name}`, timeout: 2000 }))
  pi.complete('#', tok => ['#bug', '#feat', '#docs'].filter(t => t.startsWith(tok)))
  pi.on({ CtrlG: () => (pi.BUFFER = 'git status', false) })   // false: skip the default
  setInterval(() => {}, 60_000)                                 // cleared when turned off
}
```

## Debugging plugins (F12)

The node sidecar runs with the inspector on by default, listening on
`127.0.0.1:9229` (a random port if taken; see `~/claude/-p/inspect`). Open
`chrome://inspect` → *inspect*, and the global `pi` is there:

```js
pi`/help`            // type a line into Claude Code + Enter
pi.BUFFER = 'draft'  // replace the input box text, no Enter (write-only)
pi.BUFFER=await pi.menu('abc'.split(''))

pi.arg.fzf = "--pointer '▶' --height=60%"   // fzf options for Tab completion
pi.arg.whlSpeed = 5                          // wheel notches per PgUp / PgDn (0: pass through)
pi.arg.prompt = '>'   // also border, bash, busy, running: how the TUI's screen reads (CC's by default)
pi.notify('3 tests left', 'snack')           // text in the top-right badge ('' takes it down)
pi.notify('busy', 'snackRD', { bg: 236 })    // bottom-right; bg: 0-255, '#rrggbb', 'none'
await pi.dialog({ title: 'Hi', body: 'gum-style', OK: () => {}, Stat: () => pi`/status` })
pi.dialog({ body: 'saved', timeout: 3000, or: 'OK', OK: () => {} })   // non-modal, top-right; ←/→ / click / Enter restart the timeout
pi.sed(ln => ln.includes('secret') ? '' : null)   // blank / rewrite screen rows
await pi.on.stop      // wait for the next Stop hook
```

`CLAUDE_P_INSPECT=9223` picks another port. (0=OFF).

> [Refer this](./goal-v1.ts) for more · [goal-v1.ipynb](./goal-v1.ipynb): a `%%js` Jupyter magic that runs these against your session (CDP :9229), with examples

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| P0 | Passthrough, ghostty-vt grid, `scr`, hooks, node sidecar | ✅ done |
| P1 | Input box detection, `./` `/~/` completion, Ctrl+C, path → `cd` | ✅ done |
| P2 | Overlays (menu / dialog / paint), Ctrl+Enter, `notify-send` | ✅ done |
| P3 | Plugin API, `/m` `/w` `/ad` | ✅ done |
| P4 | Ctrl+P settings panel | ✅ done |
| P5 | Chrome tabs: `//` screenshot, `//gh/` URLs, WebMCP | ✅ done |
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
