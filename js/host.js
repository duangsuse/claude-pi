// node sidecar spawned by `claude-p` in interactive mode. Speaks JSON lines
// on stdio (see src/pi/sidecar.zig). stderr is discarded by the binary, so
// everything diagnostic goes to ~/claude/-p/host.log.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import inspector from 'node:inspector'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHost, lineSplitter } from './rpc.js'

const dataDir = process.env.CLAUDE_P_DIR || join(homedir(), 'claude', '-p')
mkdirSync(dataDir, { recursive: true })
const logFile = join(dataDir, 'host.log')
const log = (...a) => {
  const line = a.map(x => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n')
const { pi, dispatch } = createHost(send, log)

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
