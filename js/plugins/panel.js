// Ctrl+P: the settings panel. Every control is a button whose label is
// hot-swapped; a change goes to CC and the label only moves once the new
// state is read back off the screen (or the settings file).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bashOutputRows, effortOf, efforts, modeOf, modes, modelFamily, models, summarizeTranscript } from '../session.js'

// Permission checkboxes → allow rules in the project's settings.local.json
// (CC reloads it on change).
const perms = { file: ['Edit', 'Write'], web: ['WebFetch', 'WebSearch'] }

export const settingsPath = (cwd = process.cwd()) => join(cwd, '.claude', 'settings.local.json')

export function readSettings(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export const isAllowed = (settings, key) => perms[key].every(r => settings.permissions?.allow?.includes(r))

/** Add / remove `key`'s allow rules, keeping everything else in the file. */
export function setAllowed(path, key, on) {
  const s = readSettings(path)
  const allow = new Set(s.permissions?.allow ?? [])
  for (const r of perms[key]) on ? allow.add(r) : allow.delete(r)
  s.permissions = { ...s.permissions, allow: [...allow] }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n')
}

export const radio = (v, cur) => `${v === cur ? '●' : '○'} ${v}`
export const checkbox = (name, on) => `[${on ? 'x' : ' '}] ${name}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
// "Set model to Opus 5.5" etc.
const modelSet = fam => s => new RegExp(`Set model to[^\\n]*${fam}`, 'i').test(s.text)
const actions = ['CtrlO', 'CtrlR', 'Undo', 'Copy']

export default pi => {
  const { tui } = pi
  let hideBash = null // disposer of the sed that blanks Bash output
  let open = false

  // A fresh frame: waiting subscribes to frames, and Zig dumps one at once.
  const screen = async () => {
    await tui.wait(() => true, 500)
    return tui.state.scr?.text ?? ''
  }

  const bashRows = new WeakMap()
  const hideOutput = () =>
    pi.sed((ln, i, rows) => {
      if (!bashRows.has(rows)) bashRows.set(rows, bashOutputRows(rows))
      return bashRows.get(rows).has(i) ? `\x1b[48;5;236m${' '.repeat(tui.state.cols || 80)}` : null
    })

  async function show() {
    open = true
    const text = await screen()
    let sum = { cost: 0, unpriced: 0, name: null, model: null }
    try {
      if (tui.state.transcript) sum = summarizeTranscript(readFileSync(tui.state.transcript, 'utf8'))
    } catch {}
    const path = settingsPath()
    const cur = { model: modelFamily(sum.model), effort: effortOf(text), mode: modeOf(text) }
    let file = isAllowed(readSettings(path), 'file')
    let web = isAllowed(readSettings(path), 'web')

    // Rows of buttons; a radio row is relabeled as a whole once CC agrees.
    const rows = { model: models, effort: efforts, mode: modes }
    const offset = { model: 0, effort: models.length, mode: models.length + efforts.length }
    let dlg
    const pick = (row, v) => {
      cur[row] = v
      rows[row].forEach((x, i) => dlg.relabel(offset[row] + i, radio(x, v)))
      return radio(v, v)
    }
    const radios = (row, apply) =>
      Object.fromEntries(rows[row].map(v => [radio(v, cur[row]), async () => (v === cur[row] ? radio(v, v) : apply(v))]))
    const radioHints = (row, hint) => Object.fromEntries(rows[row].map(v => [radio(v, cur[row]), hint(v)]))

    const setModel = async to => {
      await pi`/model ${to}`
      if (await tui.wait(modelSet(to), 3000)) return pick('model', to)
      return radio(to, cur.model)
    }
    const setEffort = async to => {
      await pi`/effort ${to}`
      let ok = await tui.wait(s => effortOf(s.text) === to, 2000)
      // No argument support: CC opened its slider instead; walk it.
      if (!ok && (await screen()).includes('to adjust')) {
        const steps = efforts.indexOf(to) - efforts.indexOf(cur.effort)
        for (let i = 0; i < Math.abs(steps); i++) await tui.press(steps > 0 ? 'right' : 'left')
        await tui.press('enter')
        ok = await tui.wait(s => effortOf(s.text) === to, 2000)
      }
      const now = effortOf(await screen()) ?? cur.effort
      return now === to ? pick('effort', to) : radio(to, now)
    }
    const setMode = async to => {
      let now = cur.mode
      for (let i = 0; i < 4 && now !== to; i++) {
        const before = now
        await tui.press('shift-tab')
        await tui.wait(s => modeOf(s.text) !== before, 1000)
        now = modeOf(await screen())
      }
      if (now === to) return pick('mode', to)
      cur.mode = now
      modes.forEach((x, i) => dlg.relabel(offset.mode + i, radio(x, now)))
      return radio(to, now)
    }

    const cost = `$${sum.cost.toFixed(2)}${sum.unpriced ? '+?' : ''}`
    const labels = { file: checkbox('file', file), web: checkbox('web', web), bash: checkbox('bash', !hideBash) }
    dlg = pi.dialog({
      title: `${sum.name ?? 'this session'}  ·  ${cost}`,
      footer: '↑↓←→ move · Enter apply · Esc close',
      eachRow: [models.length, efforts.length, modes.length, 3, actions.length],
      hints: {
        ...radioHints('model', v => `/model ${v}`),
        ...radioHints('effort', v => `/effort ${v}`),
        ...radioHints('mode', v => `${v === 'acc' ? 'accept edits' : v} mode (Shift+Tab until the status line agrees)`),
        [labels.file]: 'Allow Edit / Write without asking (.claude/settings.local.json)',
        [labels.web]: 'Allow WebFetch / WebSearch without asking (.claude/settings.local.json)',
        [labels.bash]: 'Show or hide Bash tool output on screen',
        CtrlO: 'Open the transcript (Ctrl+O)',
        CtrlR: 'Search prompt history (Ctrl+R)',
        Undo: 'Rewind the conversation (Esc Esc)',
        Copy: 'Copy the last reply (/copy)',
      },
      ...radios('model', setModel),
      ...radios('effort', setEffort),
      ...radios('mode', setMode),
      [labels.file]: () => {
        setAllowed(path, 'file', !file)
        file = isAllowed(readSettings(path), 'file')
        return checkbox('file', file)
      },
      [labels.web]: () => {
        setAllowed(path, 'web', !web)
        web = isAllowed(readSettings(path), 'web')
        return checkbox('web', web)
      },
      [labels.bash]: () => {
        if (hideBash) {
          hideBash()
          hideBash = null
        } else hideBash = hideOutput()
        return checkbox('bash', !hideBash)
      },
      CtrlO: () => tui.press('ctrl-o').then(() => {}),
      CtrlR: () => tui.press('ctrl-r').then(() => {}),
      Undo: async () => {
        await tui.press('esc')
        await sleep(200) // two separate presses, not one ESC ESC burst
        await tui.press('esc')
      },
      Copy: () => pi`/copy`.then(() => {}),
    })
    await dlg
    open = false
  }

  pi.on({
    CtrlP: () => {
      if (!open) show().catch(() => (open = false))
      return false // not CC's Ctrl+P
    },
  })
}
