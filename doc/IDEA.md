我希望claude code使用 ./ 而非@引用文件，Ctrl+C 只有空输入时打断/退出，且可清空【光标下方】的输入行

确信可以实现。光标仍然是pty光标，只是包一层TUI油猴，处理./后的补齐

经过选型， smithersai/claude-p 适合fork。为其增加交互式模式，目标是支持 ./^ Tab转fzf (下文 ^: caret)，预期行数600左右

覆盖0arg为打开UI，复用 driver.zig / terminal.zig 并把模块名 pi/ 单独接入快捷键事件、帧poll（纯文本，调试时放在 ~/claude/-p/scr ）

通过 //github/ （无com）前缀补齐和提供当前chrome的网页截图也是好点子，//^ 是fzf选择打开(域名/名字)的标签页来截图， /~/^ 等效补齐 ~/ ，如果只输入了路径，回车就!cd过去并/clear。如果不存在就新建

然后再加个Ctrl+Shift+回车=一键粘贴执行功能，加个帧冻结>一分钟时notify-send。 另一个难点是独立显示下拉菜单和居中dialog。可模仿gum风格

或许该做一个gum面板(Ctrl+P)来调粒度，比如，自动调bash命令是否显示（如果没有就基于js插件替换把行置空）。 内容：

/model可以做成四档次slider，/effort 是滑条，plan,norm和auto做三挡， 权限(file/web)可以checkbox

dialog最上面填session名 (cost$) ，下边放四个键科普的按钮 CtrlO CtrlR Undo Copy回复

我还希望有一个类似ChatGPS的JSONL转WebUI前缀概览，要点在于，算出pty模拟上滚多少个PgUp，可以靠poll。 ~/claude/-p/*.js 插件也要设计和支持下

比如， /m 伪命令启动magpie hud， /w 启动 @cloudcli-ai/cloudcli (显示类似http-server的各种地址)， /ad 相当于 /add-dir $1; !tree 用jsAPI实现

//^ 特性可以细化为WebMCP，预先检查和提示用户去浏览器开功能。

claude mcp add chrome-devtools --scope user npx -y chrome-devtools-mcp@latest \
  --config ~/.F12-mcp.json \
  --watchConfig # 添加allowedUrlPattern，提到一个加一个

> 1

那就加ghostty，项目布局仍复用claude-p，只支持 /tui fullscreen 。能用js实现的尽量js，用原项目的打包方法。初次给用户一条echo命令更新rc来trap CtrlP打开自身

Ctrl+Shift+Enter 改成Ctrl+Enter

bash 输出的行置空（全屏sed风格替换功能）改成自己涂掉

直接用 CC 的 Notification/Stop hook。 @ vs ./ 的问题： ./^ 只是个UI hook，输入到里边仍然@

WebUI可以做成chrome app模式resize为小窗口

已修改： /~/^ 等效补齐 ~/ ，如果只输入了路径，回车就!cd过去并/clear。如果不存在就新建

/w 启动 @cloudcli-ai/cloudcli (显示类似http-server的各种地址)， /ad 相当于 /add-dir $1; !tree 用jsAPI都实现为默认插件

整理出新计划，写入 ./goal-v1.md

## 完成度核对（2026-10-22，只读源码，不算测试和手测）

P0–P5 在代码层面全部落地，P6 没有任何代码。功能规格逐条核对如下；"✅"只表示源码里有对应实现，不代表手测通过（阶段表里 P1–P5 仍是"待手测"）。

| 规格条目 | 状态 | 实现位置 |
|---|---|---|
| `./`、`/~/` + Tab → fzf → 退格后注入 `@path ` | ✅ | `main.zig` `onTab` / `replaceToken`，`input.zig` `completion` / `mention`，`fzf.zig` |
| `pi.arg.fzf` 默认 `--cycle --pointer '▶' --bind ctrl-d:…` | ✅ 逐字一致 | `fzf.zig:14` |
| `//` + Tab 选标签页截图 + `.f12.md`；`//gh/`（标签页在前、History 在后） | ✅ | `f12.js`，`cdp.js`（截图超时 `activateTarget` 重试；History 复制一份后 `node:sqlite` 读） |
| `/~/name` + Enter：`mkdir -p`、复制 `cd … && npx cld-pi`、Yakuake/Guake 开 tab、否则粘贴提示 | ✅ | `main.zig` `onEnter`，`rpc.js` `launch`，`tab.js` `openTab` |
| Ctrl+C 退出 → `~/claude/last`(+`.d`)、打印 `To restore #> mv …`、空会话不动、噪声键不算 | ✅ | `convo.zig`，`main.zig` 退出段，`input.isNoise` |
| 滚轮透传 / `whlSpeed` / 叠加层让开 150ms+40ms / `wheel(dir)` | ✅ | `main.zig` `Shared.emit`、`onWheel`、主循环 |
| 双击翻页（400ms、同行 ≤1 格） | ✅ | `onDoubleClick` |
| `cld-pi -a <cmd>` + `pi.arg.border/prompt/bash/busy/running` | ✅ | `otherApp`、`setArg`、`screen.Rules` |
| Ctrl+C 清光标行及以下 | ✅ | `input.ctrlCPlan` |
| Ctrl+Enter 剪贴板 → bracketed paste → 回车（CSI-u / modifyOtherKeys） | ✅ | `onCtrlEnter`，`input.decode` |
| Ctrl+P 面板：名+花费、model/effort/mode 单选、file/web/bash 复选、CtrlO/CtrlR/Undo/Copy、`eachRow [4,5,3,3,4]`、读状态栏回核 | ✅ | `panel.js`，`session.js`（1.25×/2× 写缓存、按模型读缓存价、fast、消息 id 去重） |
| `/m`、`/w`（`pi.ext.webpane`、QR 半格）、`/ad` | ✅ | `magpie.js`、`webpane.js`、`add-dir.js` |
| `/o` 概览 WebUI | ❌ 未开始 | 无 http 服务、无 `--app=`、无 Ctrl+O / PgDn 定位 |
| 命令 stub 进临时 `--plugin-dir`、sidecar 先起、等 `ready` | ✅ | `stubs.js`，`main.zig` `waitReady` |
| 浏览器预检查、单连接复用、1.5s Allow 提示、`~/.F12-mcp.json`（缺则写 `{}`）、MCP 提示只一次 | ✅ | `f12.js` |
| `pi.ext.f12.devtools(url\|id, {reload, ms})` | ✅ | `f12.js`，`cdp.js` `devtools` / `reload` |
| hook 注入 + notify-send（有焦点不弹）、herdry 旋转标题（三种 D-Bus + OSC 2） | ✅ | `hook.zig`，`notify.js`，`herdry.js`，`tab.js` |
| 非模态 dialog：←/→ 接管、Enter/Esc、可点击、`(2s)` 每 0.1s 刷新、交互后停表 | ✅ | `rpc.js` `pi.dialog`，`main.zig` `onToastKey` |
| `fadeX` 渐隐 | ✅ | `overlay.zig` `paintButton` / `fadeIndex` |
| `pi.notify(msg, 'snack'\|'snackRD', {bg})`、pace.js、滚动时透明 | ✅ | `rpc.js`，`pace.js` |
| 插件列表角标、点击开关、撤销 on/sed/定时器 | ✅ | `rpc.js` `showPluginList`、`installTimerHooks` |
| 首次运行打印 rc 命令 + `.installed` | ✅（退出后打印，不是启动时） | `main.zig` `rc_hint` |
| `scr` 仅文件存在时写、退出删 | ✅ | `writeScr` |
| 打包：`CLAUDE_P_JS`、`files` 含 `js/`、mise 0.15.2、4 目标交叉编译 | ✅ | `bin/claude-p.js`、`package.json`、`mise.toml`、`publish.mjs` |
| 交互模式不用 `terminal.zig` | ✅ | `src/pi/main.zig` 没有 import |

### 客观评论

**守住了的原则。** 三条设计原则在代码里都能验证：Zig 只做 pty / 网格 / 按键 / 叠加 / FIFO（`src/pi/` 共约 4100 行），所有产品功能都在 `js/`；CC 的字节流一个字节没改，遮盖全靠 `overlay.render` 追加；事件全部来自 hook，没有自己猜"帧冻结"。`~/.claude/` 只在用户明确要求的 Ctrl+C 退出那一条路径上碰（`convo.zig` 做了路径校验）。

**体量。** 实际代码是预估的两倍多（Zig 4100 vs 2000，JS 2500 vs 1600）。超出的主要在 `main.zig`（1548 行，一个文件装了按键路由、sidecar 协议、主循环、Ctrl+C 退出）和 `overlay.zig`（858 行，大半是 dialog 排版和渐隐）。P5 的 Zig 预估 50 行，实际为了 `pick` 两段式协议改了 `main.zig` 多处。

**脆弱的地方（都是设计上接受的，但要知道在哪）。**
- 全部 UI 识别是启发式：`screen.Rules` 的 5 个字符串 / 字符，`session.js` 里对状态栏（`◐ medium · /effort`、`plan mode on`）、`/model` 回复（`Set model to` / `Kept model as`）、Bash 输出块（`● Bash(` + `⎿` + 5 格缩进）的正则。CC 改一个字就要跟着改；回归只能靠 `testdata/*.vt`。
- 命令 stub 依赖 CC 插件 frontmatter `name:` 注册裸名别名这个行为，以及 CC 只在启动时扫插件目录——所以 sidecar 必须先起，启动多等一次 `ready`（最多 3s）。
- `pi.tui.wait` 是 30ms 一帧轮询 `scr`，不是事件；面板每个控件改完都要 `wait` 状态栏变化，慢但可靠。
- 终端相关假设：D-Bus（Yakuake / Konsole / Guake）、kitty 键盘协议或 modifyOtherKeys（Ctrl+Enter 否则无法区分）、`wl-copy` / `xclip` / `pbcopy` 链。

**性能：滚动的瓶颈在读码时就能看出来。**
1. `onZmuxEvent` 在 zmux 读线程里先 `grid.feed` 再写 stdout，整段持有和主循环共用的 `Shared.mutex`。
2. `◆ plugins n/m` 角标常驻，`overlay.active()` 永远为真：滚轮窗口（150ms）之外每个 CC chunk 都走 `composeFrame`——复制 chunk、`overlay.render`、`restoreCursor`（跑一遍 ghostty `ScreenFormatter`）、再包 `?2026`。
3. `img.js` 注册 `pi.click`，而 `syncSubscribe` 把 click 和 `scr` 绑在一起：只要有输出，每 30ms 一次全屏 `grid.snapshot` + JSON 发给 sidecar，sidecar 再 `rows.join` 一遍。这是默认插件，所以人人都在付这个钱。
三项都在输出热路径上，而滚动期间没有任何人读网格。方案见 goal-v1.md 的"滚动：输出不经过 VT"。

**API：dialog 的命令式句柄收益不大。** `relabel` / `text` / `hint` 每次都是一条 IPC，`panel.js` 的 230 行大半在维护标签字符串（一行单选改一次要发 4–5 条 `dialog_update`，`radio()` / `pick()` / `offset` 都是为此存在）。IPC 既然躲不掉，UI 又只有 Zig 一个消费者，声明式（状态 → 渲染 → diff → 只发变化字段）会更短。方案见 goal-v1.md 的"dialog：Signal API"。

**文档漂移。**
- goal-v1.md 阶段表 P1 行、风险清单里 `! cd` / `/add-dir` / `/clear` 三条、`steps.zig` 头注释，都还是已放弃的"回车 cd 过去"流程；实现是 `/~/` + Enter 开新会话。
- 风险项 "`--settings fileSuggestion`" 没有实现；实际用 `@path` 后的尾随空格关 CC 的 @ 弹窗（`input.mention`）。
- CLAUDE.md 要求先读 `SPEC.md`，仓库和 git 历史里都没有这个文件。
- `img.js` 是规格里没有的新插件（CLAUDE.md 已列，goal-v1.md 没有）。
- 浏览器预检查 dialog 写 "Chrome (144+)" + "allowedUrlPattern 需要 149+"，规格只提 149+。

**P6 的起点。** 不用动多少 Zig：`pi.tui.press('ctrl-o')`、`pi.tui.wait`、`pi.sh`、`pi.ext.webpane.boundPort`、`session.js` 的 `tailEntries` / `messageCost` 都在；缺 http 服务、`chrome --app` 拉起、JSONL → 目录、PgDn-poll 定位循环，以及 `keyBytes` 里的 PgUp / PgDn / Ctrl+Home。