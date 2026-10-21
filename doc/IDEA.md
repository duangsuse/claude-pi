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