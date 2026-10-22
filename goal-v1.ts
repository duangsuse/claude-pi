// 软件行为的唯一SPEC

// cld-pi 插件 API。仅作规格文档，项目不做类型检查。插件UI为不reflow、ImGui风格的多行按钮和文本。
// 默认插件放在 js/plugins/*.js，用户插件放在 ~/claude/-p/*.js，都由 js/host.js 加载。生命周期类似 export (pi)=>(pi.ext.starJS={ unload(){} })

/** 数字只有三种身份，别混用：ID 是 host 给每个 dialog 分配的序号（线上用它配对 open/patch/close/press）；
 *  Pos 是屏幕行号 / 列号（0 起）；Ms 是毫秒。其余 number（port / exit code / 每行按钮数）按名字自明 */
type ID = number
type Pos = number
type Ms = number

/** 当前网格的纯文本快照，必须节省，每帧写一次，和 ~/claude/-p/scr 内容相同 */
type Scr = { text: string; rows: string[]; cursor: { row: Pos; col: Pos } }

/** CC hook 事件（通过 --settings 注入）和按键事件。按键名只支持 C/S/A 修饰键前缀，如 CtrlC */
interface Events {
  stop(payload: { transcript_path: string; session_id: string }): void
  notification(payload: { message: string }): void
  sessionStart(payload: { session_id: string; cwd: string }): void

  user(msg: string): void          // 用户提交了一条消息（P6）
  focus(focused: boolean): void    // 终端焦点变化（来自 CSI I / CSI O）
  wheel(dir: -1 | 1): void         // 鼠标滚轮（-1 向上翻历史）
  scrcpy(s: Scr): void             // 每帧触发，比滚轮高频
  CtrlC(): void | false            // 返回 false 表示不再走默认行为（Zig 最多等 80ms 的回答；只有被监听的键才会问）
  [key: `Ctrl${string}` | `Shift${string}`]: (() => void | false) | undefined
}

/** pi.on 既可以传对象注册监听，也可以 await pi.on.xxx() 等待下一次事件（通用的 once 监听） */
type On = ((handlers: Partial<Events>) => () => void) & {
  [K in keyof Events]: () => Promise<Parameters<Events[K]>[0]>
}

// ---- P7：dialog 的 IPC 事件模型（KV + 返回值）----
// 线上的 dialog 只是一张 KV 表：键 = 字段名（title / body / footer / 每个按钮的键名），值 = 文字。
// Zig 不理解任何状态——选中、勾选都只是字符串；状态在 pi.onEmit 里，变化由函数返回的 KV 补丁表达。
//   host → Zig   open  { id, kv, opts }   首帧发全表；opts = timeout / or / eachRow / fadeX 这些不参与 diff 的布局项
//   host → Zig   patch { id, kv }         之后只发变化的键；值 null 撤下该键（按钮消失、hint 清空）
//   host → Zig   close { id }             ret() / 按下返回 undefined
//   Zig  → host  press { id, key }        Enter / 点击了某个按钮；Esc 时 key 为 null
// host 只做一件事：把函数返回的 KV 和上次发出的 diff，变了的键放进一条 patch。有三条路产生 KV：
//   press         → 调 d[key](true)：返回 undefined 关闭并 resolve 为 key；否则返回值就是补丁，再按 update 策略补算：
//                   'oldnew'（默认）只重算上一次和这一次按下的两个键（单选 ●/○ 一起变，不用记旧焦点）；'full' 重算全部按钮
//   setU.x(v)     → 写入立即可读（u.x 已是新值），发送延到下一 microtask：重跑 init 的 u.As 派生，diff 后发一条 patch。
//                   在按钮里用 u.upd(…) 包住返回值，就把这些派生变化合并进这次按下的同一条 patch
//   u.updTimeout  → 跟随状态生命周期的定时器，回调里 setU 同上；dialog 关闭时一并清除
// dialog 内部用 u.onUpd(kv => patch) 订阅这组状态发出的 KV；插件不必碰它。
type KV = Record<string, string | null>
type DialogWire =
  | { open: ID; kv: KV; opts: Pick<Dialog, 'timeout' | 'or' | 'eachRow' | 'fadeX'> }
  | { patch: ID; kv: KV }
  | { close: ID }
type DialogEvent = { press: ID; key: string | null }

/**
 * 按钮：一个函数同时负责渲染和响应，返回值就是要发的 KV 补丁：
 *   string     → 自己这个键的文字（{ [key]: string } 的简写）
 *   KV         → 任意键（顺手改 body、别的按钮）
 *   null       → 渲染时用键名；按下时关闭 dialog，resolve 为键名（`OK() {}` 照旧）
 *   {}         → 按下后什么都不改、也不关闭（'' 是把自己涂空，undefined 是关闭，都不是"没事"）
 *   Promise    → await 之后按同样规则处理；等待期间 dialog 保持原样，不响应第二次按下
 * up = false 渲染（open 时、以及被 update 策略点名重算时），up = true 按下（Enter / 点击）。
 */
type Button = (up: boolean) => string | KV | null | undefined | void | Promise<string | KV | null | undefined | void>

/** P7：pi.onEmit 返回的读端：u.x 直接读（setU 之后立即是新值），外加四个和 dialog 联动的方法 */
type State<T extends object> = Readonly<T> & {
  /** init 返回的派生：open 时跑一次给出初始 KV */
  /** 多变量派生：fn 读整个状态、返回 KV，放在 dialog 的 init 键上。哪个变量变了不重要，只看结果 KV 哪个键变了 */

  As(fn: (s: Readonly<T>) => KV): [State<T>]
  /** 在按钮返回值里用：把 patch（string = 自己这个键）和待发送的派生变化合成一个 KV 返回，
   *  不用 upd 就不会在下一 microtask 单独发一条 */
  upd(patch?: string | KV): KV
  /** 跟随这组状态的定时器：ms > 0 一次，ms < 0 每 |ms| 毫秒重复；用它的 dialog 关闭 / 插件关掉时清除。返回取消函数 */
  updTimeout(ms: Ms, fn: () => unknown): () => void
  /** 这组状态发出 KV（init 派生 diff 后的结果）时的回调，单槽：pi.dialog 打开时把它绑到自己身上变成 patch，关闭时清空。插件不碰 */
  onUpd?: (kv: KV) => void
}
/** 写端：setU.x(2) 单个，setU({ x: 2, y: 3 }) 批量；同一 microtask 内的写入合并成一次派生 + 一条 patch */
type Setter<T extends object> = { [K in keyof T]: (v: T[K]) => void } & ((patch: Partial<T>) => void)
type Signal<T extends object> = [State<T>, Setter<T>]

/**
 * gum 风格的多行 dialog。可以堆叠，可以(){dialog()}替换，更新列表
 * title/body/footer 不是字段，它们是 init 给出的初始 KV 里的键。其余键都是按钮：键名是按钮的身份（KV 的键、resolve 值），
 * 显示的文字由 Button 渲染决定（undefined 就是键名）。没有硬编码的 OK，`OK` 只是一个叫 OK 的普通按钮。
 * ←/→/Tab 按顺序切换按钮，↑/↓ 换行（保持列），Enter 按下，Esc 关闭。
 */
type Dialog = {
  /** P7：初始事件。open 时的结果是初始 KV（title / body / footer 即 hints 都从这里来；按钮自己的渲染优先），
   *  之后每次 setU 重跑、diff、只发变化的键。两种写法：u.As(s => KV) 是派生；
   *  直接传 pi.onEmit({ title, body, … }) 则状态键就是 KV 键（恒等派生，静态文字的简写） */
  init?: [State<KV>]
  /** 每行几个按钮：[2, 2] 即两行各两个（列对齐，最后一个数字重复使用）；'vertical' 一行一个（列表，如插件列表）。默认全在一行 */
  eachRow?: number[] | 'vertical'
  /** P7：按下后还要重算哪些键：'oldnew'（默认）只重算上一次和这一次按下的两个键，“上一次”初始为 `or`；
   *  'full' 重算全部按钮。两者都只 patch 变化的键 */
  update?: 'full' | 'oldnew'
  /** 非模态：显示在右上角，只借用 ←/→ 选按钮（其余键照常给 CC）；选过之后 Enter 按下、Esc 关闭，
   *  直到有键交给 CC；按钮也可以鼠标点击。timeout 毫秒后按下选中的按钮，每次交互重新计时
   *  （初始选中 `or`；没有 or 且没动过则 resolve null）。正文末尾自动附上 "(3s)" 这样的延时 */
  timeout?: Ms
  or?: string
  /** 按钮背景在左右两边渐隐到黑色的总列数（默认 2，0 关闭），避免色块硬边 */
  fadeX?: number
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
  BUFFER: string

  /** 注册伪命令 /name：单行 `/name a b` 回车时拦截（CC 看不到），run(['a','b'])。
   *  同时会在本次运行的临时 --plugin-dir 里放一个 stub（不碰项目目录），
   *  让名字以 `cld-pi:<name> (<name>)` 出现在 CC 的 `/` 自动补齐里 */
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
  sed(fn: (ln: string, i: Pos, rows: string[]) => string | null): () => void
  on: On
  /**
   * 鼠标点击网格某一行时回调，i_row 是屏幕行号（0 起）。
   * 点在输入框箭头（❯）那一行及其下方的不算：输入框、状态栏的点击照常交给 CC。
   */
  click(handler: (i_row: Pos) => void): () => void

  /** resolve 为按下的按钮键名；Esc 关闭时为 null。返回的 Promise 也是句柄：ret(value) 在任何地方关闭并 resolve 为 value。
   *  （P7 删掉了 relabel / text / hint：一切更新都是函数返回的 KV 补丁，见上面的事件模型） */
  dialog(d: Dialog, bs: {[key: string]: Button}): Promise<string | null> & { ret(value?: string | null): void }
  /** P7：状态。u.x 读、setU.x 写；u.As 挂到 dialog.init 做派生，u.upd 把派生合并进按钮返回值，u.updTimeout 做跟随生命周期的定时器 */
  onEmit<T extends object>(initial: T): Signal<T>
  /** 输入框上方的下拉菜单，↑/↓ 选择、Enter 确认；resolve 为选中项，Esc 为 null */
  inlineKbd(items: string[]): Promise<string | null>

  /** notify-send（macOS 用 osascript）。'snack'：文字放到右上角角标（替换 ◆ plugins n/m），
   *  'snackRD'：右下角；点进去仍是插件列表，'' 撤下。每个插件每个角一条，显示最新的 */
  notify(msg: string, where?: 'snack' | 'snackRD', style?: { bg?: number | `#${string}` | 'none' }): void
  /** 跑一行 shell：插值的值会被单引号转义（防注入）；shell 退出即 resolve，长期运行的程序在行尾加 & */
  sh(strings: TemplateStringsArray, ...values: unknown[]): Promise<{ code: number; stdout: string; stderr: string }>

  /** 终端侧的辅助 */
  tui: {
    copy(clip: string): void
    /** 按一个键，排在之前的 pi`…` 之后：enter esc tab shift-tab backspace up down left right ctrl-c ctrl-o ctrl-r；
     *  P6 加 pgup pgdn home end ctrl-home */
    press(key: string): Promise<void>
    /** 等屏幕出现某段文字（或谓词为真），超时 resolve false；默认 3000ms */
    shows(cond: RegExp, ms?: Ms): Promise<boolean>
    /** 本终端的标签标题：Yakuake / Konsole / Guake 走 D-Bus，其他终端用窗口标题（OSC 2）；title(null) 恢复原标题 */
    title(text: string | null): Promise<void>
    /** focused 来自终端的焦点上报，初始为 true；scr 是最近一帧网格（调用过 sed / wait 才每帧更新）；
     *  transcript 是最近一次 hook 给出的会话 JSONL 路径 */
    state: { cols: number; rows: number; focused: boolean; scr: Scr | null; transcript: string | null }
  }
  // P6：记住当前滚动方向最新一行。消息边界和 scrollInView （屏幕中心）
  mark(name?: string): void
  scrollTo(name: string): Promise<void>
  /** 用 chrome --app 小窗口打开 WebUI，返回双向 JSON 通道。普通函数，不做模板注入 */
  htmlJSONL(html: string): Channel

  arg: KV
  /** 插件之间共享的扩展：核心只提供空对象，由同名插件发布（webpane.js → pi.ext.webpane，f12.js → pi.ext.f12） */
  ext: {
    f12: {
      addTrust(allowedUrlPattern: string): Promise<void>   // f12.js（P5）：追加到 ~/.F12-mcp.json（如 'https://github.com/*'）
      /** 标签页实时的控制台 / 未捕获异常 / 网络错误（URL、前缀或 targetId）；reload 先刷新，ms 是收集重放的时间 */
      devtools(target: string, opts?: { reload?: boolean; ms?: Ms }):
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
  let web = false
  pi.dialog({ init: pi.onEmit({ title: 'T', body: '...', footer: '' }) }, { OK() {}, web: up => (up && (web = !web), web ? '[x] web' : '[ ] web') })
  pi.dialog({ init: pi.onEmit({title: 'Ctrl+P'}), eachRow: [2, 2] }, { model() {}, effort() {}, plan() {}, web() {} })
  // P7：按钮一个函数管渲染（up=false）和按下（up=true），返回值就是 KV 补丁（string = 自己这个键；undefined = 关闭）。
  // 状态放 pi.onEmit：setU 立即可读；init 的 u.As 派生把状态变成 KV，diff 后只发变了的键；
  // 按钮里用 u.upd(...) 包住返回值，派生变化就和这次按下走同一条 patch。'oldnew' 让旧 ● 新 ○ 一起变。
  const [u, setU] = pi.onEmit({ cost: 0, sel: 'A', web: 0 })
  const radio = (name: string) => (up: boolean) => (up && setU.sel(name), u.upd(u.sel === name ? `● ${name}` : `○ ${name}`))
  const dlg = pi.dialog({
    init: u.As(s => ({ body: `selected ${s.sel} · $${s.cost.toFixed(2)}` })), // 多变量派生：sel / cost 任一变 → body 变 → patch { body }
  }, {
    A: radio('A'),
    B: radio('B'),
    web: up => (up && setU.web(u.web ^ 1), u.upd({ web: u.web ? '[x] web' : '[ ] web', 'footer': u.web ? '关掉 WebUI' : '打开 WebUI' })),
    Done: () => {}, // 返回 undefined：关闭，resolve 'Done'
  })
  u.updTimeout(-1000, () => setU.cost(u.cost + 0.12)) // 每秒：init 重跑，只有 body 变 → patch { body }（dialog 通过 u.onUpd 收到）
  u.updTimeout(10_000, () => dlg.ret(null))
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
