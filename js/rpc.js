// JSON-lines RPC between the Zig binary and this sidecar, the `pi` object
// plugins get, and the plugin registry. See goal-v1.ts for the API.
import { AsyncLocalStorage } from 'node:async_hooks'

const hookNames = { Stop: 'stop', Notification: 'notification', SessionStart: 'sessionStart' }

// Captured before installTimerHooks replaces the globals: host-internal
// timers (dialog timeouts) must not be charged to whichever plugin called.
const orig = { setTimeout, setInterval, clearTimeout, clearInterval }

/** Split a byte stream into lines; calls onLine(str) for each complete one. */
export function lineSplitter(onLine) {
  let buf = ''
  return chunk => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) onLine(line)
    }
  }
}

const dialogText = new Set(['title', 'body', 'footer'])

/** SGR parameters for a snack background (see pi.notify); undefined: default. */
export function snackSgr(bg) {
  if (bg == null) return undefined
  if (bg === 'none') return '2;38;5;212;49'
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(bg))
  if (hex) return `1;38;5;230;48;2;${hex.slice(1).map(h => parseInt(h, 16)).join(';')}`
  const n = Number(bg)
  if (Number.isInteger(n) && n >= 0 && n < 256) return `1;38;5;230;48;5;${n}`
  return undefined
}

/** Single-quote for a POSIX shell. */
export const shQuote = v => `'${String(v).replace(/'/g, `'\\''`)}'`

/**
 * @param {(msg: object) => void} send  writes one message to the Zig side
 * @param {(...a: unknown[]) => void} log
 * @param {{ notify?: (msg: string) => void, sh?: (line: string) => Promise<{code: number, stdout: string, stderr: string}>, tab?: Promise<{ get(): Promise<string|null>, set(t: string): Promise<unknown> } | null> }} [io]
 *   side effects the host provides; `tab` is the tab-title backend (js/tab.js)
 */
export function createHost(send, log = () => {}, io = {}) {
  // focused: from the terminal's focus reports (CSI I / O). Starts true:
  // you just launched it from that terminal.
  // transcript: the session's JSONL, from the latest hook payload.
  const state = { init: null, cols: 0, rows: 0, focused: true, scr: null, transcript: null }

  // ---- plugin ownership ----
  // Plugin code runs inside als.run(plugin): its setup, its listeners, its
  // timer callbacks (ALS follows async continuations). Every registration
  // records a disposer on the current plugin; turning it off runs them.
  const als = new AsyncLocalStorage()
  const plugins = new Map() // name -> { name, enabled, init, timers, disposers }
  const owner = () => als.getStore()
  const inOwner = (p, fn) => (p ? als.run(p, fn) : fn())
  const track = dispose => {
    owner()?.disposers.add(dispose)
    return dispose
  }

  // ---- events ----
  const listeners = new Map() // event -> Set<{ fn, p }>
  const emit = (event, payload) => {
    let handled = true
    for (const l of [...(listeners.get(event) ?? [])]) {
      try {
        if (inOwner(l.p, () => l.fn(payload)) === false) handled = false
      } catch (e) {
        log(`listener ${event} threw`, e)
      }
    }
    return handled
  }
  // Key events (CtrlP, ShiftTab, …) cost Zig a round trip per press, so
  // it only asks for the keys someone listens to.
  const isKey = ev => /^(Ctrl|Shift)[A-Z]/.test(ev)
  let lastKeys = '[]'
  const syncKeys = () => {
    const names = [...listeners].filter(([ev, set]) => isKey(ev) && set.size).map(([ev]) => ev)
    const json = JSON.stringify(names)
    if (json !== lastKeys) {
      lastKeys = json
      send({ t: 'keys', names })
    }
  }
  const addListener = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    const entry = { fn, p: owner() }
    listeners.get(event).add(entry)
    if (isKey(event)) syncKeys()
    return track(() => {
      listeners.get(event).delete(entry)
      if (isKey(event)) syncKeys()
    })
  }

  // pi.on({ stop() {} }) registers; `await pi.on.stop` waits for the next one.
  const on = new Proxy(
    handlers => {
      const offs = Object.entries(handlers).map(([ev, fn]) => addListener(ev, fn))
      return () => offs.forEach(off => off())
    },
    {
      get(target, ev) {
        if (typeof ev !== 'string' || ev in target) return target[ev]
        return new Promise(resolve => {
          const off = addListener(ev, p => {
            off()
            resolve(p)
          })
        })
      },
    },
  )

  // Requests Zig acknowledges with {t:'done', id} once queued keys are typed.
  let nextReq = 1
  const acks = new Map()
  const request = msg =>
    new Promise(resolve => {
      const id = nextReq++
      acks.set(id, resolve)
      send({ ...msg, id })
    })

  // pi`/add-dir ${dir}` replaces the input box text with the line, then
  // Enter; resolves once it has been typed. String.raw for now: backslashes
  // reach the pty as typed. A leading `!` switches CC to bash mode.
  const pi = (strings, ...values) => request({ t: 'submit', data: String.raw(strings, ...values) })
  pi.on = on
  // Terminal-side helpers: pi.tui.wait / press / dispose / title / state.
  const tui = (pi.tui = { state })

  // pi.BUFFER = 'text' replaces the input box text, no Enter. Write-only
  // for now (reading it back would need the grid).
  Object.defineProperty(pi, 'BUFFER', {
    set: v => send({ t: 'buffer', data: String(v) }),
    enumerable: true,
  })

  // pi.arg.fzf = '...' : settings the Zig side uses. Defaults arrive with
  // the init message; assignments are pushed back.
  const args = {}
  pi.arg = new Proxy(args, {
    set(target, key, value) {
      target[key] = String(value)
      send({ t: 'arg', key, value: String(value) })
      return true
    },
  })

  // pi.tui.press('enter'): one key, queued after earlier pi`…` lines.
  // enter esc tab shift-tab backspace up down left right ctrl-c ctrl-o ctrl-r
  tui.press = key => request({ t: 'press', key })

  // pi.command('ad', args => …): `/ad x y` + Enter runs it with ['x', 'y'];
  // CC never sees the line.
  const commands = new Map() // name -> { run, p }
  const syncCommands = () => send({ t: 'commands', names: [...commands.keys()] })
  pi.command = (name, run) => {
    const entry = { run, p: owner() }
    commands.set(name, entry)
    syncCommands()
    return track(() => {
      if (commands.get(name) === entry) commands.delete(name)
      syncCommands()
    })
  }

  // pi.complete('//', tok => [...]): Tab on a word starting with the prefix
  // offers the returned strings in fzf; the pick replaces the word as-is.
  // pi.complete('//', source, (item, tok) => text): the pick goes through
  // that first (null / '' types nothing), e.g. a tab title → `@shot.png`.
  const completers = new Map() // prefix -> { source, pick, p }
  const picks = new Map() // complete id -> { pick, token, p }
  const syncCompleters = () => send({ t: 'completions', prefixes: [...completers.keys()] })
  pi.complete = (prefix, source, pick) => {
    const entry = { source, pick, p: owner() }
    completers.set(prefix, entry)
    syncCompleters()
    return track(() => {
      if (completers.get(prefix) === entry) completers.delete(prefix)
      syncCompleters()
    })
  }

  // pi.notify(msg): desktop notification. pi.notify(msg, 'snack') puts msg
  // where the ◆ plugins badge is (top-right), 'snackRD' bottom-right; both
  // open the plugin list when clicked, '' takes the plugin's snack down.
  // One snack per plugin and corner; the latest one shows. { bg }: its
  // background, a 256-colour number, '#rrggbb', or 'none' (no background,
  // dim text); default the badge's pink.
  const snacks = { snack: new Map(), snackRD: new Map() } // owner -> { text, sgr }
  pi.notify = (msg, where, { bg } = {}) => {
    if (!(where in snacks)) return io.notify?.(String(msg))
    const p = owner() ?? null
    const slot = snacks[where]
    slot.delete(p) // re-insert: the latest goes last
    if (msg !== '' && msg != null) {
      slot.set(p, { text: String(msg), sgr: snackSgr(bg) })
      if (p && !p.snackDisposers?.has(where)) {
        ;(p.snackDisposers ??= new Set()).add(where)
        track(() => {
          p.snackDisposers.delete(where)
          snacks[where].delete(p)
          updateBadge()
        })
      }
    }
    updateBadge()
  }

  // pi.sh`cmd ${value}`: run a shell line; interpolated values are quoted,
  // so they can't inject. Resolves { code, stdout, stderr } when the shell
  // exits (end a line with `&` for things that keep running).
  pi.sh = (strings, ...values) => {
    const line = strings.reduce((acc, str, i) => acc + str + (i < values.length ? shQuote(values[i]) : ''), '')
    return io.sh ? io.sh(line) : Promise.resolve({ code: 127, stdout: '', stderr: 'no shell' })
  }

  // pi.ext.*: helpers plugins publish for each other (webpane.js → pi.ext.webpane).
  pi.ext = {}

  // pi.tui.dispose(fn): run fn when the calling plugin is turned off
  // (restore whatever it changed outside the registry, like a tab title).
  tui.dispose = fn => track(fn)

  // pi.tui.title(text): this terminal's tab title — over D-Bus where the
  // terminal names tabs itself (Yakuake, Konsole, Guake), else the window
  // title (OSC 2). pi.tui.title(null) puts the original back.
  const tabP = Promise.resolve(io.tab ?? null).catch(() => null)
  let savedTitle // Promise of the title before our first change
  tui.title = async text => {
    const tab = await tabP
    if (text == null) {
      if (!savedTitle) return
      const saved = await savedTitle
      savedTitle = undefined
      if (!tab) send({ t: 'title', text: null })
      else if (saved != null) await tab.set(saved)
      return
    }
    if (!tab) {
      savedTitle ??= Promise.resolve(null)
      return send({ t: 'title', text: String(text) })
    }
    savedTitle ??= tab.get()
    await savedTitle
    await tab.set(String(text))
  }

  // ---- dialogs ----
  // pi.dialog({ title, body, footer, OK() {}, ... }): every other
  // function-valued key is a button (no arguments). A callback returning a
  // string relabels its button and keeps the dialog open; anything else
  // closes it. Resolves with the pressed label, or null when dismissed.
  // { timeout: ms, or: 'OK' } makes it non-modal (top-right, keys stay
  // with CC): after `timeout` the `or` button is pressed for you.
  // { eachRow: [2, 2] } lays buttons out in rows of 2; 'vertical' is one
  // per row (lists). { hints: { label: text } } shows the focused button's
  // hint in the footer. A non-modal dialog borrows ←/→ to pick a button;
  // its timeout presses the picked one (starting at `or`).
  let nextId = 1
  const dialogs = new Map() // id -> { fns, labels, resolve, p }
  const closeDialog = (id, label) => {
    const dlg = dialogs.get(id)
    if (!dlg) return
    dialogs.delete(id)
    orig.clearTimeout(dlg.timer)
    send({ t: 'dialog_close', id })
    dlg.resolve(label)
  }
  pi.dialog = d => {
    const id = nextId++
    const buttons = Object.entries(d).filter(([k, v]) => !dialogText.has(k) && typeof v === 'function')
    const labels = buttons.map(([k]) => k)
    const modal = !(d.timeout > 0)
    const hints = labels.map(l => d.hints?.[l])
    const active = Math.max(0, labels.indexOf(d.or))
    const footer = d.footer ?? ''
    const msg = { t: 'dialog', id, title: d.title ?? '', body: d.body ?? '', footer: hints[active] ?? footer, buttons: labels, modal, active }
    if (d.eachRow != null) msg.eachRow = d.eachRow
    send(msg)
    const done = new Promise(resolve =>
      dialogs.set(id, { fns: buttons.map(([, v]) => v), labels, resolve, p: owner(), hints, footer, active, moved: false }),
    )
    // The handle: relabel(from, to) any button, text({ title, body, footer }).
    done.relabel = (from, to) => {
      const dlg = dialogs.get(id)
      const index = typeof from === 'number' ? from : dlg?.labels.indexOf(from)
      if (!dlg || index == null || index < 0) return
      dlg.labels[index] = String(to)
      send({ t: 'dialog_update', id, index, label: String(to) })
    }
    done.text = texts => {
      if (!dialogs.has(id)) return
      if (texts.footer != null) dialogs.get(id).footer = String(texts.footer)
      send({ t: 'dialog_update', id, ...texts })
    }
    if (!modal) {
      // Any interaction (←/→, a click or Enter that keeps it open) starts
      // the timeout over.
      const dlg = dialogs.get(id)
      dlg.rearm = () => {
        orig.clearTimeout(dlg.timer)
        dlg.timer = orig.setTimeout(fire, d.timeout)
      }
      const fire = async () => {
        if (dialogs.get(id) !== dlg) return
        const i = dlg.moved || dlg.labels.includes(d.or) ? dlg.active : -1
        if (i >= 0) {
          try {
            await inOwner(dlg.p, () => dlg.fns[i]())
          } catch (e) {
            log('dialog button threw', e)
          }
        }
        closeDialog(id, i >= 0 ? dlg.labels[i] : null)
      }
      dlg.rearm()
    }
    return done
  }
  const pressButton = async ({ id, index }) => {
    const dlg = dialogs.get(id)
    if (!dlg) return
    dlg.rearm?.()
    let r
    try {
      r = await inOwner(dlg.p, () => dlg.fns[index]?.())
    } catch (e) {
      log('dialog button threw', e)
    }
    if (typeof r === 'string') {
      dlg.labels[index] = r
      send({ t: 'dialog_update', id, index, label: r })
      dlg.rearm?.()
      return
    }
    closeDialog(id, dlg.labels[index])
  }

  // pi.menu(items): dropdown above the input box. Resolves with the picked
  // item, or null on Esc.
  const menus = new Map()
  pi.menu = items => {
    const id = nextId++
    const list = [...items].map(String)
    send({ t: 'menu', id, items: list })
    return new Promise(resolve => menus.set(id, { list, resolve }))
  }

  // ---- sed ----
  // pi.sed((ln, i, rows) => string | null): a string replaces the row (''
  // blanks it); null means "unchanged" and lets us skip the row. `i` and
  // `rows` give context (e.g. "inside a Bash output block"). Chained in order; runs
  // on every frame dump; only paint sets that changed are sent.
  const seds = [] // { fn, p }
  const waiters = new Set() // pi.tui.wait conditions, checked per frame
  let lastPaint = '[]'
  let subscribed = false
  const syncSubscribe = () => {
    const want = seds.length > 0 || waiters.size > 0
    if (want !== subscribed) {
      subscribed = want
      send({ t: 'subscribe', scr: want })
    }
  }
  pi.sed = fn => {
    const entry = { fn, p: owner() }
    seds.push(entry)
    syncSubscribe()
    return track(() => {
      const i = seds.indexOf(entry)
      if (i < 0) return
      seds.splice(i, 1)
      syncSubscribe()
      // Repaint without it now rather than on the next frame.
      runSed(state.scr?.rows ?? [])
    })
  }

  // pi.tui.wait('text' | scr => bool, ms = 3000): resolves true once the
  // screen matches, false on timeout.
  tui.wait = (cond, ms = 3000) => {
    const test = typeof cond === 'function' ? cond : scr => scr.text.includes(cond)
    return new Promise(resolve => {
      const w = { test, resolve }
      const finish = ok => {
        waiters.delete(w)
        orig.clearTimeout(w.timer)
        syncSubscribe()
        resolve(ok)
      }
      w.finish = finish
      w.timer = orig.setTimeout(() => finish(false), ms)
      waiters.add(w)
      syncSubscribe()
      if (state.scr && test(state.scr)) finish(true)
    })
  }
  const runSed = rows => {
    const paints = []
    rows.forEach((row, i) => {
      let ln = row
      for (const s of seds) {
        try {
          const r = inOwner(s.p, () => s.fn(ln, i, rows))
          if (typeof r === 'string') ln = r
        } catch (e) {
          log('sed threw', e)
        }
      }
      if (ln !== row) paints.push([i, ln])
    })
    const json = JSON.stringify(paints)
    if (json !== lastPaint) {
      lastPaint = json
      send({ t: 'paint', rows: paints })
    }
  }

  // ---- plugins ----
  const start = async p => {
    try {
      await als.run(p, () => p.init(pi))
    } catch (e) {
      log(`plugin ${p.name} failed`, e)
    }
  }
  const stop = p => {
    for (const d of p.disposers) {
      try {
        d()
      } catch (e) {
        log(`plugin ${p.name} dispose threw`, e)
      }
    }
    p.disposers.clear()
    for (const h of p.timers) orig.clearTimeout(h)
    p.timers.clear()
  }
  const lastSnack = slot => [...slot.values()].at(-1)
  let shown = {}
  const updateBadge = () => {
    const on = [...plugins.values()].filter(p => p.enabled).length
    const top = lastSnack(snacks.snack)
    const rd = lastSnack(snacks.snackRD)
    const msgs = [
      { t: 'badge', text: ` ${top?.text ?? `◆ plugins ${on}/${plugins.size}`} `, ...(top?.sgr && { sgr: top.sgr }) },
      { t: 'badge', pos: 'rd', text: rd ? ` ${rd.text} ` : null, ...(rd?.sgr && { sgr: rd.sgr }) },
    ]
    for (const m of msgs) {
      const key = m.pos ?? 'tr'
      const json = JSON.stringify(m)
      if (json !== (shown[key] ?? (key === 'rd' ? JSON.stringify({ t: 'badge', pos: 'rd', text: null }) : ''))) send(m)
      shown[key] = json
    }
  }
  const label = p => `${p.enabled ? '[x]' : '[ ]'} ${p.name}`

  /** Register and start a plugin: `init(pi)` is its default export. */
  const loadPlugin = async (name, init) => {
    const p = { name, enabled: true, init, timers: new Set(), disposers: new Set() }
    plugins.set(name, p)
    await start(p)
    updateBadge()
  }

  /** Turn a plugin off (drop everything it registered) or back on. */
  const setEnabled = async (name, enabled) => {
    const p = plugins.get(name)
    if (!p || p.enabled === enabled) return
    p.enabled = enabled
    if (enabled) await start(p)
    else stop(p)
    updateBadge()
  }

  // The badge's click: a list of plugins, Enter toggles one.
  const showPluginList = () => {
    const d = { title: 'Plugins', body: 'Enter turns a plugin on / off', footer: 'esc to close', eachRow: 'vertical' }
    for (const p of plugins.values()) {
      d[label(p)] = async () => {
        await setEnabled(p.name, !p.enabled)
        return label(p)
      }
    }
    d.Done = () => {}
    return pi.dialog(d)
  }

  /**
   * Replace target's timer functions so timers created by plugin code are
   * charged to that plugin (and cleared when it is turned off).
   */
  const installTimerHooks = (target = globalThis) => {
    const saved = {
      setTimeout: target.setTimeout,
      setInterval: target.setInterval,
      clearTimeout: target.clearTimeout,
      clearInterval: target.clearInterval,
    }
    const disown = h => {
      for (const p of plugins.values()) p.timers.delete(h)
    }
    target.setInterval = (fn, ms, ...a) => {
      const h = orig.setInterval(fn, ms, ...a)
      owner()?.timers.add(h)
      return h
    }
    target.setTimeout = (fn, ms, ...a) => {
      const p = owner()
      const h = orig.setTimeout((...x) => {
        p?.timers.delete(h)
        return fn(...x)
      }, ms, ...a)
      p?.timers.add(h)
      return h
    }
    target.clearTimeout = target.clearInterval = h => {
      disown(h)
      orig.clearTimeout(h)
    }
    return () => Object.assign(target, saved)
  }

  /** Handle one message from the Zig side. */
  const dispatch = msg => {
    switch (msg.t) {
      case 'init':
        Object.assign(args, msg.arg)
        state.init = msg
        state.cols = msg.cols
        state.rows = msg.rows
        emit('init', msg)
        break
      case 'resize':
        state.cols = msg.cols
        state.rows = msg.rows
        emit('resize', msg)
        break
      case 'hook':
        if (msg.payload?.transcript_path) state.transcript = msg.payload.transcript_path
        emit(hookNames[msg.event] ?? msg.event, msg.payload)
        break
      case 'focus':
        state.focused = msg.focused
        emit('focus', msg.focused)
        break
      case 'wheel':
        emit('wheel', msg.dir)
        break
      case 'scr': {
        const scr = { rows: msg.rows, text: msg.rows.join('\n'), cursor: msg.cursor }
        state.scr = scr
        emit('scrcpy', scr)
        if (seds.length) runSed(msg.rows)
        for (const w of [...waiters]) {
          try {
            if (w.test(scr)) w.finish(true)
          } catch (e) {
            log('wait condition threw', e)
            w.finish(false)
          }
        }
        break
      }
      case 'done':
        acks.get(msg.id)?.()
        acks.delete(msg.id)
        break
      case 'key':
        send({ t: 'key_result', id: msg.id, prevent: emit(msg.name) === false })
        break
      case 'command': {
        const c = commands.get(msg.name)
        const args = String(msg.args ?? '').split(/\s+/).filter(Boolean)
        if (c) {
          Promise.resolve()
            .then(() => inOwner(c.p, () => c.run(args)))
            .catch(e => log(`command /${msg.name} threw`, e))
        }
        break
      }
      case 'complete': {
        const c = completers.get(msg.prefix)
        picks.clear() // Zig waits on one Tab at a time; an fzf Esc never answers
        Promise.resolve()
          .then(() => (c ? inOwner(c.p, () => c.source(msg.token)) : []))
          .catch(e => (log(`completion ${msg.prefix} threw`, e), []))
          .then(items => {
            const reply = { t: 'complete_result', id: msg.id, items: (items ?? []).map(String) }
            if (c?.pick && reply.items.length) {
              reply.pick = true
              picks.set(msg.id, { pick: c.pick, token: msg.token, p: c.p })
            }
            send(reply)
          })
        break
      }
      case 'picked': {
        const k = picks.get(msg.id)
        picks.delete(msg.id)
        if (!k) break
        Promise.resolve()
          .then(() => inOwner(k.p, () => k.pick(msg.item, k.token)))
          .catch(e => (log('completion pick threw', e), null))
          .then(text => send({ t: 'pick_result', id: msg.id, text: text ? String(text) : null }))
        break
      }
      case 'dialog_button':
        pressButton(msg)
        break
      case 'dialog_active': {
        const dlg = dialogs.get(msg.id)
        if (!dlg) break
        dlg.active = msg.index
        dlg.moved = true
        dlg.rearm?.()
        if (dlg.hints.some(h => h != null)) send({ t: 'dialog_update', id: msg.id, footer: dlg.hints[msg.index] ?? dlg.footer })
        break
      }
      case 'dialog_closed': {
        const dlg = dialogs.get(msg.id)
        dialogs.delete(msg.id)
        if (dlg) orig.clearTimeout(dlg.timer)
        dlg?.resolve(null)
        break
      }
      case 'menu_result': {
        const m = menus.get(msg.id)
        menus.delete(msg.id)
        m?.resolve(msg.index == null ? null : m.list[msg.index] ?? null)
        break
      }
      case 'badge_click':
        showPluginList()
        break
      default:
        log('unknown message', msg)
    }
  }

  return { pi, dispatch, emit, loadPlugin, setEnabled, plugins, installTimerHooks, showPluginList }
}
