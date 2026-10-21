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

test('dialog: buttons are one-arg callbacks; string relabels, void closes', async () => {
  const sent = []
  const { pi, dispatch } = createHost(m => sent.push(m))
  let checked = false
  const done = pi.dialog({
    title: 'T',
    body: 'first row\nsecond',
    '[ ] web': row1 => ((checked = !checked), checked ? '[x] web' : '[ ] web'),
    OK: row1 => {},
  })
  assert.deepEqual(sent[0], { t: 'dialog', id: 1, title: 'T', body: 'first row\nsecond', footer: '', buttons: ['[ ] web', 'OK'], modal: true, vertical: false })
  dispatch({ t: 'dialog_button', id: 1, index: 0, row1: 'first row' })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(sent[1], { t: 'dialog_update', id: 1, index: 0, label: '[x] web' })
  dispatch({ t: 'dialog_button', id: 1, index: 1, row1: 'first row' })
  assert.equal(await done, 'OK')
  assert.deepEqual(sent[2], { t: 'dialog_close', id: 1 })
})

test('dialog dismissed resolves null; menu resolves the item', async () => {
  const sent = []
  const { pi, dispatch } = createHost(m => sent.push(m))
  const d = pi.dialog({ body: 'x', OK() {} })
  dispatch({ t: 'dialog_closed', id: 1 })
  assert.equal(await d, null)
  const m = pi.menu(['a', 'b'])
  assert.deepEqual(sent[1], { t: 'menu', id: 2, items: ['a', 'b'] })
  dispatch({ t: 'menu_result', id: 2, index: 1 })
  assert.equal(await m, 'b')
})

test("sed: '' blanks, null leaves the row alone; only changes are sent", () => {
  const sent = []
  const { pi, dispatch } = createHost(m => sent.push(m))
  pi.sed(ln => (ln.includes('secret') ? '' : null))
  pi.sed(ln => (ln.includes('foo') ? ln.replace('foo', 'bar') : null))
  assert.deepEqual(sent, [{ t: 'subscribe', scr: true }])
  const frame = { t: 'scr', rows: ['ok', 'secret 1', 'foo'], cursor: { row: 0, col: 0 } }
  dispatch(frame)
  assert.deepEqual(sent[1], { t: 'paint', rows: [[1, ''], [2, 'bar']] })
  dispatch(frame)
  assert.equal(sent.length, 2)
  assert.equal(pi.state.scr.text, 'ok\nsecret 1\nfoo')
})

test('notify goes through the host io; focus is tracked', () => {
  const notes = []
  const { pi, dispatch } = createHost(() => {}, () => {}, { notify: m => notes.push(m) })
  pi.notify('hi')
  dispatch({ t: 'focus', focused: false })
  assert.deepEqual(notes, ['hi'])
  assert.equal(pi.state.focused, false)
})

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

test('turning a plugin off drops its listeners, seds and timers; on re-runs it', async () => {
  const sent = []
  const host = createHost(m => sent.push(m))
  const timers = {} // a private target, so the real globals stay untouched
  const uninstall = host.installTimerHooks(timers)
  let stops = 0
  let ticks = 0
  await host.loadPlugin('p.js', pi => {
    pi.on({ stop: () => stops++ })
    pi.sed(ln => (ln === 'x' ? '' : null))
    timers.setInterval(() => ticks++, 5)
  })
  assert.deepEqual(sent.find(m => m.t === 'badge'), { t: 'badge', text: ' ◆ plugins 1/1 ' })
  host.dispatch({ t: 'hook', event: 'Stop', payload: {} })
  host.dispatch({ t: 'scr', rows: ['x'], cursor: { row: 0, col: 0 } })
  assert.equal(stops, 1)
  assert.deepEqual(sent.findLast(m => m.t === 'paint'), { t: 'paint', rows: [[0, '']] })
  await tick(30)
  assert.ok(ticks > 0)
  assert.equal(host.plugins.get('p.js').timers.size, 1)

  await host.setEnabled('p.js', false)
  const ticksAtOff = ticks
  host.dispatch({ t: 'hook', event: 'Stop', payload: {} })
  await tick(30)
  assert.equal(stops, 1)
  assert.equal(ticks, ticksAtOff)
  assert.deepEqual(sent.findLast(m => m.t === 'paint'), { t: 'paint', rows: [] })
  assert.deepEqual(sent.findLast(m => m.t === 'subscribe'), { t: 'subscribe', scr: false })
  assert.deepEqual(sent.findLast(m => m.t === 'badge'), { t: 'badge', text: ' ◆ plugins 0/1 ' })

  await host.setEnabled('p.js', true)
  host.dispatch({ t: 'hook', event: 'Stop', payload: {} })
  assert.equal(stops, 2)
  await host.setEnabled('p.js', false)
  uninstall()
})

test('timers created inside a listener belong to the plugin too', async () => {
  const host = createHost(() => {})
  const timers = {}
  host.installTimerHooks(timers)
  let fired = 0
  await host.loadPlugin('late.js', pi => {
    pi.on({ stop: () => timers.setTimeout(() => fired++, 20) })
  })
  host.dispatch({ t: 'hook', event: 'Stop', payload: {} })
  assert.equal(host.plugins.get('late.js').timers.size, 1)
  await host.setEnabled('late.js', false)
  await tick(40)
  assert.equal(fired, 0)
})

test('non-modal dialog: timeout presses the `or` button', async () => {
  const sent = []
  const { pi } = createHost(m => sent.push(m))
  let got
  const r = pi.dialog({ title: 'Saved', body: 'row one', timeout: 20, or: 'OK', OK: row1 => (got = row1) })
  assert.equal(sent[0].modal, false)
  assert.deepEqual(sent[0].buttons, ['OK']) // timeout / or are config, not buttons
  assert.equal(await r, 'OK')
  assert.equal(got, 'row one')
  assert.deepEqual(sent.at(-1), { t: 'dialog_close', id: 1 })

  const r2 = pi.dialog({ body: 'toast', timeout: 10 })
  assert.equal(await r2, null)
})

test('badge click lists plugins as a vertical dialog; a button toggles', async () => {
  const sent = []
  const host = createHost(m => sent.push(m))
  await host.loadPlugin('a.js', () => {})
  host.dispatch({ t: 'badge_click' })
  const d = sent.findLast(m => m.t === 'dialog')
  assert.equal(d.vertical, true)
  assert.deepEqual(d.buttons, ['[x] a.js', 'Done'])
  host.dispatch({ t: 'dialog_button', id: d.id, index: 0, row1: '' })
  await tick()
  assert.deepEqual(sent.findLast(m => m.t === 'dialog_update'), { t: 'dialog_update', id: d.id, index: 0, label: '[ ] a.js' })
  assert.equal(host.plugins.get('a.js').enabled, false)
})
