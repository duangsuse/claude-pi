#!/usr/bin/env node
// Page through recorded terminal streams (*.vt) by replaying them into this
// terminal. ←/→ (or h/l, space) switch files, q / Esc / Ctrl+C quit.
//
//   node scripts/vt-view.mjs [dir]        # default: src/pi/testdata
//
// The fixtures are raw CC output captured at 100x30; a terminal of that size
// shows them exactly, a bigger one shows them in the top-left corner.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'src', 'pi', 'testdata'))
const files = readdirSync(dir).filter(f => f.endsWith('.vt')).sort()
if (!files.length) {
  console.error(`no .vt files in ${dir}`)
  process.exit(1)
}
if (!process.stdin.isTTY) {
  console.error('vt-view needs a terminal')
  process.exit(1)
}

const out = s => process.stdout.write(s)
// Undo what a CC stream turns on: mouse reporting, bracketed paste, focus
// events, kitty keyboard flags; then show the cursor.
const quiet = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l\x1b[=0;1u\x1b[0m\x1b[?25h'
// Drop terminal queries (DA1/DA2, XTVERSION, cursor report, kitty keyboard,
// OSC color queries) so the terminal doesn't answer into our stdin.
const queries = ['\x1b[c', '\x1b[0c', '\x1b[>c', '\x1b[>0c', '\x1b[>q', '\x1b[>0q', '\x1b[6n', '\x1b[?u']
const stripQueries = buf => {
  let s = buf.toString('latin1')
  for (const q of queries) s = s.split(q).join('')
  return s.replace(/\x1b\]1[0-9];\?(?:\x07|\x1b\\)/g, '')
}

let i = 0
const show = () => {
  const data = readFileSync(join(dir, files[i]))
  const rows = process.stdout.rows || 30
  out('\x1b[!p\x1b[?1049h\x1b[H\x1b[2J')
  out(Buffer.from(stripQueries(data), 'latin1'))
  out(quiet)
  const bar = ` ${i + 1}/${files.length}  ${files[i]}  (${data.length} B)   ←/→ page · q quit `
  out(`\x1b[${rows};1H\x1b[2K\x1b[7m${bar}\x1b[0m`)
}

const quit = () => {
  out(quiet + '\x1b[?1049l')
  process.stdin.setRawMode(false)
  process.exit(0)
}

process.stdin.setRawMode(true)
process.stdin.on('data', d => {
  const k = d.toString('latin1')
  if (k === 'q' || k === '\x03' || k === '\x1b') return quit()
  if (k === '\x1b[C' || k === 'l' || k === ' ' || k === '\x1b[6~') i = (i + 1) % files.length
  else if (k === '\x1b[D' || k === 'h' || k === '\x1b[5~') i = (i - 1 + files.length) % files.length
  else return
  show()
})
process.stdout.on('resize', show)
show()
