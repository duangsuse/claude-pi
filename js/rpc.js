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

/**
 * @param {(msg: object) => void} send  writes one message to the Zig side
 * @param {(...a: unknown[]) => void} log
 * @param {{ notify?: (msg: string) => void }} [io]  side effects the host provides
 */
export function createHost(send, log = () => {}, io = {}) {
  // focused: from the terminal's focus reports; undefined until the first.
  const state = { init: null, cols: 0, rows: 0, focused: undefined, scr: null }

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
  const addListener = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    const entry = { fn, p: owner() }
    listeners.get(event).add(entry)
    return track(() => listeners.get(event).delete(entry))
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

  // pi`/add-dir ${dir}` replaces the input box text with the line, then
  // Enter. String.raw for now: backslashes reach the pty as typed.
  const pi = async (strings, ...values) => {
    send({ t: 'submit', data: String.raw(strings, ...values) })
  }
  pi.on = on
  pi.state = state

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

  pi.notify = msg => io.notify?.(String(msg))

  // ---- dialogs ----
  // pi.dialog({ title, body, footer, OK(row1) {}, ... }): every other
  // function-valued key is a button. A callback returning a string relabels
  // its button and keeps the dialog open; anything else closes it. Resolves
  // with the pressed label, or null when dismissed.
  // { timeout: ms, or: 'OK' } makes it non-modal (top-right, keys stay
  // with CC): after `timeout` the `or` button is pressed for you.
  // { vertical: true } stacks the buttons (lists).
  let nextId = 1
  const dialogs = new Map() // id -> { fns, labels, resolve, p, row1 }
  const closeDialog = (id, label) => {
    const dlg = dialogs.get(id)
    if (!dlg) return
    dialogs.delete(id)
    send({ t: 'dialog_close', id })
    dlg.resolve(label)
  }
  pi.dialog = d => {
    const id = nextId++
    const buttons = Object.entries(d).filter(([k, v]) => !dialogText.has(k) && typeof v === 'function')
    const labels = buttons.map(([k]) => k)
    const modal = !(d.timeout > 0)
    const row1 = String(d.body ?? '').split('\n')[0]
    send({ t: 'dialog', id, title: d.title ?? '', body: d.body ?? '', footer: d.footer ?? '', buttons: labels, modal, vertical: !!d.vertical })
    const done = new Promise(resolve => dialogs.set(id, { fns: buttons.map(([, v]) => v), labels, resolve, p: owner(), row1 }))
    if (!modal) {
      orig.setTimeout(async () => {
        const dlg = dialogs.get(id)
        if (!dlg) return
        const i = dlg.labels.indexOf(d.or)
        if (i >= 0) {
          try {
            await inOwner(dlg.p, () => dlg.fns[i](row1))
          } catch (e) {
            log('dialog button threw', e)
          }
        }
        closeDialog(id, i >= 0 ? dlg.labels[i] : null)
      }, d.timeout)
    }
    return done
  }
  const pressButton = async ({ id, index, row1 }) => {
    const dlg = dialogs.get(id)
    if (!dlg) return
    let r
    try {
      r = await inOwner(dlg.p, () => dlg.fns[index]?.(row1))
    } catch (e) {
      log('dialog button threw', e)
    }
    if (typeof r === 'string') {
      dlg.labels[index] = r
      send({ t: 'dialog_update', id, index, label: r })
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
  // pi.sed(ln => string | null): a string replaces the row ('' blanks it);
  // null means "unchanged" and lets us skip the row. Chained in order; runs
  // on every frame dump; only paint sets that changed are sent.
  const seds = [] // { fn, p }
  let lastPaint = '[]'
  pi.sed = fn => {
    const entry = { fn, p: owner() }
    seds.push(entry)
    if (seds.length === 1) send({ t: 'subscribe', scr: true })
    return track(() => {
      const i = seds.indexOf(entry)
      if (i < 0) return
      seds.splice(i, 1)
      if (!seds.length) send({ t: 'subscribe', scr: false })
      // Repaint without it now rather than on the next frame.
      runSed(state.scr?.rows ?? [])
    })
  }
  const runSed = rows => {
    const paints = []
    rows.forEach((row, i) => {
      let ln = row
      for (const s of seds) {
        try {
          const r = inOwner(s.p, () => s.fn(ln))
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
  const updateBadge = () => {
    const on = [...plugins.values()].filter(p => p.enabled).length
    send({ t: 'badge', text: ` ◆ plugins ${on}/${plugins.size} ` })
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
    const d = { title: 'Plugins', body: 'Enter turns a plugin on / off', footer: 'esc to close', vertical: true }
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
        emit(hookNames[msg.event] ?? msg.event, msg.payload)
        break
      case 'focus':
        state.focused = msg.focused
        emit('focus', msg.focused)
        break
      case 'scr': {
        const scr = { rows: msg.rows, text: msg.rows.join('\n'), cursor: msg.cursor }
        state.scr = scr
        emit('scrcpy', scr)
        if (seds.length) runSed(msg.rows)
        break
      }
      case 'dialog_button':
        pressButton(msg)
        break
      case 'dialog_closed': {
        const dlg = dialogs.get(msg.id)
        dialogs.delete(msg.id)
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
