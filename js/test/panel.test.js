import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost } from '../rpc.js'
import panel, { checkbox, isAllowed, radio, readSettings, setAllowed } from '../plugins/panel.js'

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))

test('radio / checkbox labels', () => {
  assert.equal(radio('medium', 'medium'), '● medium')
  assert.equal(radio('low', 'medium'), '○ low')
  assert.equal(checkbox('web', true), '[x] web')
})

test('setAllowed edits only its rules and keeps the rest of the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-'))
  const path = join(dir, '.claude', 'settings.local.json')
  mkdirSync(join(dir, '.claude'))
  writeFileSync(path, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, other: 1 }))
  setAllowed(path, 'web', true)
  assert.ok(isAllowed(readSettings(path), 'web'))
  assert.deepEqual(readSettings(path), { permissions: { allow: ['Bash(ls)', 'WebFetch', 'WebSearch'] }, other: 1 })
  setAllowed(path, 'web', false)
  assert.deepEqual(readSettings(path).permissions.allow, ['Bash(ls)'])
})

// A host whose "Zig side" acks typed lines and shows scripted screens.
function harness() {
  const sent = []
  let host
  const screens = []
  const frame = text => host.dispatch({ t: 'scr', rows: text.split('\n'), cursor: { row: 0, col: 0 } })
  host = createHost(m => {
    sent.push(m)
    if (m.t === 'submit' || m.t === 'press') {
      queueMicrotask(() => {
        host.dispatch({ t: 'done', id: m.id })
        const next = screens.shift()
        if (next) setTimeout(() => frame(next), 1)
      })
    }
    if (m.t === 'subscribe' && m.scr) setTimeout(() => frame(screens.current), 1)
  })
  screens.current = ''
  return { host, sent, frame, screens }
}

test('Ctrl+P opens the panel; effort and file buttons change state and read it back', async () => {
  const cwd = process.cwd()
  process.chdir(mkdtempSync(join(tmpdir(), 'panel-cwd-')))
  try {
    const { host, sent, screens } = harness()
    await host.loadPlugin('panel.js', panel)
    assert.deepEqual(sent.find(m => m.t === 'keys'), { t: 'keys', names: ['CtrlP'] })

    screens.current = '                 ◐ medium · /effort\n  ⏵⏵ auto mode on (shift+tab to cycle)'
    host.dispatch({ t: 'key', id: 1, name: 'CtrlP' })
    assert.deepEqual(sent.find(m => m.t === 'key_result'), { t: 'key_result', id: 1, prevent: true })
    await tick(20)
    const d = sent.find(m => m.t === 'dialog')
    assert.equal(d.title, 'this session  ·  $0.00')
    assert.deepEqual(d.eachRow, [4, 5, 3, 3, 4])
    assert.deepEqual(d.buttons.slice(4, 9), ['○ low', '● medium', '○ high', '○ xhigh', '○ max'])
    assert.deepEqual(d.buttons.slice(9, 12), ['○ plan', '○ acc', '● auto'])
    assert.deepEqual(d.buttons.slice(15), ['CtrlO', 'CtrlR', 'Undo', 'Copy'])
    assert.equal(d.footer, '/model haiku')

    // effort: types /effort high, waits for the status line to say so
    screens.current = '                 ◐ high · /effort\n  ⏵⏵ auto mode on (shift+tab to cycle)'
    screens.push(screens.current)
    host.dispatch({ t: 'dialog_button', id: d.id, index: 6 })
    await tick(40)
    assert.ok(sent.some(m => m.t === 'submit' && m.data === '/effort high'))
    const relabels = sent.filter(m => m.t === 'dialog_update' && m.label).map(m => [m.index, m.label])
    assert.deepEqual(relabels.slice(0, 5), [[4, '○ low'], [5, '○ medium'], [6, '● high'], [7, '○ xhigh'], [8, '○ max']])

    // file: writes .claude/settings.local.json in the project dir
    host.dispatch({ t: 'dialog_button', id: d.id, index: 12 })
    await tick(10)
    assert.deepEqual(JSON.parse(readFileSync('.claude/settings.local.json', 'utf8')).permissions.allow, ['Edit', 'Write'])
    assert.equal(sent.findLast(m => m.t === 'dialog_update' && m.label).label, '[x] file')

    // mode: acc means accept edits; Shift+Tab until the status line says so
    screens.current = '  ⏵⏵ accept edits on (shift+tab to cycle)'
    screens.push(screens.current)
    host.dispatch({ t: 'dialog_button', id: d.id, index: 10 })
    await tick(60)
    assert.ok(sent.some(m => m.t === 'press' && m.key === 'shift-tab'))
    const labels = {}
    for (const m of sent) if (m.t === 'dialog_update' && m.index != null && m.label) labels[m.index] = m.label
    assert.deepEqual([labels[9], labels[10], labels[11]], ['○ plan', '● acc', '○ auto'])

    // bash output: hides via pi.sed
    host.dispatch({ t: 'dialog_button', id: d.id, index: 14 })
    await tick(10)
    assert.equal(sent.findLast(m => m.t === 'dialog_update' && m.label).label, '[ ] bash')
    host.dispatch({ t: 'scr', rows: ['● Bash(ls)', '  ⎿  secret.txt', 'next'], cursor: { row: 0, col: 0 } })
    assert.equal(sent.findLast(m => m.t === 'paint').rows[0][0], 1)
    await host.setEnabled('panel.js', false)
  } finally {
    process.chdir(cwd)
  }
})
