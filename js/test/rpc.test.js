import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, lineSplitter } from '../rpc.js'

test('lineSplitter handles split and batched chunks', () => {
  const lines = []
  const feed = lineSplitter(l => lines.push(l))
  feed('{"a":1}\n{"b"')
  feed(':2}\n\n{"c":3}\n')
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}'])
})

test('pi`` sends a write message with interpolation', async () => {
  const sent = []
  const { pi } = createHost(m => sent.push(m))
  const dir = '/tmp/x'
  await pi`/add-dir ${dir}\r`
  assert.deepEqual(sent, [{ t: 'write', data: '/add-dir /tmp/x\r' }])
})

test('hook events reach pi.on handlers and awaitable pi.on.xxx', async () => {
  const { pi, dispatch } = createHost(() => {})
  const seen = []
  const off = pi.on({ stop: p => seen.push(p.session_id) })
  const next = pi.on.notification
  dispatch({ t: 'hook', event: 'Stop', payload: { session_id: 's1' } })
  dispatch({ t: 'hook', event: 'Notification', payload: { message: 'hi' } })
  assert.deepEqual(seen, ['s1'])
  assert.deepEqual(await next, { message: 'hi' })
  off()
  dispatch({ t: 'hook', event: 'Stop', payload: { session_id: 's2' } })
  assert.deepEqual(seen, ['s1'])
})

test('init and resize update state', () => {
  const { pi, dispatch } = createHost(() => {})
  dispatch({ t: 'init', cols: 80, rows: 24 })
  dispatch({ t: 'resize', cols: 100, rows: 30 })
  assert.equal(pi.state.cols, 100)
  assert.equal(pi.state.rows, 30)
})
