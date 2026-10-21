# cld-pi

[English](./README.md) · **简体中文**

套在 [Claude Code](https://code.claude.com) 外面的交互式外壳，fork 自
[smithersai/claude-p](https://github.com/smithersai/claude-p)。

- **不带参数**运行 `npx cld-pi`：打开 Claude Code（fullscreen TUI），外面包一层薄壳，
  提供前缀补全、叠加层和 JS 插件。
- `npx cld-pi "prompt"`：保持原有行为，可直接替代 `claude -p`。

外壳从不改写 Claude Code 的输出：每个字节原样转发，同时用
[ghostty-vt](https://github.com/ghostty-org/ghostty) 网格镜像屏幕，自己的内容画在上层。

## 运行

```sh
npx cld-pi                               # 交互模式
npx cld-pi -r [id]                       # 交互模式，恢复会话（-c：继续上次）
npx cld-pi "解释一下这个仓库"              # 输出与 `claude -p` 一致
npx cld-pi .json "总结" < diff.txt        # .text / .json / .stream-json 即 --output-format
npx cld-pi -r <id> "接着呢？"              # 在已有会话里以 -p 模式提问
npx cld-pi -a codex                      # 套别的 TUI（用 pi.arg.prompt / busy / … 描述它的界面）
```

需要 `$PATH` 里有 `claude`、Node ≥ 18，支持 macOS 和 Linux。

`npm i -g cld-pi` 会安装同一个程序，命令名仍是 `claude-p`（另有 `cld-pi`）。首次运行时
会打印一行命令，用来在 shell 里把 **Ctrl+P** 绑定为启动 `claude-p`。它只打印，不会替你改
rc 文件。

交互模式会强制 `/tui fullscreen`，并通过 `--settings` 注入 `Notification`、`Stop`、
`SessionStart` 三个 hook；Stop / Notification 在终端没有焦点时弹桌面通知（`notify-send`），默认插件
`herdry` 还会让 Yakuake / Konsole / Guake 的标签标题转起来（`✻ 消息`，其他终端改窗口标题），直到你切回来。相关文件放在 `~/claude/-p/`：

| 文件 | 说明 |
|---|---|
| `scr` | 当前屏幕的纯文本快照，每帧刷新；只在文件存在时写（`touch` 一下开启，退出时删除） |
| `host.log` | node sidecar 的日志；同样存在才写，退出时删除 |
| `inspect` | sidecar 的 DevTools 地址 |
| `*.js` | 你的插件：`export default pi => { … }`（ES module） |

右上角的 `◆ plugins n/m` 角标列出所有插件，点它可以关掉某个插件——它注册的监听、`pi.sed` 和定时器会一起撤掉。插件可以用
`pi.notify(msg, 'snack')` 把自己的文字放到这个位置（右下角用 `'snackRD'`）；默认插件 `pace`
在右下角显示上一条 ● 的耗时和近 3 分钟的花费。两个角点进去都是插件列表。

## 按键

| 按键 | 在输入框里 |
|---|---|
| `./…` + Tab | 用 fzf 选 CC 当前目录下的文件 → 插入 `@路径 `（ctrl-d：选该文件所在文件夹） |
| `/~/…` + Tab | 同上，范围是 `~` |
| `//…` + Tab | 用 fzf 选 Chrome 标签页 → 截图，插入 `@/tmp/….png ` |
| `//gh/…` + Tab | 补全该站点（`gh` → github.com）的 URL，来源是标签页和 Chrome 历史 |
| Ctrl+C | 清掉光标所在行及下面的行，光标停在新的空行；输入框为空时交给 Claude Code 自己处理 |
| 用 Ctrl+C 退出 | 把这次对话从 `~/.claude/projects/` 移到 `~/claude/last`（覆盖上一次的），并打印 `To restore #> mv ~/claude/last …`；空会话不输出；想保留就用 `/exit` 退出 |
| 鼠标滚轮 | 原样交给 Claude Code，滚动时叠加层让开，停下再画回来（`pi.arg.whlSpeed = n`：改成 n 格一次 PgUp / PgDn） |
| 双击 | 顺着上次滚轮的方向翻一页（PgUp / PgDn） |
| Ctrl+Enter | 粘贴剪贴板并提交（终端需支持 kitty 键盘协议或 modifyOtherKeys） |
| Ctrl+P | 设置面板：会话名和花费、model / effort / mode、file / web 权限、隐藏 Bash 输出、CtrlO / CtrlR / Undo / Copy |
| 单行输入 `/~/名字` 后回车 | 创建 `~/claude/名字`，并把 `cd … && npx cld-pi` 复制到剪贴板，在新终端粘贴即可打开 |

## 命令

在输入框里单独一行输入；Claude Code 看不到这些行。

| 命令 | |
|---|---|
| `/ad <目录>` | `/add-dir`（自动确认对话框），然后 `!tree -L 2 <目录>` |
| `/w` | `:3001` 上的 cloudcli Web UI（没有服务就在后台启动），列出 localhost / 局域网 / tailscale 地址；三个按钮：复制局域网地址、复制 tailscale 地址、显示 tailscale 地址的二维码（`npx qrcode-terminal`） |
| `/m` | `~/.local/bin/magpie panel` |

## Chrome

`//` 需要 Chrome 打开远程调试：访问 `chrome://inspect/#remote-debugging` 并允许
（Chrome 144+；每次会话 Chrome 会让你点一次 *Allow*）。用 `//` 或 `//gh/` 选过的站点
会追加到 `~/.F12-mcp.json` 的 `allowedUrlPattern`，这是 chrome-devtools MCP 的配置，
Claude 通过它操作同一个浏览器。第一次用 `//` 时会提示安装命令：

```sh
claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest \
  --autoConnect --config ~/.F12-mcp.json --watchConfig
```

`CLAUDE_P_CDP=9222`（端口或 `ws://` URL）改连别的浏览器。

## 插件

插件是放在 `~/claude/-p/` 的 ES module，默认导出一个接收 `pi` 的函数：

```js
// ~/claude/-p/hello.js
export default pi => {
  pi.command('hi', ([name = 'there']) => pi.dialog({ body: `hello ${name}`, timeout: 2000 }))
  pi.complete('#', tok => ['#bug', '#feat', '#docs'].filter(t => t.startsWith(tok)))
  pi.on({ CtrlG: () => (pi.BUFFER = 'git status', false) })   // 返回 false：不走默认行为
  setInterval(() => {}, 60_000)                                 // 插件被关掉时自动清除
}
```

## 调试插件（F12）

[goal-v1.ipynb](./goal-v1.ipynb)：Jupyter 的 `%%js` magic，通过 CDP :9229 在你的会话里执行代码，附整套接口示例。

node sidecar 默认开启 inspector，监听 `127.0.0.1:9229`（被占用时换随机端口，地址见
`~/claude/-p/inspect`）。打开 `chrome://inspect` → *inspect*，就能直接使用全局变量 `pi`：

```js
pi`/help`            // type a line into Claude Code + Enter
pi.BUFFER = 'draft'  // replace the input box text, no Enter (write-only)
pi.BUFFER=await pi.menu('abc'.split(''))

pi.arg.fzf = "--pointer '▶' --height=60%"   // fzf options for Tab completion
pi.arg.whlSpeed = 5                          // 几格滚轮算一次 PgUp / PgDn（0：透传）
pi.arg.prompt = '>'   // 还有 border、bash、busy、running：怎样识别 TUI 的界面（默认是 CC 的）
pi.notify('3 tests left', 'snack')           // 显示在右上角角标（'' 撤下）
pi.notify('busy', 'snackRD', { bg: 236 })    // 右下角；bg：0-255、'#rrggbb'、'none'（透明）
await pi.dialog({ title: 'Hi', body: 'gum-style', OK: () => {}, Stat: () => pi`/status` })
pi.dialog({ body: 'saved', timeout: 3000, or: 'OK', OK: () => {} })   // 非模态，显示在右上角；←/→、点击、Enter 都会重新计时
pi.sed(ln => ln.includes('secret') ? '' : null)   // blank / rewrite screen rows
await pi.on.stop      // wait for the next Stop hook
```

`CLAUDE_P_INSPECT=<端口>` 指定端口，0关掉共享。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 透传、ghostty-vt 网格、`scr`、hook、node sidecar | ✅ 完成 |
| P1 | 识别输入框、`./` `/~/` 补全、Ctrl+C、输入路径即 `cd` | ✅ 完成 |
| P2 | 叠加层（菜单 / dialog / 涂抹）、Ctrl+Enter、`notify-send` | ✅ 完成 |
| P3 | 插件 API，`/m` `/w` `/ad` | ✅ 完成 |
| P4 | Ctrl+P 设置面板 | ✅ 完成 |
| P5 | Chrome 标签页：`//` 截图、`//gh/` 补全 URL、WebMCP | ✅ 完成 |
| P6 | 会话目录 WebUI | |

完整设计见 [goal-v1.md](./goal-v1.md)，插件 API 草案见 [goal-v1.ts](./goal-v1.ts)。

## 从源码构建

```sh
mise install            # Zig 0.15.2，版本固定在 mise.toml
zig build test          # Zig 单元测试
node --test js/test/*.test.js
zig build -Doptimize=ReleaseSafe
./zig-out/bin/claude-p
```

Linux 上默认目标是 musl（静态链接，与发布版相同）。

## 许可证

[MIT](./LICENSE)。基于 smithersai 的 claude-p（同为 MIT）。
