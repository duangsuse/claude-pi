import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandStubs, stub } from '../stubs.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'cldp-stub-'))

test('command stubs are plugin commands whose bare name is an alias', () => {
  const dir = tempDir()
  const sync = commandStubs(dir)
  sync(['ad', 'm'])
  const ad = join(dir, 'commands', 'ad.md')
  assert.equal(readFileSync(ad, 'utf8'), stub('ad'))
  assert.match(readFileSync(ad, 'utf8'), /^---\nname: ad\n/)
  assert.match(readFileSync(ad, 'utf8'), /description: "​"/)
  assert.ok(existsSync(join(dir, 'commands', 'm.md')))

  sync(['ad']) // a command going away takes its stub with it
  assert.equal(existsSync(join(dir, 'commands', 'm.md')), false)
  sync.cleanup()
  assert.equal(existsSync(ad), false)
})

test('stubs leave other files alone and never escape the dir', () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'commands'), { recursive: true })
  writeFileSync(join(dir, 'commands', 'mine.md'), 'user')
  writeFileSync(join(dir, 'commands', 'ad.md'), 'user too')
  const sync = commandStubs(dir)
  sync(['mine', 'ad', '../x', 'ok'])
  assert.equal(readFileSync(join(dir, 'commands', 'mine.md'), 'utf8'), 'user')
  assert.equal(readFileSync(join(dir, 'commands', 'ad.md'), 'utf8'), 'user too')
  assert.equal(existsSync(join(dir, 'x.md')), false)
  assert.ok(existsSync(join(dir, 'commands', 'ok.md')))
  sync.cleanup()
  assert.equal(readFileSync(join(dir, 'commands', 'mine.md'), 'utf8'), 'user')
})

test('without a plugin dir there is nothing to do', () => {
  const sync = commandStubs(undefined)
  sync(['ad'])
  sync.cleanup()
})
