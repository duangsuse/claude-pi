// JSON-lines RPC between the Zig binary and this sidecar, plus the bits of
// the `pi` object that exist in P0: tagged-template pty writes and `pi.on`.
// See goal-v1.ts for the full plugin API this grows into.

const hookNames = { Stop: 'stop', Notification: 'notification', SessionStart: 'sessionStart' }

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

/**
 * @param {(msg: object) => void} send  writes one message to the Zig side
 * @param {(...a: unknown[]) => void} log
 */
export function createHost(send, log = () => {}) {
  const listeners = new Map() // event -> Set<fn>
  const state = { init: null, cols: 0, rows: 0 }

  const emit = (event, payload) => {
    let handled = true
    for (const fn of listeners.get(event) ?? []) {
      try {
        if (fn(payload) === false) handled = false
      } catch (e) {
        log(`listener ${event} threw`, e)
      }
    }
    return handled
  }

  const addListener = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(fn)
    return () => listeners.get(event).delete(fn)
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

  // pi`/add-dir ${dir}` replaces the input box text with the line, then Enter. String.raw
  // for now: backslashes reach the pty as typed.
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
      default:
        log('unknown message', msg)
    }
  }

  return { pi, dispatch, emit }
}
