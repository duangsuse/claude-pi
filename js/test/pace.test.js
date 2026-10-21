import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPace, duration } from '../plugins/pace.js'

const at = s => new Date(Date.UTC(2026, 9, 21, 0, 0, s)).toISOString()
const usage = { input_tokens: 1000, output_tokens: 1000 } // opus 5.5: $0.004 + $0.02

test('duration', () => {
  assert.equal(duration(1234), '1.2s')
  assert.equal(duration(125_000), '2m05s')
})

test('pace: the last ● took, live while running, cost over 3 minutes counted once per message', () => {
  const p = createPace()
  const t0 = Date.parse(at(0))
  assert.equal(p.view(t0), null)
  p.add({ type: 'user', timestamp: at(0) })
  p.add({ type: 'assistant', timestamp: at(4), message: { id: 'm1', model: 'claude-opus-5-5', usage } })
  p.add({ type: 'assistant', timestamp: at(6), message: { id: 'm1', model: 'claude-opus-5-5', usage } })
  assert.equal(p.view(t0 + 9000), '● 3.0s… · 3m $0.02') // 3 s since the last block
  p.stop()
  assert.equal(p.view(t0 + 9000), '● 2.0s · 3m $0.02')
  assert.equal(p.view(t0 + 200_000), '● 2.0s · 3m $0.00') // m1 left the window
  p.add({ type: 'summary' }) // no timestamp: ignored
  assert.equal(p.view(t0 + 200_000), '● 2.0s · 3m $0.00')
})
