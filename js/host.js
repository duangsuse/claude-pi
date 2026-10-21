// node sidecar spawned by `claude-p` in interactive mode. Speaks JSON lines
// on stdio (see src/pi/sidecar.zig). stderr is discarded by the binary, so
// everything diagnostic goes to ~/claude/-p/host.log -- only while that file
// exists (touch it to turn logging on; claude-p removes it on exit).
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import inspector from 'node:inspector'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHost, lineSplitter } from './rpc.js'
import { commandStubs } from './stubs.js'
import { openTab, pickTab } from './tab.js'

const dataDir = process.env.CLAUDE_P_DIR || join(homedir(), 'claude', '-p')
mkdirSync(dataDir, { recursive: true })
const logFile = join(dataDir, 'host.log')
const log = (...a) => {
  const line = a.map(x => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  try {
    if (existsSync(logFile)) appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

// Desktop notification; best effort (notify-send on Linux, osascript on macOS).
const notify = msg => {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "Claude Code"`]]
      : ['notify-send', ['-a', 'Claude Code', 'Claude Code', msg]]
  const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
  p.on('error', e => log('notify failed', e.message))
  p.unref()
}

// pi.sh: one shell line. Resolves at the shell's exit (plus a moment for
// output to drain) so `cmd &` doesn't hold it up.
const sh = line =>
  new Promise(resolve => {
    const p = spawn('/bin/sh', ['-c', line], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', d => (stdout += d))
    p.stderr.on('data', d => (stderr += d))
    p.on('error', e => resolve({ code: 127, stdout, stderr: String(e) }))
    p.on('exit', code => setTimeout(() => resolve({ code: code ?? 1, stdout, stderr }), 50))
  })

const stubs = commandStubs(process.argv[2] || process.env.CLAUDE_P_PLUGIN_DIR)
process.on('exit', stubs.cleanup)
// The binary closes our stdin on exit; signals take the shorter path (and
// still run the 'exit' cleanup above).
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => process.exit(0))
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n')
const host = createHost(send, log, { notify, sh, tab: pickTab(), openTab, stubs })
const { pi, dispatch } = host
// Timers plugins create are charged to them (cleared when turned off).
host.installTimerHooks()

// Debugging is on by default: open chrome://inspect (F12) and poke the global
// `pi`, e.g. pi`hello`. Listens on 127.0.0.1 only; 9229 is what chrome://inspect
// discovers out of the box, a random port is the fallback when it's taken
// (another claude-p). CLAUDE_P_INSPECT=0 turns it off, =<port> picks one.
globalThis.pi = pi
const inspectEnv = process.env.CLAUDE_P_INSPECT
if (inspectEnv !== '0') {
  const ports = inspectEnv ? [Number(inspectEnv)] : [9229, 0]
  for (const port of ports) {
    // A busy port doesn't throw: node prints to stderr and url() stays empty.
    try {
      inspector.open(port, '127.0.0.1')
    } catch (e) {
      log(`inspector: port ${port}`, e.message)
    }
    if (inspector.url()) break
    log(`inspector: port ${port} unavailable`)
  }
  const url = inspector.url()
  if (url) {
    log('inspector', url)
    try {
      writeFileSync(join(dataDir, 'inspect'), url + '\n')
    } catch {}
  }
}

pi.on({
  init: m => log('init', { cols: m.cols, rows: m.rows, pid: m.pid }),
  sessionStart: p => log('sessionStart', p?.session_id),
})

// Default plugins shipped in js/plugins/, then the user's ~/claude/-p/*.js
// (listed as ~/name.js). Each can be turned off from the badge's list.
const loadDir = async (dir, prefix) => {
  let files = []
  try {
    // .js relies on Node's ESM syntax detection (22.12+); .mjs works everywhere.
    files = readdirSync(dir).filter(f => /\.m?js$/.test(f)).sort()
  } catch {}
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href)
      if (typeof mod.default !== 'function') throw new Error('no default export function')
      await host.loadPlugin(prefix + f, mod.default)
      log('plugin', prefix + f)
    } catch (e) {
      log(`plugin ${prefix + f} failed`, e)
    }
  }
}
await loadDir(join(import.meta.dirname, 'plugins'), '')
await loadDir(dataDir, '~/')
// The binary waits for this before spawning claude: the command stubs must
// be on disk by the time claude scans --plugin-dir.
send({ t: 'ready' })

process.stdin.setEncoding('utf8')
process.stdin.on(
  'data',
  lineSplitter(line => {
    try {
      dispatch(JSON.parse(line))
    } catch (e) {
      log('bad line', line, e)
    }
  }),
)
// The binary closes our stdin on exit; follow it down.
process.stdin.on('end', () => process.exit(0))
process.on('uncaughtException', e => log('uncaught', e))
process.on('unhandledRejection', e => log('unhandled', e))
