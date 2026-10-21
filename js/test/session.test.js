import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bashOutputRows, effortOf, modeOf, modelFamily, normalizeModel, summarizeTranscript, usageCost } from '../session.js'

test('normalizeModel strips gateway prefixes, dots and tags', () => {
  assert.equal(normalizeModel('anthropic/claude-opus-5.5'), 'claude-opus-5-5')
  assert.equal(normalizeModel('a/anthropic/claude-opus-5-5[1m]'), 'claude-opus-5-5')
  assert.equal(normalizeModel('claude-sonnet-5-5'), 'claude-sonnet-5-5')
})

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('usageCost: input/output, cache writes by TTL, model-specific cache reads, fast mode', () => {
  // Opus 5.5: $4 in, $20 out, reads $0.20, writes 1.25x/2x
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } }
  near(usageCost('claude-opus-5-5', u), 4 + 20 + 0.2 + 5 + 8)
  // default cache read is 0.1x input
  near(usageCost('claude-sonnet-4-6', { cache_read_input_tokens: 1e6 }), 0.3)
  near(usageCost('claude-opus-5-5', { input_tokens: 1e6, speed: 'fast' }), 8)
  assert.equal(usageCost('some-other-model', u), null)
})

test('summarizeTranscript counts each message once, takes the latest title and model', () => {
  const lines = [
    { type: 'ai-title', aiTitle: 'First guess' },
    { type: 'assistant', message: { id: 'm1', model: 'anthropic/claude-opus-5.5', usage: { output_tokens: 1e6 } } },
    { type: 'assistant', message: { id: 'm1', model: 'anthropic/claude-opus-5.5', usage: { output_tokens: 1e6 } } },
    { type: 'assistant', message: { id: 'm2', model: 'claude-haiku-5-5', usage: { output_tokens: 2e6 } } },
    { type: 'ai-title', aiTitle: 'Better title' },
    'not json',
  ].map(l => (typeof l === 'string' ? l : JSON.stringify(l)))
  const s = summarizeTranscript(lines.join('\n'))
  near(s.cost, 20 + 1)
  assert.equal(s.name, 'Better title')
  assert.equal(s.model, 'claude-haiku-5-5')
  assert.equal(summarizeTranscript(JSON.stringify({ type: 'custom-title', customTitle: 'mine' }) + '\n' + lines[0]).name, 'mine')
})

test('status line parsing (strings recorded from CC 2.1)', () => {
  assert.equal(effortOf('                                ◐ medium · /effort'), 'medium')
  assert.equal(modeOf('  ⏵⏵ auto mode on (shift+tab to cycle)'), 'auto')
  assert.equal(modeOf('  ⏸ manual mode on · ? for shortcuts'), 'norm')
  assert.equal(modeOf('  ⏵⏵ accept edits on (shift+tab to cycle)'), 'acc')
  assert.equal(modeOf('  ⏸ plan mode on (shift+tab to cycle)'), 'plan')
  assert.equal(modelFamily('anthropic/claude-opus-5.5'), 'opus')
  assert.equal(modelFamily('Fable 5.1'), 'fable')
})

test('bashOutputRows: the ⎿ row and its continuation, not the header or the next block', () => {
  const rows = ['● Bash(ls)', '  ⎿  a.txt', '     b.txt', '', '● Read(x)', '  ⎿  Read 3 lines', '● Bash(pwd)', '  ⎿  /tmp']
  assert.deepEqual([...bashOutputRows(rows)], [1, 2, 7])
})

test('tailEntries: only new lines, a partial line waits, a shrunk file starts over', async () => {
  const { tailEntries } = await import('../session.js')
  const { mkdtempSync, writeFileSync, appendFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const f = join(mkdtempSync(join(tmpdir(), 'tail-')), 't.jsonl')
  writeFileSync(f, '{"a":1}\n{"a":')
  const tail = tailEntries()
  assert.deepEqual(tail(f), [{ a: 1 }])
  appendFileSync(f, '2}\n')
  assert.deepEqual(tail(f), [{ a: 2 }])
  assert.deepEqual(tail(f), [])
  writeFileSync(f, '{"b":1}\n')
  assert.deepEqual(tail(f), [{ b: 1 }])
})
