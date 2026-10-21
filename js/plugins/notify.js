// Desktop notification when Claude finishes a turn (Stop) or needs you
// (Notification) — unless the terminal is known to have focus.
const firstLine = s => (s ?? '').trim().split('\n')[0].slice(0, 120)

export default pi => {
  const ping = msg => {
    if (pi.tui.state.focused !== true) pi.notify(msg)
  }
  pi.on({
    stop: p => ping(firstLine(p?.last_assistant_message) || 'Claude is done'),
    notification: p => ping(p?.message || 'Claude needs your attention'),
  })
}
