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
```

需要 `$PATH` 里有 `claude`、Node ≥ 18，支持 macOS 和 Linux。

`npm i -g cld-pi` 会安装同一个程序，命令名仍是 `claude-p`（另有 `cld-pi`）。首次运行时
会打印一行命令，用来在 shell 里把 **Ctrl+P** 绑定为启动 `claude-p`。它只打印，不会替你改
rc 文件。

交互模式会强制 `/tui fullscreen`，并通过 `--settings` 注入 `Notification`、`Stop`、
`SessionStart` 三个 hook。相关文件放在 `~/claude/-p/`：

| 文件 | 说明 |
|---|---|
| `scr` | 当前屏幕的纯文本快照，每帧刷新 |
| `host.log` | node sidecar 的日志 |
| `inspect` | sidecar 的 DevTools 地址 |
| `*.js` | 你的插件（P3 起） |

## 按键

| 按键 | 在输入框里 |
|---|---|
| `./…` + Tab | 用 fzf 选 CC 当前目录下的文件 → 插入 `@路径 `（ctrl-d：选该文件所在文件夹） |
| `/~/…` + Tab | 同上，范围是 `~` |
| Ctrl+C | 清掉光标所在行及下面的行，光标停在新的空行；输入框为空时交给 Claude Code 自己处理 |
| 单行输入 `/~/目录` 后回车 | 不存在就创建 `~/目录`，在允许目录外就先 `/add-dir`，然后 `/clear`，再 `! cd` 过去 |

## 调试插件（F12）

node sidecar 默认开启 inspector，监听 `127.0.0.1:9229`（被占用时换随机端口，地址见
`~/claude/-p/inspect`）。打开 `chrome://inspect` → *inspect*，就能直接使用全局变量 `pi`：

```js
pi`/help`            // 往 Claude Code 里打一行并回车
pi.BUFFER = '草稿'    // 替换输入框内容，不回车（只写）
pi.arg.fzf = "--pointer '▶' --height=60%"   // Tab 补全用的 fzf 参数
await pi.on.stop      // 等下一次 Stop hook
```

`CLAUDE_P_INSPECT=0` 关闭，`CLAUDE_P_INSPECT=<端口>` 指定端口。本机任何能连到这个端口的
程序都能以你的身份执行代码，多人共用的机器上请关掉。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 透传、ghostty-vt 网格、`scr`、hook、node sidecar | ✅ 完成 |
| P1 | 识别输入框、`./` `/~/` 补全、Ctrl+C、输入路径即 `cd` | ✅ 完成 |
| P2 | 叠加层（菜单 / dialog / 涂抹）、Ctrl+Enter、`notify-send` | |
| P3 | 插件 API，`/m` `/w` `/ad` | |
| P4 | Ctrl+P 设置面板 | |
| P5 | Chrome 标签页：`//` 截图、`//gh/` 补全 URL、WebMCP | |
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
