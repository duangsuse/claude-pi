// Chrome DevTools Protocol, stdlib only (global WebSocket: Node 22+), plus
// where to find the user's Chrome: its DevToolsActivePort (written once
// remote debugging is allowed in chrome://inspect/#remote-debugging) and its
// History database.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Chrome's user data dirs, the usual one first. */
export function chromeDirs(home, platform = process.platform) {
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support')
    return [join(base, 'Google', 'Chrome'), join(base, 'Google', 'Chrome Beta'), join(base, 'Chromium')]
  }
  const base = join(home, '.config')
  return [join(base, 'google-chrome'), join(base, 'google-chrome-beta'), join(base, 'chromium')]
}

/** "9222\n/devtools/browser/<id>" → the browser's WebSocket URL. */
export function activePortUrl(text) {
  const [port, path] = String(text).split('\n').map(s => s.trim())
  if (!/^\d+$/.test(port) || !path?.startsWith('/devtools/browser/')) return null
  return `ws://127.0.0.1:${port}${path}`
}

/**
 * Where to connect: `CLAUDE_P_CDP` (a port, http:// or ws:// URL; agent tests
 * use 9224) or the first Chrome with a DevToolsActivePort. `dir` is that
 * Chrome's user data dir (for History), null for CLAUDE_P_CDP.
 */
export async function findBrowser({ env = process.env, home = env.HOME, platform } = {}) {
  const pinned = env.CLAUDE_P_CDP
  if (pinned) {
    if (/^wss?:/.test(pinned)) return { url: pinned, dir: null }
    const base = /^\d+$/.test(pinned) ? `http://127.0.0.1:${pinned}` : pinned.replace(/\/$/, '')
    try {
      const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1500) })
      return { url: (await res.json()).webSocketDebuggerUrl, dir: null }
    } catch {
      return null
    }
  }
  for (const dir of chromeDirs(home, platform)) {
    let text
    try {
      text = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8')
    } catch {
      continue
    }
    const url = activePortUrl(text)
    if (url) return { url, dir }
  }
  return null
}

/**
 * Open a CDP connection. `send(method, params, sessionId, ms)` rejects after
 * `ms` (default 10 s) with `err.timeout` set. Chrome may hold the handshake
 * until the user clicks Allow, hence the long `ms` here.
 */
export function connect(url, ms = 30_000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') return reject(new Error('needs Node 22+ (global WebSocket)'))
    const ws = new WebSocket(url)
    const calls = new Map()
    let next = 1
    const cdp = {
      closed: false,
      send(method, params = {}, sessionId, ms = 10_000) {
        if (cdp.closed) return Promise.reject(new Error('CDP connection closed'))
        const id = next++
        const msg = { id, method, params }
        if (sessionId) msg.sessionId = sessionId
        return new Promise((ok, fail) => {
          const timer = setTimeout(() => {
            calls.delete(id)
            fail(Object.assign(new Error(`${method} timed out`), { timeout: true }))
          }, ms)
          calls.set(id, { ok, fail, timer })
          ws.send(JSON.stringify(msg))
        })
      },
      close: () => ws.close(),
    }
    const giveUp = setTimeout(() => {
      ws.close()
      reject(new Error(`no answer from ${url}`))
    }, ms)
    ws.addEventListener('open', () => {
      clearTimeout(giveUp)
      resolve(cdp)
    })
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data)
      const c = calls.get(m.id)
      if (!c) return
      calls.delete(m.id)
      clearTimeout(c.timer)
      if (m.error) c.fail(new Error(`${m.error.message} (${m.error.code})`))
      else c.ok(m.result)
    })
    const down = () => {
      clearTimeout(giveUp)
      cdp.closed = true
      for (const c of calls.values()) {
        clearTimeout(c.timer)
        c.fail(new Error('CDP connection closed'))
      }
      calls.clear()
      reject(new Error(`cannot connect to ${url}`))
    }
    ws.addEventListener('close', down)
    ws.addEventListener('error', down)
  })
}

/** The browser's tabs (Target.getTargets, pages only). */
export async function tabs(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets')
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'))
}

/**
 * PNG of a tab. A background tab doesn't paint, so a capture that times out
 * is retried after bringing the tab to the front.
 */
export async function screenshot(cdp, targetId, ms = 4000) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const shot = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId, ms)).data, 'base64')
  try {
    return await shot()
  } catch (e) {
    if (!e.timeout) throw e
    await cdp.send('Target.activateTarget', { targetId })
    return await shot()
  } finally {
    cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
  }
}

/**
 * Recently visited URLs from a Chrome user data dir (its last used profile),
 * newest first. Read from a copy: Chrome keeps the database open. [] when
 * there's none or node:sqlite is missing (Node < 22.5).
 */
export async function history(dir, limit = 5000) {
  if (!dir) return []
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return []
  }
  let profile = 'Default'
  try {
    profile = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8')).profile?.last_used || profile
  } catch {}
  const tmp = mkdtempSync(join(tmpdir(), 'cld-pi-history-'))
  try {
    const copy = join(tmp, 'History')
    copyFileSync(join(dir, profile, 'History'), copy)
    const db = new sqlite.DatabaseSync(copy, { readOnly: true })
    try {
      return db.prepare('SELECT url, title FROM urls ORDER BY last_visit_time DESC LIMIT ?').all(limit)
    } finally {
      db.close()
    }
  } catch {
    return []
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
