// cld-pi 插件 API 草案（goal-v1）。仅作规格文档，项目不做类型检查。
// 默认插件放在 js/plugins/*.js，用户插件放在 ~/claude/-p/*.js，都由 js/host.js 加载。

/** 当前网格的纯文本快照，每帧写一次，和 ~/claude/-p/scr 内容相同 */
type Scr = { text: string; rows: string[]; cursor: { row: number; col: number } }

/** CC hook 事件（通过 --settings 注入）和按键事件。按键名只支持 C/S/A 修饰键前缀，如 CtrlC */
interface Events {
  stop(payload: { transcript_path: string; session_id: string }): void
  notification(payload: { message: string }): void
  sessionStart(payload: { session_id: string; cwd: string }): void
  user(msg: string): void          // 用户提交了一条消息（P6）
  focus(focused: boolean): void    // 终端焦点变化（来自 CSI I / CSI O）
  scrcpy(s: Scr): void             // 每帧触发
  CtrlC(): void | false            // 返回 false 表示不再走默认行为
  [key: `Ctrl${string}` | `Shift${string}`]: (() => void | false) | undefined
}

/** pi.on 既可以传对象注册监听，也可以 await pi.on.xxx 等待下一次事件（通用的 once 监听） */
type On = ((handlers: Partial<Events>) => () => void) & {
  [K in keyof Events]: Promise<Parameters<Events[K]>[0]>
}

/**
 * 按钮回调：单参函数。row1 由 DSL 解析得到，插件不需要自己传；
 * 返回字符串时，用它更新按钮文字（可以用来做 checkbox）。
 */
type Button = (row1: string) => string | void

/**
 * gum 风格的多行 dialog。
 * 除 title/body/footer 外，其余键都是按钮：键名是按钮文字，值是 Button。
 * 没有硬编码的 OK，`OK` 只是一个叫 OK 的普通按钮。
 * ←/→/Tab 切换按钮，Enter 按下，Esc 关闭。按钮返回字符串：改按钮文字、dialog 保持打开；
 * 返回其他值：关闭 dialog。row1 目前是 body 的第一行。
 */
type Dialog = {
  title?: string
  body?: string
  footer?: string
} & {
  [button: string]: Button
}

/** pi.htmlJSONL 返回的通道：收消息、发消息 */
type Channel = {
  (receiver: (json: unknown) => void): void
  (send: string): void
}

interface Pi {
  /**
   * tagged template：用这一行替换输入框内容并回车，pi`/add-dir ${dir}`。
   * 暂时用 String.raw 处理：反斜杠原样写入。
   */
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<void>

  /** 替换输入框内容，不回车（类似 zsh 的 BUFFER）。先做成只写，读取得到 undefined */
  BUFFER: string

  /** wrapper 的可调参数。fzf：附加在内置参数之后的 fzf 参数（shell 语法），
   *  默认 `--pointer '▶' --bind 'ctrl-d:become(dirname -- {})'`（ctrl-d 选中当前项所在的文件夹） */
  arg: { fzf: string }

  /** 注册伪命令 /name */
  command(name: string, run: (args: string[]) => unknown): void
  /** 注册前缀补全：返回候选列表，由 Zig 侧交给 fzf */
  complete(prefix: string, source: (tok: string) => Promise<string[]> | string[]): void
  on: On
  /** resolve 为按下的按钮文字；Esc 关闭时为 null */
  dialog(d: Dialog): Promise<string | null>
  /** 输入框上方的下拉菜单，↑/↓ 选择、Enter 确认；resolve 为选中项，Esc 为 null */
  menu(items: string[]): Promise<string | null>
  /**
   * 鼠标点击网格某一行时回调，i_row 是屏幕行号（0 起）。
   * 点在输入框箭头（❯）那一行及其下方的不算：输入框、状态栏的点击照常交给 CC。
   */
  click(handler: (i_row: number) => void): () => void
  notify(msg: string): void        // notify-send（macOS 用 osascript）
  /** 最近一帧网格；只有调用过 pi.sed 或订阅后才会每帧更新 */
  state: { cols: number; rows: number; focused?: boolean; scr: Scr | null }

  // P2：逐行处理网格。返回字符串就把这一行涂成该文本（'' 即涂掉）；返回 null 表示不改这一行
  //（用来优化：跳过该行，不是涂掉）。多个 sed 按注册顺序串联。不改写 CC 的输出字节流
  sed(fn: (ln: string) => string | null): void

  // P6：消息边界和 scrollInView
  mark(name?: string): void
  scrollTo(name: string): Promise<void>
  /** 用 chrome --app 小窗口打开 WebUI，返回双向 JSON 通道。普通函数，不做模板注入 */
  htmlJSONL(html: string): Channel

  ext: {
    f12: { addTrust(allowedUrlPattern: string): Promise<void> }   // 追加到 ~/.F12-mcp.json
    /** 先检查端口：没被占用就返回该端口，否则返回 null；两种情况都会显示 dialog */
    webpane: { boundPort(port: number): Promise<number | null> }
  }
}

// ---- 示例插件 ----
export default (pi: Pi) => {
  pi.command('ad', async ([dir]) => { await pi`/add-dir ${dir}`; await pi`!tree -L 2 ${dir}` })
  pi.complete('//', async (tok) => [])
  pi.on({ stop(payload) {}, CtrlC() {} })
  pi.on({ scrcpy(s) {} })
  pi.dialog({ title: 'T', body: '...', footer: '', OK(row1) {}, '[ ] web': row1 => '[x] web' })
  pi.click(i_row => {})
  pi.BUFFER = '草稿，不回车'
  pi.arg.fzf = "--pointer '▶' --height=60%"
  pi.notify('done')

  // P2
  pi.sed(ln => ln.includes('secret') ? '' : null)

  // P6
  pi.mark('last')
  pi.on({ user(msg) { pi.mark() } })
  pi.scrollTo('last')
  const s = pi.htmlJSONL('<h1>WebUI content</h1>')
  s(json => {})
  s('send json')

  pi.ext.f12.addTrust('https://github.com/*')
  pi.ext.webpane.boundPort(8080)
}
