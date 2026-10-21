# cld-pi goal v1

Fork 自 [smithersai/claude-p](https://github.com/smithersai/claude-p)：在不带参数运行时打开一个交互式 TUI 外壳，套在 Claude Code 外面。
光标仍是 pty 的真实光标，wrapper 只拦截按键、在上面叠加绘制，并对 `./`、`//`、`/~/` 这几类前缀做补全。

## 设计原则

- **只支持 `/tui fullscreen`**。CC 自己占用 alt-screen，自己处理 PgUp 和滚动，屏幕上的内容都是 CC 一帧一帧画出来的，所以网格判断和叠加重绘都基于这一点。
- **项目布局沿用 claude-p**：`src/*.zig`、`build.zig`、`bin/claude-p.js` 作为 node shim、`scripts/install.js` 负责 postinstall 下载 prebuilt、`scripts/publish.mjs` 交叉编译 4 个目标后发布到 GH release 和 npm。
- **能用 JS 写的都用 JS**。Zig 只负责 pty、VT 网格、按键路由、叠加绘制和 hook FIFO；补全来源、命令、浏览器、WebUI 都放进 node sidecar 和插件里。
- **加入 ghostty-vt 作为 VT 网格**，用来判断输入框、上帧 poll 和重绘。
- **不改写 CC 的输出字节流**，所有遮盖都是 wrapper 自己在上面涂。
- **事件一律走 CC hook**（Notification / Stop / SessionStart），不自己检测帧冻结。

## 架构

```
真实终端 (raw, kitty kbd protocol)
   │ 按键                    ▲ CC 帧 + 叠加层 (CSI ?2026 同步输出)
   ▼                         │
claude-p (Zig) ── 0 参数 → src/pi/  交互模式
   ├─ zmux NativeSession ── claude (pty, fullscreen)
   ├─ ghostty-vt 网格 ── 每帧 → ~/claude/-p/scr (纯文本, 调试用; 文件存在才写, 退出时删)
   ├─ 按键路由: 前缀触发 / Ctrl+C / Ctrl+Enter / Ctrl+P / Tab
   ├─ 叠加层: 下拉菜单, 居中 dialog, 涂抹 (gum 风格)
   ├─ hook FIFO ← --settings 注入的 Notification/Stop/SessionStart
   └─ JSON-lines RPC (stdio) ⇄ node sidecar  js/host.js
                                  ├─ 默认插件 js/plugins/*.js (随 npm 包发布)
                                  └─ 用户插件 ~/claude/-p/*.js
```

- 有参数时保持原来的 `claude -p` 兼容行为；不带参数时进入 `src/pi/`。
- `terminal.zig` 的伪造 DEC 应答只在 `-p` 模式下用；交互模式由真实终端自己应答。
- shim `bin/claude-p.js` 通过环境变量 `CLAUDE_P_JS=<pkg>/js` 把 sidecar 的路径告诉二进制；`package.json` 的 `files` 加上 `js/`。
- 工具链：用 mise 固定 Zig 0.15.2（本机是 0.16.0，和原项目的 API 不兼容）。

## 功能规格

### 输入
| 触发 | 行为 |
|---|---|
| `./` + Tab | fzf 选文件。这只是 UI hook，**插入到输入框里的仍是 `@path`**（先退格删掉已输入的 `./xxx`，再注入 `@path `） |
| `/~/` + Tab | 等同于补全 `~/` |
| fzf 参数 | `pi.arg.fzf` 可调，默认 `--cycle --pointer '▶' --bind 'ctrl-d:become(dirname -- {})'`（`--cycle` 循环滚动；ctrl-d 选中当前项所在文件夹） |
| `//` + Tab | 打开 fzf 选 Chrome 标签页（按域名或标题），选中后截图，插入 `@/tmp/…png` |
| `//gh/` + Tab | 按站点前缀补全 URL，来源是标签页列表和历史 |
| 单行输入且以 `/~/` 开头时按回车 | 拦截 Enter：`mkdir -p ~/claude/X`（`/~/wtf` → `~/claude/wtf`），把 `cd '~/claude/X' && npx cld-pi` 复制到剪贴板（`wl-copy`，回退 `xclip` / `pbcopy`）。下拉终端（Yakuake / Guake）直接用 D-Bus 建一个 tab 并在里面运行；其他终端弹 dialog 提示粘贴（含剪贴板不可用的说法）。当前会话不切目录、不 `/clear` |
| Ctrl+C 退出 CC | 转发给 CC 的最后一个键是 Ctrl+C 且 CC 随即退出（3 秒内）时，把该会话的 `<session>.jsonl` 移到 `~/claude/last`（同名目录移到 `last.d`，覆盖上一次），打印 `To restore #> mv ~/claude/last <原路径>`；没有用户消息的空会话不动、不输出。鼠标移动、焦点上报、kitty 的按键释放和单独的修饰键不算“最后一个键” |
| 鼠标滚轮 | 默认原样透传（`pi.arg.whlSpeed = 0`）：滚动期间叠加层完全让开，滚轮停下 150ms 且输出静止 40ms 后再画回来；`whlSpeed = n` 时改成 n 格一次 PgUp / PgDn（方向改变或停顿 500ms 重新计数）。每次滚动向插件发 `wheel(dir)` 事件 |
| 双击 | 单纯的左键双击（400ms 内、同一行相差 ≤1 格）：第一下照常给 CC，第二下变成顺着上次滚轮方向的 PgUp / PgDn |
| `cld-pi -a <cmd>` | 套 claude 以外的 TUI（不注入 hook / settings）；界面识别用 `pi.arg.border` / `prompt` / `bash` / `busy` / `running`，默认值是 CC 的硬编码（优化路径） |
| Ctrl+C | 输入框为空时透传给 CC（打断或退出）；不为空时只清掉**光标所在行及下方**的输入行，保留前面的换行，光标停在新的空行上 |
| Ctrl+Enter | 读剪贴板（`wl-paste`，回退 `xclip` / `pbpaste`），用 bracketed paste 注入后回车执行。需要终端发出 `CSI 13;5u`（kitty 协议）或 `CSI 27;5;13~`（modifyOtherKeys），否则和 Enter 无法区分 |
| Ctrl+P | 打开设置面板 |

### Ctrl+P 面板（gum 风格居中 dialog）
- 顶部：session 名和花费 `$`（从 transcript 的 usage 计算）
- `/model` 四档 slider，`/effort` 滑条，plan / acc（accept edits）/ auto 三档（注入 Shift+Tab，并从状态栏读出当前档）
- 权限 checkbox：file / web，写进 `.claude/settings.local.json`，CC 会热加载
- 「显示 bash 输出」开关：关掉后由 wrapper 在网格中识别 Bash 工具块，用背景色涂掉
- 底部四个按钮，active时显示Hint：CtrlO（transcript）、CtrlR（历史搜索）、Undo（Esc Esc 回退）、Copy 回复（`/copy`）

实现说明（`js/plugins/panel.js`，数据解析在 `js/session.js`）：
- 全部是按钮，每行横向均分：`eachRow: [4,5,3,3,4]` = model（haiku sonnet opus fable）/ effort（low…max）/ mode（plan acc auto）三行单选（`● 当前` `○ 其他`，用 `{...Object.fromEntries(list.map(…))}` 生成），file / web / bash 三个复选框，CtrlO / CtrlR / Undo / Copy；聚焦时 footer 显示 hint。单选确认后通过 dialog 句柄 `relabel` 整行改字。
- model 用 CC 的别名 `/model haiku|sonnet|opus|fable`（跟随用户自己的模型配置），等到屏幕出现 "Set model to …" 才更新标签。
- effort 用 `/effort <级别>`，从状态栏 `◐ medium · /effort` 读回；CC 若弹出滑条则按 ←/→ 走过去再回车。
- mode：CC 的循环是 auto → manual → accept edits → plan；面板的 acc = accept edits，按 Shift+Tab 直到状态栏读到目标档。
- 花费：transcript 中 assistant 消息按 id 去重后按价目表计算（1.25×/2× 写缓存、按模型的读缓存价、Opus 5.5 fast 模式）；session 名取 custom-title，否则 ai-title。

### 伪命令（默认插件，用 JS API 实现）
| 命令 | 实现 |
|---|---|
| `/m` | `pi.sh` 启动 `~/.local/bin/magpie panel`；找不到就弹窗，OK 复制安装命令 `curl -fsSL https://usemagpie.ai/install.sh \| sh` |
| `/w`（`webpane.js`，同时发布 `pi.ext.webpane`） | 如果:3001没有，后台运行 `npx @cloudcli-ai/cloudcli`，像 http-server 那样在 dialog 里列出 局域网 IP 和 tailscale 地址、localhost；三个按钮：复制局域网地址 / 复制 tailscale 地址 / 显示 tailscale 二维码（`npx qrcode-terminal`，转成半格字符放进 body） |
| `/ad X` | `/add-dir X`（等到 "Yes, for this session" 就回车确认），然后 `!tree -L 2 X` |
| `/o` | 打开概览 WebUI（见下） |

`pi.command` 注册的每个名字都会在本次运行的临时插件目录（`$TMPDIR/claude-p-<pid>-<rand>/plugin`，通过 `claude --plugin-dir` 加载；**不写项目目录，也不写 `~/.claude`**）里写一个 stub：frontmatter `name: <名字>` 让裸名字成为别名，`description` 是零宽空格（自动补齐里不显示说明），所以输入 `/ad` 能匹配到 `cldp-pi:ad (ad)`。CC 只在启动时扫描插件命令、不会热加载，因此 sidecar 先于 claude 启动，`src/pi/main.zig` 等到它的 `ready` 消息再 spawn claude；stub 随命令注销 / 进程退出删除，不覆盖已有的同名文件；wrapper 拦截这一行，所以 stub 正文永远不会被执行。

插件 API 草案见 [`goal-v1.ts`](./goal-v1.ts)（仅作文档，不做类型检查）。

### 浏览器（WebMCP）
- 预检查：先探测 Chrome 的远程调试，没开就弹 dialog 引导用户去 `chrome://inspect/#remote-debugging`（并提示需要 Chrome 149+）。
- 标签页列表、截图和控制台：JS 插件直接走 CDP（`Target.getTargets`、`Page.captureScreenshot`、`Runtime.enable` / `Log.enable`）。
- MCP 给 Claude 用。首次运行时提示安装命令（`--` 不能省）：
  ```
  claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest \
    --autoConnect --config ~/.F12-mcp.json --watchConfig
  ```
- 提到哪个站点就往 `~/.F12-mcp.json` 的 `allowedUrlPattern` 追加一条（可热加载）。该文件必须事先存在，否则 `--watchConfig` 会报错，所以插件要先创建它。

实现说明（`js/plugins/f12.js`，CDP 客户端在 `js/cdp.js`，只用 Node 自带的 `WebSocket` / `node:sqlite`）：
- 连接：`CLAUDE_P_CDP=<端口|URL>`（agent 测试用 9224）优先，否则读 Chrome 用户目录里的 `DevToolsActivePort`（chrome://inspect 打开远程调试后写出）。整个会话复用一条连接（每条新连接 Chrome 都可能要用户点 Allow；1.5 秒没连上就弹非模态提示）。
- `pi.complete(prefix, source, pick)`：fzf 选中后不直接输入，先把那一行交给 `pick(item, tok)`，输入它返回的文字（null 不输入）。Zig 侧：`complete_result` 带 `pick:true` 时回 `picked`，等 `pick_result`。
- `//` + Tab：候选是 `标题 — 域名`；选中后 `Page.captureScreenshot`（后台标签不绘制，超时就 `Target.activateTarget` 再截一次），写到 `$TMPDIR/cld-pi-<域名>-<时间>.png`；同时 attach 读一份控制台（`Runtime.enable` / `Log.enable` 会重放已有消息），连同 URL 和 MCP 提示写成同名 `.f12.md`，输入 `@png @md`。
- `pi.ext.f12.devtools(url|targetId, {reload, ms})`：读取标签页实时的 console / 未捕获异常 / 网络错误。`reload: true` 先 `Page.reload` 并等 `Page.loadEventFired`（最多 `ms`），使重放从新页面开始；`ms` 也是收集重放的时间。插件和 `%%js` / `scripts/cdp-eval.mjs` 可直接调用。
- `//gh/` + Tab：标签页 URL 在前，历史（最近使用的 profile 的 `History`，复制一份再读）在后；站点名是域名前缀，或按顺序出现在域名第一段里（`gh` → github.com）。
- 站点 → `allowedUrlPattern`：`<协议>//<host>/*`。文件不存在时写 `{}`（不能写空数组，MCP 会拒绝空的 `allowedUrlPattern`）。
- MCP 提示：第一次 `//` 截图后，`~/.claude.json` 里没有 `chrome-devtools` 就弹出安装命令（Copy / Later），只提示一次（`~/claude/-p/f12-mcp-offered`）。chrome-devtools-mcp 1.11.0 还没有 `--watchConfig`，只会打印 Unknown arguments，不影响启动。

### 概览 WebUI
- 从 transcript JSONL 生成类似 ChatGPT 的「每轮提问前缀」目录，sidecar 起一个本地 http 服务。
- 用 `chrome --app=http://127.0.0.1:PORT --window-size=420,800` 打开成小窗口。
- 点击某一条后：wrapper 向 pty 发 Ctrl+O transcript 搜索。

### 事件
- 用 `--settings` 内联注入 Notification、Stop、SessionStart hook，沿用原项目的 FIFO 机制。
- Notification 和 Stop 事件 → `notify-send`；事件同时转发给插件的 `pi.on`。由默认插件 `js/plugins/notify.js` 实现：终端有焦点时（CC 打开了焦点上报 `?1004`）不弹。
- 默认插件 `js/plugins/herdry.js`：`pi.notify` 时把标签标题换成 CC 风格的旋转字符 + 消息（`·✢*✶✻✽✻✶*✢`），直到终端获得焦点再恢复。Yakuake 用 `setTabTitle`（Konsole 会话 `/Sessions/N` 对应 Yakuake 终端 N-1，并核对 D-Bus 名字的 owner），Konsole 用 `Session.setTitle(1)`，Guake 用 `rename_tab_uuid($GUAKE_TAB_UUID)`，其他终端用 OSC 2 窗口标题。
- 滚轮防抖：滚轮滚动期间（最近一次滚轮上报 150ms 内）CC 的帧直接输出，角标 / 右上角提示 / 涂抹层等输出静止 40ms 后再补画一次；模态 dialog 和菜单仍每帧重画。
- 非模态 dialog：←/→ 选过之后 Enter 按下、Esc 关闭（直到有键交给 CC）；按钮可以鼠标点击（模态 dialog 也可以）。正文末尾实时显示 `(2s)` 这样剩余的延时（每 0.1s 更新）；一旦交互（←/→、点击、Enter）就停止计时并去掉这个标记，toast 留在原地等着被按下或 Esc 关掉。
- dialog 的按钮背景默认在左右各 `fadeX/2` 列内渐隐到黑色（`pi.dialog({ fadeX })`，0 关闭），避免色块硬边。
- `pi.notify(msg, 'snack' | 'snackRD')`：文字放到右上角角标（替换 `◆ plugins n/m`）或右下角，点进去仍是插件列表；默认插件 `pace.js` 用右下角显示上一条 ● 的耗时（下一条在路上时实时计时）和近 3 分钟的花费（复用 session.js 的计价和去重）；滚轮滚动时变透明（`{ bg: 'none' }`），停下 0.5s 恢复。第三个参数 `{ bg }` 设背景：0-255、`'#rrggbb'`、`'none'`。
- 插件列表：右上角 `◆ plugins n/m` 角标，鼠标点击（SGR 鼠标上报）打开一行一个按钮的 dialog（`eachRow: 'vertical'`），Enter 开关某个插件；关闭即撤销它的 pi.on / pi.sed / 定时器（宿主 hook 了 setInterval / setTimeout）。

### 首次运行
检测到 `~/claude/-p/.installed` 不存在时，打印一条命令让用户自己执行（只打印，不自动修改 rc）：
```sh
echo 'claude-p-w(){ BUFFER=claude-p; zle accept-line }; zle -N claude-p-w; bindkey "^P" claude-p-w' >> ~/.zshrc
#bash同理
```
在 shell 里按 Ctrl+P 就打开 claude-p；进入 claude-p 后，Ctrl+P 打开设置面板。

## 阶段

| 阶段 | 内容 | Zig | JS | 验收 |
|---|---|---|---|---|
| **P0 底座** ✅ | fork；0 参数进入 `src/pi/`；raw 模式双向透传；SIGWINCH；ghostty-vt；每帧写 `scr`；强制 fullscreen；首次运行打印 rc 命令；node sidecar 和 RPC 骨架；打包流程加入 `js/` | 450 | 120 | `claude-p` 打开后和直接运行 `claude` 体验一致，`scr` 内容和屏幕一致 |
| **P1 输入核心** ✅ 待手测 | 识别输入框（边框、占位符的灰色 SGR）；Ctrl+C 两种语义；Tab 前缀路由，fzf 在真实 tty 运行后按网格重绘；`./`、`/~/` 补全插入 `@`；只输路径时回车 cd，不存在则新建，之后 `/clear` | 400 | 120 | 补全、清行、cd 三个场景各手测 10 次无错乱 |
| **P2 叠加层和按键** ✅ 待手测 | gum 风格的下拉菜单、dialog、涂抹层（同步输出，CC 每帧画完后重新涂）；kitty 键盘协议；Ctrl+Enter 粘贴执行；hook 事件接 notify-send | 500 | 60 | CC 正在流式输出时打开 dialog 不闪烁，关闭后画面完全恢复 |
| **P3 插件系统和默认插件** ✅ 待手测 | 插件 API；加载 `~/claude/-p/*.js`；`/m`、`/w`、`/ad` | 150 | 350 | 写一个用户插件能自动加载，3 个默认命令都能用 |
| **P4 Ctrl+P 面板** ✅ 待手测 | 按钮；session 名和花费；bash 输出涂抹开关；基于 pi.dialog({}) 的面板 | 350 | 250 | 每个控件都和 CC 实际状态同步（改完后从状态栏读回来核对） |
| **P5 浏览器** ✅ 待手测 | 预检查；`//` 选标签页截图 + 控制台快照（`.f12.md`）；`//gh/` 补全；`pi.ext.f12.devtools` 实时读取；维护 `~/.F12-mcp.json`；提示 MCP 安装命令 | 50 | 380 | 能选中标签页并插入 `@png @f12.md`，Claude 能读到截图和 URL / 控制台；插件能实时问同一个标签页 |
| **P6 概览 WebUI** | JSONL 转目录；chrome app 小窗口；进 Ctrl+O，按 Ctrl+Home 跳到顶部，然后一边 PgDn 一边 poll | 100 | 350 | 50 轮的会话里点任意一条都能定位到 |
| **合计** | | ~2000 | ~1600 | |

## 风险和待确认

- **`/tui fullscreen` 的持久化方式**：`claude --settings '{"tui": "fullscreen"}'`（已确认：CC 会把 `tui:"fullscreen"` 写进 userSettings）
- **网格识别是启发式的**：输入框边框、占位符、状态栏档位、Bash 工具块都靠 UI 文本和样式识别，CC 改版就要跟着改。识别规则集中放在一个 `pi/screen.zig` 里，并用 `scr` 快照写回归测试。
- **注入 `@path` 后 CC 会弹出自己的 @ 补全框**： --settings fileSuggestion（已确认格式 `{"type":"command","command":"…"}`）
- **Ctrl+Enter 依赖终端支持 kitty 键盘协议**（kitty、ghostty、foot、alacritty ≥0.13 都支持）；覆盖CC的 Ctrl+Enter（CC 默认把它绑定为 `chat:sendNow`）。
- **涂抹层在 CC 高频刷帧时可能闪烁**：必须用同步输出，在同一次 write 里把 CC 的帧和涂抹一起发出去。
- **`! cd` 在允许目录之外会被 CC 重置回原目录**，所以先 `/add-dir`。
- **`/clear` 也会把 cwd 重置回启动目录**（已实测），所以先 `/clear` 再 `! cd`。
- **`!` 命令执行完后 CC 会自动开始一轮模型调用**（已实测），cd 流程里由 wrapper 立刻 Esc 打断，仍会产生少量 token 消耗。
- **allowedUrlPattern 需要 Chrome 149+**；不在白名单里的标签页会被 MCP 静默断开。
- ~~**构建尚未实测**~~：P0 已用 Zig 0.15.2 跑通 `zig build`（Linux 默认 musl，见 CLAUDE.md Gotchas）。ghostty-vt 固定在 v1.3.1（最后一个支持 0.15.2 的 tag）。
