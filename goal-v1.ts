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
  wheel(dir: -1 | 1): void         // 鼠标滚轮（-1 向上翻历史）
  scrcpy(s: Scr): void             // 每帧触发
  CtrlC(): void | false            // 返回 false 表示不再走默认行为（Zig 最多等 80ms 的回答；只有被监听的键才会问）
  [key: `Ctrl${string}` | `Shift${string}`]: (() => void | false) | undefined
}

/** pi.on 既可以传对象注册监听，也可以 await pi.on.xxx 等待下一次事件（通用的 once 监听） */
type On = ((handlers: Partial<Events>) => () => void) & {
  [K in keyof Events]: Promise<Parameters<Events[K]>[0]>
}

/**
 * 按钮：一个函数同时负责渲染和响应（P7）。
 * up = false：host 取标签，返回字符串（undefined 用键名）。
 * up = true：按下（Enter / 点击）。返回 undefined 关闭 dialog（resolve 为键名，`OK() {}` 照旧）；
 * 其他返回值保持打开，整个 dialog 重新求值、和上次发出的 diff、只发变化的字段——
 * 所以单选时旧 ● 新 ○ 一起变，不用记旧焦点。
 */
type Button = (up: boolean) => string | unknown

/** P7：pi.onEmit 返回的读 / 写对：u.x 读，setU.x(2) 写，setU({ x: 2 }) 批量写；写入合并到下一 microtask 重新渲染。
 *  给 await 之后 / 定时器里的更新用；同步状态用闭包变量即可，按下本身就会重渲染 */
type Signal<T extends object> = [Readonly<T>, { [K in keyof T]: (v: T[K]) => void } & ((patch: Partial<T>) => void)]
/** 文本字段可以是函数，每次渲染重新求值 */
type Text = string | (() => string)

/**
 * gum 风格的多行 dialog。
 * 除 title/body/footer 外，其余键都是按钮：键名是按钮文字，值是 Button。
 * 没有硬编码的 OK，`OK` 只是一个叫 OK 的普通按钮。
 * ←/→/Tab 按顺序切换按钮，↑/↓ 换行（保持列），Enter 按下，Esc 关闭。
 * 按钮返回字符串：改按钮文字、dialog 保持打开；返回其他值：关闭 dialog。
 */
type Dialog = {
  title?: Text
  body?: Text
  footer?: Text
  /** P7：重新渲染后怎么发：'full' 整个 dialog 重发（Zig 整体替换，host 不 diff）；'2'（默认）只发变化的字段 */
  update?: 'full' | '2'
  /** 非模态：显示在右上角，只借用 ←/→ 选按钮（其余键照常给 CC）；选过之后 Enter 按下、Esc 关闭，
   *  直到有键交给 CC；按钮也可以鼠标点击。timeout 毫秒后按下选中的按钮，每次交互重新计时
   *  （初始选中 `or`；没有 or 且没动过则 resolve null）。正文末尾自动附上 "(3s)" 这样的延时 */
  timeout?: number
  or?: string
  /** 每行几个按钮：[2, 2] 即两行各两个（列对齐，最后一个数字重复使用）；'vertical' 一行一个（列表，如插件列表）。默认全在一行 */
  eachRow?: number[] | 'vertical'
  /** 按钮背景在左右两边渐隐到黑色的总列数（默认 2，0 关闭），避免色块硬边 */
  fadeX?: number
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

  /** 注册伪命令 /name：单行 `/name a b` 回车时拦截（CC 看不到），run(['a','b'])。
   *  同时会在本次运行的临时 --plugin-dir 里放一个 stub（不碰项目目录），
   *  让名字以 `cldp-pi:<name> (<name>)` 出现在 CC 的 `/` 自动补齐里 */
  command(name: string, run: (args: string[]) => unknown): void
  /** 注册前缀补全：Tab 时以该前缀开头的词交给 source，候选由 Zig 侧交给 fzf，选中项原样替换该词。
   *  给了 pick 时选中项先交给它，替换成它返回的文字（null / '' 不输入），如标签页标题 → `@截图.png` */
  complete(
    prefix: string,
    source: (tok: string) => Promise<string[]> | string[],
    pick?: (item: string, tok: string) => Promise<string | null> | string | null,
  ): void


  // P2：逐行处理网格。返回字符串就把这一行涂成该文本（'' 即涂掉）；返回 null 表示不改这一行
  //（用来优化：跳过该行，不是涂掉）。多个 sed 按注册顺序串联。i / rows 提供上下文。不改写 CC 的输出字节流
  sed(fn: (ln: string, i: number, rows: string[]) => string | null): () => void
  on: On
  /** resolve 为按下的按钮文字；Esc 关闭时为 null */
  /** resolve 为按下的按钮键名；Esc 关闭时为 null。返回的 Promise 也是句柄：ret(value) 在任何地方关闭并 resolve 为 value。
   *  （P7 删掉了 relabel / text / hint：标签和正文都在渲染时重新求值） */
  dialog(d: Dialog): Promise<string | null> & { ret(value?: string | null): void }
  /** P7：异步状态。dialog 的 Text / Button / hints 里读它，写入后 host 重新渲染并只发变化的字段 */
  onEmit<T extends object>(initial: T): Signal<T>
  /** 输入框上方的下拉菜单，↑/↓ 选择、Enter 确认；resolve 为选中项，Esc 为 null */
  menu(items: string[]): Promise<string | null>

  /** notify-send（macOS 用 osascript）。'snack'：文字放到右上角角标（替换 ◆ plugins n/m），
   *  'snackRD'：右下角；点进去仍是插件列表，'' 撤下。每个插件每个角一条，显示最新的 */
  notify(msg: string, where?: 'snack' | 'snackRD', style?: { bg?: number | `#${string}` | 'none' }): void
  /** 跑一行 shell：插值的值会被单引号转义（防注入）；shell 退出即 resolve，长期运行的程序在行尾加 & */
  sh(strings: TemplateStringsArray, ...values: unknown[]): Promise<{ code: number; stdout: string; stderr: string }>

  /** 终端侧的辅助 */
  tui: {
    /** 按一个键，排在之前的 pi`…` 之后：enter esc tab shift-tab backspace up down left right ctrl-c ctrl-o ctrl-r；
     *  P6 加 pgup pgdn home end ctrl-home */
    press(key: string): Promise<void>
    /** 等屏幕出现某段文字（或谓词为真），超时 resolve false；默认 3000ms */
    wait(cond: string | ((s: Scr) => boolean), ms?: number): Promise<boolean>
    /** 当前插件被关掉时调用（恢复插件在注册表之外改过的东西，如标签标题） */
    dispose(fn: () => unknown): void
    /** 本终端的标签标题：Yakuake / Konsole / Guake 走 D-Bus，其他终端用窗口标题（OSC 2）；title(null) 恢复原标题 */
    title(text: string | null): Promise<void>
    /** focused 来自终端的焦点上报，初始为 true；scr 是最近一帧网格（调用过 sed / wait 才每帧更新）；
     *  transcript 是最近一次 hook 给出的会话 JSONL 路径 */
    state: { cols: number; rows: number; focused: boolean; scr: Scr | null; transcript: string | null }
  }
  /**
   * 鼠标点击网格某一行时回调，i_row 是屏幕行号（0 起）。
   * 点在输入框箭头（❯）那一行及其下方的不算：输入框、状态栏的点击照常交给 CC。
   */
  click(handler: (i_row: number) => void): () => void
  // P6：消息边界和 scrollInView
  mark(name?: string): void
  scrollTo(name: string): Promise<void>
  /** 用 chrome --app 小窗口打开 WebUI，返回双向 JSON 通道。普通函数，不做模板注入 */
  htmlJSONL(html: string): Channel

  /** 插件之间共享的扩展：核心只提供空对象，由同名插件发布（webpane.js → pi.ext.webpane，f12.js → pi.ext.f12） */
  ext: {
    f12: {
      addTrust(allowedUrlPattern: string): Promise<void>   // f12.js（P5）：追加到 ~/.F12-mcp.json（如 'https://github.com/*'）
      /** 标签页实时的控制台 / 未捕获异常 / 网络错误（URL、前缀或 targetId）；reload 先刷新，ms 是收集重放的时间 */
      devtools(target: string, opts?: { reload?: boolean; ms?: number }):
        Promise<Array<{ kind: 'console' | 'exception' | 'log'; level: string; text: string; at: string }> | null>
    }
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
  // P7：按钮一个函数管渲染（up=false 返回标签）和按下（up=true，返回非 undefined 保持打开）。
  // 按下后整个 dialog 重算再 diff：单选的旧 ● 新 ○ 一起变。同步状态用闭包变量；
  // 异步的（await 之后、定时器）用 pi.onEmit，setU 触发重渲染。
  let sel = 'A'
  let web = 0
  const radio = (name: string) => (up: boolean) => (up ? (sel = name) : null, sel === name ? `● ${name}` : `○ ${name}`)
  const [u, setU] = pi.onEmit({ cost: 0 })
  const dlg = pi.dialog({
    body: u.cost.As(n => `selected ${sel} · $${n.toFixed(2)}`), // 单变量监听derive
    A: radio('A'),
    B: radio('B'),
    web: up => (up ? (web ^= 1) : null, web ? '[x] web' : '[ ] web'),
    Done: () => {}, // 返回 undefined：关闭
  })
  setTimeout(() => setU.cost(0.12), 1000) // 正文随之更新，只发 body
  setTimeout(() => dlg.ret(null), 10_000)
  pi.click(i_row => {})
  pi.BUFFER = '草稿，不回车'
  pi.arg.fzf = "--pointer '▶' --height=60%"
  // 界面识别（cld-pi -a 套别的 TUI 时改；默认是 CC 的硬编码）：输入框边框字符、提示符、bash 模式提示符、忙碌 / 命令运行中的关键字
  pi.arg.border = '─'; pi.arg.prompt = '❯'; pi.arg.bash = '!'; pi.arg.busy = 'esc to interrupt'; pi.arg.running = 'Running…'
  pi.notify('● 2.1s · 3m $0.12', 'snackRD')
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
  pi.ext.f12.devtools('https://github.com/', { reload: true, ms: 500 })
  pi.ext.webpane.boundPort(8080)
}
