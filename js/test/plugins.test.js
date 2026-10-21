import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { tmpdir } from 'node:os'
import addDir from '../plugins/add-dir.js'
import webpane, { addresses, portInUse } from '../plugins/webpane.js'
import magpie from '../plugins/magpie.js'

// A recording stand-in for pi: never touches a terminal or spawns anything
// unless the plugin under test does.
function fakePi({ waits = [] } = {}) {
  const calls = []
  const commands = {}
  const pi = (strings, ...values) => (calls.push(['line', String.raw(strings, ...values)]), Promise.resolve())
  pi.command = (name, run) => (commands[name] = run)
  pi.tui = {
    press: key => (calls.push(['press', key]), Promise.resolve()),
    wait: cond => (calls.push(['wait', typeof cond]), Promise.resolve(waits.shift() ?? false)),
    state: { init: { dataDir: tmpdir() } },
  }
  pi.dialog = d => (calls.push(['dialog', d.title ?? d.body]), (pi.lastDialog = d), Promise.resolve(null))
  pi.sh = (strings, ...values) => {
    const line = String.raw(strings, ...values.map(v => `'${v}'`))
    calls.push(['sh', line])
    return Promise.resolve(pi.shResults?.shift() ?? { code: 0, stdout: '', stderr: '' })
  }
  pi.ext = {}
  pi.tui.dispose = () => {}
  return { pi, calls, commands }
}

test('portInUse sees a listening server', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  const { port } = srv.address()
  assert.equal(await portInUse(port), true)
  await new Promise(r => srv.close(r))
  assert.equal(await portInUse(port), false)
})

test('addresses: localhost, LAN and tailscale', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    wlan0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.101.1.2', internal: false }],
  }
  assert.deepEqual(addresses(3001, ifaces), [
    { url: 'http://localhost:3001', kind: 'local' },
    { url: 'http://192.168.1.5:3001', kind: 'LAN' },
    { url: 'http://100.101.1.2:3001', kind: 'tailscale' },
  ])
})

test('/ad: add-dir, confirm the dialog, then tree', async () => {
  const { pi, calls, commands } = fakePi({ waits: [true, true] })
  addDir(pi)
  await commands.ad(['~/src'])
  assert.deepEqual(calls, [
    ['line', '/add-dir ~/src'],
    ['wait', 'string'],
    ['press', 'enter'],
    ['wait', 'function'],
    ['line', '!tree -L 2 ~/src'],
  ])
})

test('/ad without a dir only explains itself', async () => {
  const { pi, calls, commands } = fakePi()
  addDir(pi)
  await commands.ad([])
  assert.deepEqual(calls, [['dialog', 'usage: /ad <dir>']])
})

test('webpane publishes pi.ext.webpane; /w does not start a second server when :3001 is taken', async () => {
  const { pi, commands } = fakePi()
  webpane(pi)
  assert.equal(typeof pi.ext.webpane.boundPort, 'function')
  let asked
  pi.ext.webpane.boundPort = async port => ((asked = port), null)
  await commands.w([])
  assert.equal(asked, 3001)
})

test('/m runs magpie through pi.sh when it is installed', async () => {
  const { pi, calls, commands } = fakePi()
  magpie(pi)
  await commands.m([])
  assert.match(calls[0][1], /^test -x '.*\/\.local\/bin\/magpie'$/)
  assert.match(calls[1][1], /magpie' panel >\/dev\/null 2>&1 &$/)
})

test('/m without magpie: OK copies the installer command', async () => {
  const { pi, calls, commands } = fakePi()
  pi.shResults = [{ code: 1, stdout: '', stderr: '' }]
  magpie(pi)
  await commands.m([])
  assert.deepEqual(calls[1], ['dialog', 'magpie is not installed'])
  await pi.lastDialog.OK()
  assert.match(calls[2][1], /^printf %s 'curl -fsSL https:\/\/usemagpie\.ai\/install\.sh \| sh' \| \(wl-copy/)
})
