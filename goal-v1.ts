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
  scrcpy(s: Scr): void             // 每帧触发
  CtrlC(): void | false            // 返回 false 表示不再走默认行为
  [key: `Ctrl${string}` | `Shift${string}`]: (() => void | false) | undefined
}

/** pi.on 既可以传对象注册监听，也可以 await pi.on.xxx 等待下一次事件（通用的 once 监听） */
type On = ((handlers: Partial<Events>) => () => void) & {
  [K in keyof Events]: Promise<Parameters<Events[K]>[0]>
}

/**
 * gum 风格的多行 dialog。
 * 除 title/body/footer 外，其余键都是按钮：键名是按钮文字，值是回调。
 * 回调的 row1 由 DSL 解析得到，插件不需要自己传；回调返回字符串时，用它更新按钮文字（可以用来做 checkbox）。
 */
type Dialog = {
  title?: string
  body?: string
  footer?: string
  OK?(row1: string): string | void
  [button: string]: unknown
}

/** pi.htmlJSONL 返回的通道：收消息、发消息 */
type Channel = {
  (receiver: (json: unknown) => void): void
  (send: string): void
}

interface Pi {
  /** tagged template 写入 pty：pi`/add-dir ${dir}\r` */
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<void>

  /** 注册伪命令 /name */
  command(name: string, run: (args: string[]) => unknown): void
  /** 注册前缀补全：返回候选列表，由 Zig 侧交给 fzf */
  complete(prefix: string, source: (tok: string) => Promise<string[]> | string[]): void
  on: On
  dialog(d: Dialog): Promise<void>
  notify(msg: string): void        // notify-send

  // P2：逐行处理网格。返回字符串就把这一行涂成该文本，返回 null 就涂掉。不改写 CC 的输出字节流
  sed(fn: (ln: string) => string | null): void

  // P6：消息边界和 scrollInView
  mark(name?: string): void
  scrollTo(name: string): Promise<void>
  /** 用 chrome --app 小窗口打开 WebUI，返回双向 JSON 通道 */
  htmlJSONL(strings: TemplateStringsArray, ...values: unknown[]): Channel

  ext: {
    f12: { addTrust(allowedUrlPattern: string): Promise<void> }   // 追加到 ~/.F12-mcp.json
    /** 先检查端口：没被占用就返回该端口，否则返回 null；两种情况都会显示 dialog */
    webpane: { boundPort(port: number): Promise<number | null> }
  }
}

// ---- 示例插件 ----
export default (pi: Pi) => {
  pi.command('ad', async ([dir]) => { await pi`/add-dir ${dir}\r`; await pi`!tree -L 2 ${dir}\r` })
  pi.complete('//', async (tok) => [])
  pi.on({ stop(payload) {}, CtrlC() {} })
  pi.on({ scrcpy(s) {} })
  pi.dialog({ title: 'T', body: '...', footer: '', OK(row1) {} })
  pi.notify('done')

  // P2
  pi.sed(ln => ln || null)

  // P6
  pi.mark('last')
  pi.on({ user(msg) { pi.mark() } })
  pi.scrollTo('last')
  const s = pi.htmlJSONL`WebUI content`
  s(json => {})
  s('send json')

  pi.ext.f12.addTrust('https://github.com/*')
  pi.ext.webpane.boundPort(8080)
}
