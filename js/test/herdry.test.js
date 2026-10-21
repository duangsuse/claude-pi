import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from '../rpc.js'
import { spinner } from '../plugins/herdry.js'

const tick = ms => new Promise(r => setTimeout(r, ms))

// A fake tab backend: never the real Yakuake/Guake one.
const fakeTab = () => {
  const tab = { title: 'Shell #3', sets: [] }
  tab.get = async () => tab.title
  tab.set = async t => {
    tab.sets.push(t)
    tab.title = t
  }
  return tab
}

const setup = async () => {
  const tab = fakeTab()
  const host = createHost(() => {}, () => {}, { tab: Promise.resolve(tab) })
  host.installTimerHooks({})
  await host.loadPlugin('herdry.js', pi => spinner(pi, { every: 5 }))
  return { host, tab }
}

test('spins "<frame> <message>" until focus, then restores the title', async () => {
  const { host, tab } = await setup()
  host.dispatch({ t: 'focus', focused: false })
  host.dispatch({ t: 'hook', event: 'Stop', payload: { last_assistant_message: 'All tests pass.\nmore' } })
  await tick(40)
  assert.ok(tab.sets.length >= 3)
  assert.deepEqual(tab.sets.slice(0, 3), ['· All tests pass.', '✢ All tests pass.', '* All tests pass.'])
  host.dispatch({ t: 'hook', event: 'Notification', payload: { message: 'Needs permission' } })
  await tick(20)
  assert.match(tab.title, /^. Needs permission$/)
  host.dispatch({ t: 'focus', focused: true })
  await tick(20)
  assert.equal(tab.title, 'Shell #3')
  const n = tab.sets.length
  await tick(20)
  assert.equal(tab.sets.length, n) // stopped
})

test('no spin while focused (the starting state); off restores mid-spin', async () => {
  const { host, tab } = await setup()
  host.dispatch({ t: 'hook', event: 'Stop', payload: { last_assistant_message: 'ignored' } }) // focused until told otherwise
  await tick(20)
  assert.equal(tab.sets.length, 0)

  host.dispatch({ t: 'focus', focused: false })
  host.dispatch({ t: 'hook', event: 'Notification', payload: { message: 'spinning' } })
  await tick(20)
  assert.notEqual(tab.title, 'Shell #3')
  await host.setEnabled('herdry.js', false)
  await tick(5)
  assert.equal(tab.title, 'Shell #3')
})
