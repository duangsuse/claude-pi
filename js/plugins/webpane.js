// pi.ext.webpane + /w. webpane.boundPort(port): free → returns the port
// (the caller starts its server), taken → null; either way a dialog lists
// where it can be reached, http-server style, with buttons to copy the LAN /
// tailscale URL or show the tailscale one as a QR code (for a phone). /w does
// that for the cloudcli web UI on :3001 and starts it in the background when
// nothing serves it.
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

/**
 * qrcode-terminal's output (two spaces per module, white \e[47m / black
 * \e[40m) as half blocks: two module rows per line, light modules drawn in
 * the foreground colour, so it reads right on a dark background.
 */
export function halfBlocks(ansi) {
  const rows = ansi
    .split('\n')
    .filter(l => l.includes('\x1b['))
    .map(l => [...l.matchAll(/\x1b\[(4[07])m {2}/g)].map(m => m[1] === '47'))
  const out = []
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y]
    const bottom = rows[y + 1] ?? []
    out.push(top.map((t, x) => (t && bottom[x] ? '█' : t ? '▀' : bottom[x] ? '▄' : ' ')).join(''))
  }
  return out.join('\n')
}

const copy = (pi, text) => pi.sh`printf %s ${text} | (wl-copy || xclip -selection clipboard || pbcopy) 2>/dev/null`

export default pi => {
  pi.ext.webpane = {
    async boundPort(port) {
      const free = !(await portInUse(port))
      const all = addresses(port)
      const body = all.map(a => `${a.url}${a.kind === 'local' ? '' : `   (${a.kind})`}`).join('\n')
      const url = kind => all.find(a => a.kind === kind)?.url
      const missing = (kind, label) => (dlg.text({ footer: `no ${kind} address` }), label)
      const copied = (kind, label) => async () => {
        if (!url(kind)) return missing(kind, label)
        await copy(pi, url(kind))
        dlg.text({ footer: `copied ${url(kind)}` })
        return label
      }
      const dlg = pi.dialog({
        title: `:${port} ${free ? 'starting…' : 'already running'}`,
        body,
        footer: 'Esc closes',
        'Copy LAN': copied('LAN', 'Copy LAN'),
        'Copy tailscale': copied('tailscale', 'Copy tailscale'),
        'tailscale QR': async () => {
          const ts = url('tailscale')
          if (!ts) return missing('tailscale', 'tailscale QR')
          dlg.text({ footer: 'npx qrcode-terminal …' })
          const qr = await pi.sh`printf %s ${ts} | npx -y qrcode-terminal`
          if (qr.code !== 0) return (dlg.text({ footer: `qrcode-terminal failed (exit ${qr.code})` }), 'tailscale QR')
          dlg.text({ body: `${halfBlocks(qr.stdout)}\n${ts}`, footer: 'scan with your phone · Esc closes' })
          return 'tailscale QR'
        },
      })
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
