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

test('pi`` submits the line (Enter is added on the Zig side)', async () => {
  const sent = []
  const { pi } = createHost(m => sent.push(m))
  const dir = '/tmp/x'
  await pi`/add-dir ${dir}`
  await pi`echo a\nb`
  // String.raw: the backslash sequence is not cooked.
  assert.deepEqual(sent, [
    { t: 'submit', data: '/add-dir /tmp/x' },
    { t: 'submit', data: 'echo a\\nb' },
  ])
})

test('pi.BUFFER is write-only', () => {
  const sent = []
  const { pi } = createHost(m => sent.push(m))
  pi.BUFFER = 'draft'
  assert.deepEqual(sent, [{ t: 'buffer', data: 'draft' }])
  assert.equal(pi.BUFFER, undefined)
})

test('pi.arg: defaults from init, assignments go to Zig', () => {
  const sent = []
  const { pi, dispatch } = createHost(m => sent.push(m))
  dispatch({ t: 'init', cols: 80, rows: 24, arg: { fzf: '--pointer x' } })
  assert.equal(pi.arg.fzf, '--pointer x')
  assert.deepEqual(sent, [])
  pi.arg.fzf = '--height=20%'
  assert.equal(pi.arg.fzf, '--height=20%')
  assert.deepEqual(sent, [{ t: 'arg', key: 'fzf', value: '--height=20%' }])
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
