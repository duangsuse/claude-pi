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

test('pi`` submits the line and resolves when Zig says it was typed', async () => {
  const sent = []
  const { pi, dispatch } = createHost(m => sent.push(m))
  const dir = '/tmp/x'
  let typed = false
  const p = pi`/add-dir ${dir}`.then(() => (typed = true))
  pi`echo a\nb`
  // String.raw: the backslash sequence is not cooked.
  assert.deepEqual(sent, [
    { t: 'submit', data: '/add-dir /tmp/x', id: 1 },
    { t: 'submit', data: 'echo a\\nb', id: 2 },
  ])
  await new Promise(r => setImmediate(r))
  assert.equal(typed, false)
  dispatch({ t: 'done', id: 1 })
  await p
  assert.equal(typed, true)
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
  assert.equal(pi.tui.state.cols, 100)
  assert.equal(pi.tui.state.rows, 30)
})

test('dialog: buttons are no-arg callbacks; string relabels, void closes', async () => {
  const sent = []
  const { pi, dispatch } = createHost(m => sent.push(m))
  let checked = false
  const done = pi.dialog({
    title: 'T',
    body: 'first row\nsecond',
    '[ ] web': () => ((checked = !checked), checked ? '[x] web' : '[ ] web'),
    OK: () => {},
  })
  assert.deepEqual(sent[0], { t: 'dialog', id: 1, title: 'T', body: 'first row\nsecond', footer: '', buttons: ['[ ] web', 'OK'], modal: true, active: 0 })
  dispatch({ t: 'dialog_button', id: 1, index: 0 })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(sent[1], { t: 'dialog_update', id: 1, index: 0, label: '[x] web' })
  dispatch({ t: 'dialog_button', id: 1, index: 1 })
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
  assert.equal(pi.tui.state.scr.text, 'ok\nsecret 1\nfoo')
})

test('tui.dispose runs when the plugin is turned off', async () => {
  const host = createHost(() => {})
  let disposed = 0
  await host.loadPlugin('d.js', pi => pi.tui.dispose(() => disposed++))
  await host.setEnabled('d.js', false)
  assert.equal(disposed, 1)
})

test('pi.sh quotes interpolated values', async () => {
  const lines = []
  const { pi } = createHost(() => {}, () => {}, { sh: async line => (lines.push(line), { code: 0, stdout: 'ok', stderr: '' }) })
  const evil = "x'; rm -rf ~; echo '"
  const r = await pi.sh`echo ${evil} ${'a b'}`
  assert.equal(r.stdout, 'ok')
  assert.equal(lines[0], String.raw`echo 'x'\''; rm -rf ~; echo '\''' 'a b'`)
})

test('dialog handle: relabel any button, replace texts', () => {
  const sent = []
  const { pi } = createHost(m => sent.push(m))
  const dlg = pi.dialog({ title: 't', '○ a': () => {}, '● b': () => {} })
  dlg.relabel('○ a', '● a')
  dlg.relabel(1, '○ b')
  dlg.text({ body: 'picked a' })
  assert.deepEqual(sent.slice(1), [
    { t: 'dialog_update', id: 1, index: 0, label: '● a' },
    { t: 'dialog_update', id: 1, index: 1, label: '○ b' },
    { t: 'dialog_update', id: 1, body: 'picked a' },
  ])
})

test('notify goes through the host io; focus is tracked', () => {
  const notes = []
  const { pi, dispatch } = createHost(() => {}, () => {}, { notify: m => notes.push(m) })
  pi.notify('hi')
  dispatch({ t: 'focus', focused: false })
  assert.deepEqual(notes, ['hi'])
  assert.equal(pi.tui.state.focused, false)
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
  const r = pi.dialog({ title: 'Saved', body: 'row one', timeout: 20, or: 'OK', OK: () => (got = 'pressed') })
  assert.equal(sent[0].modal, false)
  assert.deepEqual(sent[0].buttons, ['OK']) // timeout / or are config, not buttons
  assert.equal(await r, 'OK')
  assert.equal(got, 'pressed')
  assert.deepEqual(sent.at(-1), { t: 'dialog_close', id: 1 })

  const r2 = pi.dialog({ body: 'toast', timeout: 10 })
  assert.equal(await r2, null)
})

test('badge click lists plugins one per row; a button toggles', async () => {
  const sent = []
  const host = createHost(m => sent.push(m))
  await host.loadPlugin('a.js', () => {})
  host.dispatch({ t: 'badge_click' })
  const d = sent.findLast(m => m.t === 'dialog')
  assert.equal(d.eachRow, 'vertical')
  assert.deepEqual(d.buttons, ['[x] a.js', 'Done'])
  host.dispatch({ t: 'dialog_button', id: d.id, index: 0 })
  await tick()
  assert.deepEqual(sent.findLast(m => m.t === 'dialog_update'), { t: 'dialog_update', id: d.id, index: 0, label: '[ ] a.js' })
  assert.equal(host.plugins.get('a.js').enabled, false)
})

test('commands, completions and key hooks: registered with Zig, dropped with the plugin', async () => {
  const sent = []
  const host = createHost(m => sent.push(m))
  const ran = []
  await host.loadPlugin('cmds.js', pi => {
    pi.command('ad', args => ran.push(args))
    pi.complete('//', tok => [tok + 'a', tok + 'b'])
    pi.on({ CtrlP: () => false, ShiftTab: () => {} })
  })
  assert.deepEqual(sent.findLast(m => m.t === 'commands'), { t: 'commands', names: ['ad'] })
  assert.deepEqual(sent.findLast(m => m.t === 'completions'), { t: 'completions', prefixes: ['//'] })
  assert.deepEqual(sent.findLast(m => m.t === 'keys'), { t: 'keys', names: ['CtrlP', 'ShiftTab'] })

  host.dispatch({ t: 'command', name: 'ad', args: ' ~/x   y ' })
  host.dispatch({ t: 'complete', id: 7, prefix: '//', token: '//gh' })
  host.dispatch({ t: 'key', id: 8, name: 'CtrlP' })
  host.dispatch({ t: 'key', id: 9, name: 'ShiftTab' })
  await tick(5)
  assert.deepEqual(ran, [['~/x', 'y']])
  assert.deepEqual(sent.find(m => m.t === 'complete_result'), { t: 'complete_result', id: 7, items: ['//gha', '//ghb'] })
  assert.deepEqual(sent.filter(m => m.t === 'key_result'), [
    { t: 'key_result', id: 8, prevent: true },
    { t: 'key_result', id: 9, prevent: false },
  ])

  await host.setEnabled('cmds.js', false)
  assert.deepEqual(sent.findLast(m => m.t === 'commands'), { t: 'commands', names: [] })
  assert.deepEqual(sent.findLast(m => m.t === 'completions'), { t: 'completions', prefixes: [] })
  assert.deepEqual(sent.findLast(m => m.t === 'keys'), { t: 'keys', names: [] })
})

test('pi.complete with a pick: Zig sends the chosen line back, the text it gets is typed', async () => {
  const sent = []
  const host = createHost(m => sent.push(m))
  await host.loadPlugin('shot.js', pi => {
    pi.complete('//', () => ['a — x.com', 'b — y.com'], async (item, tok) => (item.startsWith('a') ? `@/tmp/a.png#${tok}` : null))
    pi.complete('#', () => ['#x'])
  })
  host.dispatch({ t: 'complete', id: 3, prefix: '//', token: '//x' })
  host.dispatch({ t: 'complete', id: 4, prefix: '#', token: '#' })
  await tick(5)
  assert.deepEqual(sent.find(m => m.id === 3), { t: 'complete_result', id: 3, items: ['a — x.com', 'b — y.com'], pick: true })
  assert.deepEqual(sent.find(m => m.id === 4), { t: 'complete_result', id: 4, items: ['#x'] })

  host.dispatch({ t: 'complete', id: 5, prefix: '//', token: '//' })
  await tick(5)
  host.dispatch({ t: 'picked', id: 5, item: 'a — x.com' })
  await tick(5)
  assert.deepEqual(sent.at(-1), { t: 'pick_result', id: 5, text: '@/tmp/a.png#//' })
  host.dispatch({ t: 'complete', id: 6, prefix: '//', token: '//' })
  await tick(5)
  host.dispatch({ t: 'picked', id: 6, item: 'b — y.com' })
  await tick(5)
  assert.deepEqual(sent.at(-1), { t: 'pick_result', id: 6, text: null })
})

test('pi.tui.wait matches text or a predicate, times out with false; press sends a key', async () => {
  const sent = []
  const { pi, dispatch } = createHost(m => sent.push(m))
  const w = pi.tui.wait('Yes, for this session', 500)
  assert.deepEqual(sent.at(-1), { t: 'subscribe', scr: true })
  dispatch({ t: 'scr', rows: ['nothing yet'], cursor: { row: 0, col: 0 } })
  dispatch({ t: 'scr', rows: ['❯ 1. Yes, for this session'], cursor: { row: 0, col: 0 } })
  assert.equal(await w, true)
  assert.deepEqual(sent.at(-1), { t: 'subscribe', scr: false })
  assert.equal(await pi.tui.wait(s => s.rows.length > 5, 20), false)
  pi.tui.press('enter')
  assert.deepEqual(sent.at(-1), { t: 'press', key: 'enter', id: 1 })
})

test('dialog eachRow passes through; focus starts true', () => {
  const sent = []
  const { pi } = createHost(m => sent.push(m))
  assert.equal(pi.tui.state.focused, true)
  pi.dialog({ title: 'Panel', a() {}, b() {}, c() {}, d() {}, eachRow: [2, 2] })
  assert.deepEqual(sent[0].eachRow, [2, 2])
  assert.deepEqual(sent[0].buttons, ['a', 'b', 'c', 'd'])
})

test('tui.title: tab backend gets the text; null restores the original once', async () => {
  const sets = []
  const tab = { get: async () => 'Shell #3', set: async t => sets.push(t) }
  const { pi } = createHost(() => {}, () => {}, { tab: Promise.resolve(tab) })
  await Promise.all([pi.tui.title('aaab'), pi.tui.title('aaac')])
  await pi.tui.title(null)
  await pi.tui.title(null) // nothing left to restore
  assert.deepEqual(sets, ['aaab', 'aaac', 'Shell #3'])
})

test('tui.title without a tab backend uses the window title (OSC via Zig)', async () => {
  const sent = []
  const { pi } = createHost(m => sent.push(m))
  await pi.tui.title('x')
  await pi.tui.title(null)
  assert.deepEqual(sent, [{ t: 'title', text: 'x' }, { t: 'title', text: null }])
})

test('toast: starts on `or`, ←/→ picks, timeout presses the pick; hints follow focus', async () => {
  const sent = []
  const { pi, dispatch } = createHost(m => sent.push(m))
  const pressed = []
  const r = pi.dialog({ body: 'keep?', timeout: 30, or: 'Keep', Keep: () => pressed.push('Keep'), Drop: () => pressed.push('Drop') })
  assert.equal(sent[0].active, 0)
  dispatch({ t: 'dialog_active', id: 1, index: 1 })
  assert.equal(await r, 'Drop')
  assert.deepEqual(pressed, ['Drop'])

  pi.dialog({ footer: 'f', hints: { A: 'about A', B: 'about B' }, A() {}, B() {} })
  const d = sent.findLast(m => m.t === 'dialog')
  assert.equal(d.footer, 'about A')
  dispatch({ t: 'dialog_active', id: d.id, index: 1 })
  assert.deepEqual(sent.at(-1), { t: 'dialog_update', id: d.id, footer: 'about B' })
})

test('sed callbacks get the row index and all rows', () => {
  const sent = []
  const { pi, dispatch } = createHost(m => sent.push(m))
  pi.sed((ln, i, rows) => (i > 0 && rows[i - 1] === 'hide next' ? '' : null))
  dispatch({ t: 'scr', rows: ['hide next', 'secret', 'ok'], cursor: { row: 0, col: 0 } })
  assert.deepEqual(sent.at(-1), { t: 'paint', rows: [[1, '']] })
})

test('pi.notify snack / snackRD take the badge corners; off with the plugin', async () => {
  const sent = []
  const host = createHost(m => sent.push(m))
  await host.loadPlugin('s.js', pi => {
    pi.notify('● 1.0s', 'snack')
    pi.notify('3m $0.10', 'snackRD')
  })
  const badges = () => sent.filter(m => m.t === 'badge')
  assert.deepEqual(badges().findLast(m => !m.pos), { t: 'badge', text: ' ● 1.0s ' })
  assert.deepEqual(badges().findLast(m => m.pos), { t: 'badge', pos: 'rd', text: ' 3m $0.10 ' })
  host.pi.notify('', 'snack') // not the plugin's snack: no owner, nothing to drop
  await host.setEnabled('s.js', false)
  assert.deepEqual(badges().findLast(m => !m.pos), { t: 'badge', text: ' ◆ plugins 0/1 ' })
  assert.deepEqual(badges().findLast(m => m.pos), { t: 'badge', pos: 'rd', text: null })
})

test('toast: ←/→ restarts the timeout', async () => {
  const host = createHost(() => {})
  let pressed = null
  const r = host.pi.dialog({ body: 'b', timeout: 40, or: 'A', A: () => (pressed = 'A'), B: () => (pressed = 'B') })
  await tick(25)
  host.dispatch({ t: 'dialog_active', id: 1, index: 1 })
  await tick(25)
  assert.equal(pressed, null) // 50 ms in, but re-armed at 25
  assert.equal(await r, 'B')
})

test('snack bg: 256-colour, #hex, none; bad values fall back to the default', async () => {
  const { snackSgr } = await import('../rpc.js')
  assert.equal(snackSgr(236), '1;38;5;230;48;5;236')
  assert.equal(snackSgr('#102030'), '1;38;5;230;48;2;16;32;48')
  assert.equal(snackSgr('none'), '2;38;5;212;49')
  assert.equal(snackSgr('red;5'), undefined)
  const sent = []
  const host = createHost(m => sent.push(m))
  await host.loadPlugin('s.js', pi => pi.notify('x', 'snackRD', { bg: 'none' }))
  assert.deepEqual(sent.findLast(m => m.pos), { t: 'badge', pos: 'rd', text: ' x ', sgr: '2;38;5;212;49' })
})

test('wheel reports reach pi.on({ wheel })', () => {
  const host = createHost(() => {})
  const dirs = []
  host.pi.on({ wheel: d => dirs.push(d) })
  host.dispatch({ t: 'wheel', dir: -1 })
  assert.deepEqual(dirs, [-1])
})
