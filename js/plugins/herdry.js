// herdry: when Claude finishes or needs you (the same Stop / Notification
// hooks notify.js listens to), spin the tab title the way CC spins its
// status line — "✻ <message>" — until the terminal gets focus.
// pi.tui.title sets the tab (D-Bus for Yakuake / Konsole / Guake, the
// window title elsewhere) and puts the old title back.

const base = [...'·✢*✶✻✽']
const frames = [...base, ...base.slice(1, -1).reverse()] // ·✢*✶✻✽✻✶*✢, CC's cycle
const frameMs = 150
const giveUpMs = 30 * 60 * 1000 // no focus reports at all? stop eventually
const firstLine = s => (s ?? '').trim().split('\n')[0].slice(0, 120)

export function spinner(pi, { every = frameMs } = {}) {
  const { tui } = pi
  let timer = null
  let text = ''
  let frame = 0
  let started = 0
  let busy = false

  const stop = async () => {
    if (!timer) return
    clearInterval(timer)
    timer = null
    await tui.title(null)
  }

  const spin = msg => {
    if (tui.state.focused === true) return
    text = msg
    if (timer) return // already spinning: just show the newer message
    started = Date.now()
    timer = setInterval(async () => {
      if (Date.now() - started > giveUpMs) return stop()
      if (busy) return // a slow D-Bus call: skip a frame rather than pile up
      busy = true
      await tui.title(`${frames[frame++ % frames.length]} ${text}`)
      busy = false
    }, every)
  }

  pi.on({
    stop: p => spin(firstLine(p?.last_assistant_message) || 'Claude is done'),
    notification: p => spin(p?.message || 'Claude needs your attention'),
    focus: focused => {
      if (focused) stop()
    },
  })
  tui.dispose(stop)
}

export default pi => spinner(pi)
