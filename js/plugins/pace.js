// Bottom-right snack: how long the last ● took (one assistant content
// block; ticking while the next one is on its way) and what the last 3
// minutes cost. Goes see-through while the wheel is scrolling (back 0.5 s
// after the last notch). Follows the transcript (pi.tui.state.transcript) a few new
// lines at a time; costs come from session.js like the Ctrl+P panel's.
import { messageCost, tailEntries } from '../session.js'

const windowMs = 3 * 60_000

export const duration = ms => {
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`
}

/** The numbers, fed transcript entries; `view(now)` is the snack text. */
export function createPace() {
  const seen = new Set()
  const costs = [] // [ts, $]
  let prev = null // ts of the latest user / assistant entry
  let last = null // ms the latest ● took
  let running = false
  return {
    add(d) {
      const ts = Date.parse(d.timestamp)
      if ((d.type !== 'user' && d.type !== 'assistant') || Number.isNaN(ts)) return
      if (d.type === 'assistant' && prev != null) last = ts - prev
      const c = messageCost(d, seen)
      if (c) costs.push([ts, c])
      prev = ts
      running = true
    },
    /** The turn ended (Stop): stop ticking. */
    stop() {
      running = false
    },
    view(now) {
      while (costs.length && costs[0][0] < now - windowMs) costs.shift()
      const spent = costs.reduce((sum, [, c]) => sum + c, 0)
      const live = running && prev != null ? now - prev : null
      const took = live ?? last
      if (took == null && !costs.length) return null
      return `● ${took == null ? '–' : duration(took)}${live != null ? '…' : ''} · 3m $${spent.toFixed(2)}`
    },
  }
}

export default pi => {
  const tail = tailEntries()
  let pace = createPace()
  let path = null
  let scrolling = null // timer until the wheel counts as settled
  const tick = () => {
    const p = pi.tui.state.transcript
    const fresh = p !== path
    if (fresh) [path, pace] = [p, createPace()]
    for (const d of tail(p)) pace.add(d)
    if (fresh) pace.stop() // history (a resumed session), not a running turn
    const text = pace.view(Date.now())
    pi.notify(text ?? '', 'snackRD', scrolling ? { bg: 'none' } : {})
  }
  pi.on({
    wheel: () => {
      const was = scrolling
      clearTimeout(scrolling)
      scrolling = setTimeout(() => ((scrolling = null), tick()), 500)
      if (!was) tick()
    },
    stop: () => {
      tick()
      pace.stop()
      tick()
    },
  })
  setInterval(tick, 1000)
}
