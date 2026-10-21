# cld-pi

[English](./README.md) · **简体中文**

套在 [Claude Code](https://code.claude.com) 外面的交互式外壳，fork 自
[smithersai/claude-p](https://github.com/smithersai/claude-p)。

- **不带参数**运行 `claude-p`：打开 Claude Code（fullscreen TUI），外面包一层薄壳，
  提供前缀补全、叠加层和 JS 插件。
- `claude-p "prompt"`：保持原有行为，可直接替代 `claude -p`。

外壳从不改写 Claude Code 的输出：每个字节原样转发，同时用
[ghostty-vt](https://github.com/ghostty-org/ghostty) 网格镜像屏幕，自己的内容画在上层。

## 安装

```sh
npm i -g cld-pi        # 安装 `claude-p` 命令
```

需要 `$PATH` 里有 `claude`、Node ≥ 18，支持 macOS 和 Linux。

首次运行时，`claude-p` 会打印一行命令，用来在 shell 里把 **Ctrl+P** 绑定为启动
claude-p。它只打印，不会替你改 rc 文件。

## 使用

```sh
claude-p                                   # 交互模式
claude-p "解释一下这个仓库"                  # 输出与 `claude -p` 一致
claude-p --output-format json "总结" < diff.txt
```

交互模式会强制 `/tui fullscreen`，并通过 `--settings` 注入 `Notification`、`Stop`、
`SessionStart` 三个 hook。相关文件放在 `~/claude/-p/`：

| 文件 | 说明 |
|---|---|
| `scr` | 当前屏幕的纯文本快照，每帧刷新 |
| `host.log` | node sidecar 的日志 |
| `*.js` | 你的插件（P3 起） |

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 透传、ghostty-vt 网格、`scr`、hook、node sidecar | ✅ 完成 |
| P1 | 识别输入框、`./` `/~/` 补全、Ctrl+C、输入路径即 `cd` | |
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
