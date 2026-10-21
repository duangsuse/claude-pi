// node sidecar spawned by `claude-p` in interactive mode. Speaks JSON lines
// on stdio (see src/pi/sidecar.zig). stderr is discarded by the binary, so
// everything diagnostic goes to ~/claude/-p/host.log.
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHost, lineSplitter } from './rpc.js'

const dataDir = join(homedir(), 'claude', '-p')
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
