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
  CtrlC(): void | false            // 返回 false 表示不再走默认行为（Zig 最多等 80ms 的回答；只有被监听的键才会问）
  [key: `Ctrl${string}` | `Shift${string}`]: (() => void | false) | undefined
}

/** pi.on 既可以传对象注册监听，也可以 await pi.on.xxx 等待下一次事件（通用的 once 监听） */
type On = ((handlers: Partial<Events>) => () => void) & {
  [K in keyof Events]: Promise<Parameters<Events[K]>[0]>
}

/**
 * 按钮回调：无参函数。返回字符串时，用它更新按钮文字（可以用来做 checkbox，
 * Ctrl+P 面板就是一组热替换文字的按钮）。
 */
type Button = () => string | void

/**
 * gum 风格的多行 dialog。
 * 除 title/body/footer 外，其余键都是按钮：键名是按钮文字，值是 Button。
 * 没有硬编码的 OK，`OK` 只是一个叫 OK 的普通按钮。
 * ←/→/Tab 按顺序切换按钮，↑/↓ 换行（保持列），Enter 按下，Esc 关闭。
 * 按钮返回字符串：改按钮文字、dialog 保持打开；返回其他值：关闭 dialog。
 */
type Dialog = {
  title?: string
  body?: string
  footer?: string
  /** 非模态：显示在右上角，只借用 ←/→ 选按钮（其余键照常给 CC）；timeout 毫秒后按下选中的按钮
   *  （初始选中 `or`；没有 or 且没动过则 resolve null） */
  timeout?: number
  or?: string
  /** 每行几个按钮：[2, 2] 即两行各两个（列对齐，最后一个数字重复使用）；'vertical' 一行一个（列表，如插件列表）。默认全在一行 */
  eachRow?: number[] | 'vertical'
  /** 按钮获得焦点时在 footer 显示的说明，键是按钮的初始文字 */
  hints?: Record<string, string>
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
   * tagged template：用这一行替换输入框内容并回车，pi`/add-dir ${dir}`；打完后 resolve。
   * 暂时用 String.raw 处理：反斜杠原样写入。开头的 `!` 单独先打，让 CC 进入 bash 模式。
   */
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<void>

  /** 注册伪命令 /name：单行 `/name a b` 回车时拦截（CC 看不到），run(['a','b']) */
  command(name: string, run: (args: string[]) => unknown): void
  /** 注册前缀补全：Tab 时以该前缀开头的词交给 source，候选由 Zig 侧交给 fzf，选中项原样替换该词 */
  complete(prefix: string, source: (tok: string) => Promise<string[]> | string[]): void


  // P2：逐行处理网格。返回字符串就把这一行涂成该文本（'' 即涂掉）；返回 null 表示不改这一行
  //（用来优化：跳过该行，不是涂掉）。多个 sed 按注册顺序串联。i / rows 提供上下文。不改写 CC 的输出字节流
  sed(fn: (ln: string, i: number, rows: string[]) => string | null): () => void
  on: On
  /** resolve 为按下的按钮文字；Esc 关闭时为 null */
  /** resolve 为按下的按钮文字；Esc 关闭时为 null。返回的 Promise 也是句柄：relabel(按钮文字或序号, 新文字)、text({ title, body, footer }) */
  dialog(d: Dialog): Promise<string | null> & { relabel(from: string | number, to: string): void; text(t: { title?: string; body?: string; footer?: string }): void }
  /** 输入框上方的下拉菜单，↑/↓ 选择、Enter 确认；resolve 为选中项，Esc 为 null */
  menu(items: string[]): Promise<string | null>
  /**
   * 鼠标点击网格某一行时回调，i_row 是屏幕行号（0 起）。
   * 点在输入框箭头（❯）那一行及其下方的不算：输入框、状态栏的点击照常交给 CC。
   */
  click(handler: (i_row: number) => void): () => void
  notify(msg: string): void        // notify-send（macOS 用 osascript）
  /** 跑一行 shell：插值的值会被单引号转义（防注入）；shell 退出即 resolve，长期运行的程序在行尾加 & */
  sh(strings: TemplateStringsArray, ...values: unknown[]): Promise<{ code: number; stdout: string; stderr: string }>
  /** 终端侧的辅助 */
  tui: {
    /** 按一个键，排在之前的 pi`…` 之后：enter esc tab shift-tab backspace up down left right ctrl-c */
    press(key: string): Promise<void>
    /** 等屏幕出现某段文字（或谓词为真），超时 resolve false；默认 3000ms */
    wait(cond: string | ((s: Scr) => boolean), ms?: number): Promise<boolean>
    /** 当前插件被关掉时调用（恢复插件在注册表之外改过的东西，如标签标题） */
    dispose(fn: () => unknown): void
    /** 本终端的标签标题：Yakuake / Konsole / Guake 走 D-Bus，其他终端用窗口标题（OSC 2）；title(null) 恢复原标题 */
    title(text: string | null): Promise<void>
    /** focused 来自终端的焦点上报，初始为 true；scr 是最近一帧网格（调用过 sed / wait 才每帧更新） */
    state: { cols: number; rows: number; focused: boolean; scr: Scr | null }
  }

  // P6：消息边界和 scrollInView
  mark(name?: string): void
  scrollTo(name: string): Promise<void>
  /** 用 chrome --app 小窗口打开 WebUI，返回双向 JSON 通道。普通函数，不做模板注入 */
  htmlJSONL(html: string): Channel

  /** 插件之间共享的扩展：核心只提供空对象，由同名插件发布（webpane.js → pi.ext.webpane，f12.js → pi.ext.f12） */
  ext: {
    f12: { addTrust(allowedUrlPattern: string): Promise<void> }   // f12.js（P5）：追加到 ~/.F12-mcp.json
    /** webpane.js：先检查端口，没被占用就返回该端口，否则返回 null；两种情况都会显示 dialog */
    webpane: { boundPort(port: number): Promise<number | null> }
  }
}

// ---- 插件注册表（js/host.js）----
// 默认插件 js/plugins/*.js 和用户插件 ~/claude/-p/*.js 都在各自的 AsyncLocalStorage 上下文里运行；
// pi.on / pi.sed / setInterval / setTimeout（宿主已 hook）都记到所属插件名下。
// 右上角 ◆ 角标打开插件列表，关掉某个插件即撤销它的全部注册，再打开会重新执行它的默认导出。

// ---- 示例插件 ----
export default (pi: Pi) => {
  pi.command('ad', async ([dir]) => { await pi`/add-dir ${dir}`; await pi`!tree -L 2 ${dir}` })
  pi.complete('//', async (tok) => [])
  pi.on({ stop(payload) {}, CtrlC() {} })
  pi.on({ scrcpy(s) {} })
  pi.dialog({ title: 'T', body: '...', footer: '', OK() {}, '[ ] web': () => '[x] web' })
  pi.dialog({ title: 'Ctrl+P', eachRow: [2, 2], model() {}, effort() {}, plan() {}, web() {} })
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
