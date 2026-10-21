// pi.ext.webpane + /w. webpane.boundPort(port): free → returns the port
// (the caller starts its server), taken → null; either way a dialog lists
// where it can be reached, http-server style. /w does that for the cloudcli
// web UI on :3001 and starts it in the background when nothing serves it.
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { join } from 'node:path'

const port = 3001

/** Whether something already accepts connections on localhost:port. */
export const portInUse = (port, host = '127.0.0.1') =>
  new Promise(resolve => {
    const sock = net.connect({ port, host })
    const done = used => {
      sock.destroy()
      resolve(used)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(500, () => done(false))
  })

/** Where a server on `port` can be reached: localhost, LAN, tailscale. */
export function addresses(port, ifaces = os.networkInterfaces()) {
  const out = [{ url: `http://localhost:${port}`, kind: 'local' }]
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      // Tailscale hands out CGNAT addresses (100.64.0.0/10).
      const [o1, o2] = a.address.split('.').map(Number)
      const tailscale = name.startsWith('tailscale') || (o1 === 100 && o2 >= 64 && o2 < 128)
      out.push({ url: `http://${a.address}:${port}`, kind: tailscale ? 'tailscale' : 'LAN' })
    }
  }
  return out
}

export default pi => {
  pi.ext.webpane = {
    async boundPort(port) {
      const free = !(await portInUse(port))
      const lines = addresses(port).map(a => `${a.url}${a.kind === 'local' ? '' : `   (${a.kind})`}`)
      pi.dialog({ title: `:${port} ${free ? 'starting…' : 'already running'}`, body: lines.join('\n'), OK: () => {} })
      return free ? port : null
    },
  }
  pi.tui.dispose(() => delete pi.ext.webpane)

  pi.command('w', async () => {
    if ((await pi.ext.webpane.boundPort(port)) == null) return
    const log = openSync(join(pi.tui.state.init?.dataDir ?? '.', 'cloudcli.log'), 'a')
    spawn('npx', ['-y', '@cloudcli-ai/cloudcli'], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, PORT: String(port) },
    }).unref()
  })
}
