import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activePortUrl, chromeDirs, findBrowser, history } from '../cdp.js'
import { addTrust, f12, f12Report, mcpInstalled, parseToken, siteMatch, tabByKey, tabItems, trustPattern, urlItems } from '../plugins/f12.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'cld-pi-f12-'))
const tick = () => new Promise(r => setTimeout(r, 5))

test('parseToken: //site/ is URL mode, // and //title are tab mode', () => {
  assert.deepEqual(parseToken('//gh/foo'), { site: 'gh', rest: 'foo' })
  assert.deepEqual(parseToken('//GH/'), { site: 'gh', rest: '' })
  assert.equal(parseToken('//'), null)
  assert.equal(parseToken('//git'), null)
})

test('siteMatch: host prefix, or the letters in order from the first', () => {
  assert.ok(siteMatch('gh', 'github.com'))
  assert.ok(siteMatch('git', 'gitlab.com'))
  assert.ok(siteMatch('yt', 'youtube.com'))
  assert.ok(!siteMatch('gh', 'gitlab.com'))
  assert.ok(!siteMatch('gh', 'about.github.com'))
  assert.ok(!siteMatch('', 'github.com'))
})

test('urlItems: web URLs on the site, deduplicated, order kept', () => {
  const urls = ['https://github.com/a', 'chrome://newtab', 'https://www.github.com/b', 'https://github.com/a', 'https://gitlab.com/c']
  assert.deepEqual(urlItems('gh', urls), ['https://github.com/a', 'https://www.github.com/b'])
})

test('tabItems: one line per tab, duplicates numbered', () => {
  const items = tabItems([
    { title: 'Issues\n· x', url: 'https://github.com/x' },
    { title: 'Issues · x', url: 'https://github.com/y' },
    { title: '', url: 'about:blank' },
  ])
  assert.deepEqual(
    items.map(i => i.label),
    ['Issues · x — github.com', 'Issues · x — github.com (2)', 'about:blank — about:blank'],
  )
})

test('tabByKey: targetId first, then the URL, then its prefix', () => {
  const tabs = [
    { targetId: 'T1', url: 'https://github.com/a/b' },
    { targetId: 'T2', url: 'https://github.com/abc' },
  ]
  assert.equal(tabByKey(tabs, 'T2'), tabs[1])
  assert.equal(tabByKey(tabs, 'https://github.com/abc'), tabs[1])
  assert.equal(tabByKey(tabs, 'https://github.com/a'), tabs[0])
  assert.equal(tabByKey(tabs, ''), null)
  assert.equal(tabByKey(tabs, 'https://gitlab.com/'), null)
})

test('trustPattern: the origin, any path; nothing for non-web URLs', () => {
  assert.equal(trustPattern('https://github.com/a/b?c'), 'https://github.com/*')
  assert.equal(trustPattern('http://localhost:3000/x'), 'http://localhost:3000/*')
  assert.equal(trustPattern('chrome://newtab/'), null)
})

test('addTrust creates the file and appends each pattern once', async () => {
  const file = join(tmp(), '.F12-mcp.json')
  assert.equal(await addTrust(file, 'https://github.com/*'), true)
  assert.equal(await addTrust(file, 'https://github.com/*'), false)
  writeFileSync(file, JSON.stringify({ headless: false, allowedUrlPattern: ['https://a.com/*'] }))
  await addTrust(file, 'https://b.com/*')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { headless: false, allowedUrlPattern: ['https://a.com/*', 'https://b.com/*'] })
})

test('mcpInstalled: user or project scope', () => {
  assert.ok(mcpInstalled(JSON.stringify({ mcpServers: { 'chrome-devtools': {} } })))
  assert.ok(mcpInstalled(JSON.stringify({ projects: { '/p': { mcpServers: { 'chrome-devtools': {} } } } })))
  assert.ok(!mcpInstalled(JSON.stringify({ projects: { '/p': {} } })))
  assert.ok(!mcpInstalled('not json'))
})

test('activePortUrl / chromeDirs / findBrowser via DevToolsActivePort', async () => {
  assert.equal(activePortUrl('9222\n/devtools/browser/abc\n'), 'ws://127.0.0.1:9222/devtools/browser/abc')
  assert.equal(activePortUrl('garbage'), null)
  const home = tmp()
  assert.equal(await findBrowser({ env: {}, home, platform: 'linux' }), null)
  const dir = chromeDirs(home, 'linux')[2] // chromium
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/x')
  assert.deepEqual(await findBrowser({ env: {}, home, platform: 'linux' }), { url: 'ws://127.0.0.1:9333/devtools/browser/x', dir })
  assert.deepEqual(await findBrowser({ env: { CLAUDE_P_CDP: 'ws://h/devtools/browser/y' }, home }), { url: 'ws://h/devtools/browser/y', dir: null })
})

test('history reads the last used profile, newest first', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = tmp()
  mkdirSync(join(dir, 'Profile 1'))
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 1' } }))
  const db = new DatabaseSync(join(dir, 'Profile 1', 'History'))
  db.exec('CREATE TABLE urls (url TEXT, title TEXT, last_visit_time INTEGER)')
  db.exec("INSERT INTO urls VALUES ('https://old.com/', 'old', 1), ('https://new.com/', 'new', 2)")
  db.close()
  assert.deepEqual(
    (await history(dir)).map(r => r.url),
    ['https://new.com/', 'https://old.com/'],
  )
  assert.deepEqual(await history(null), [])
})

// A recording pi with just what f12 uses.
function fakePi(dataDir) {
  const dialogs = []
  const pi = { ext: {}, tui: { state: { init: { dataDir } }, dispose: () => {} } }
  pi.dialog = d => (dialogs.push(d), Promise.resolve(null))
  pi.sh = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
  pi.complete = (prefix, source, pick) => Object.assign(pi, { prefix, source, pick })
  return { pi, dialogs }
}

const fakeCdp = (browser, tabList = [], visited = []) => ({
  findBrowser: async () => browser,
  connect: async () => ({ closed: false, close() {} }),
  tabs: async () => tabList,
  history: async dir => (dir ? visited : []),
  screenshot: async (_, targetId) => Buffer.from(`png of ${targetId}`),
  devtools: async () => [{ kind: 'console', level: 'error', text: 'boom\nline 2', at: 'https://github.com/app.js:3' }],
})

test('// without a debuggable Chrome: no candidates, a dialog explains chrome://inspect', async () => {
  const home = tmp()
  const { pi, dialogs } = fakePi(home)
  f12({ home, cdp: fakeCdp(null) })(pi)
  assert.equal(pi.prefix, '//')
  assert.deepEqual(await pi.source('//'), [])
  assert.match(dialogs[0].body, /chrome:\/\/inspect\/#remote-debugging/)
})

test('// picks a tab: screenshot → @png, site trusted, MCP offered once', async () => {
  const home = tmp()
  const shots = tmp()
  const { pi, dialogs } = fakePi(home)
  const tabs = [{ targetId: 'T1', title: 'Repo', url: 'https://github.com/a/b', type: 'page' }]
  f12({ home, shots, cdp: fakeCdp({ url: 'ws://x', dir: null }, tabs) })(pi)
  const items = await pi.source('//')
  assert.deepEqual(items, ['Repo — github.com'])
  const text = await pi.pick(items[0], '//')
  const [png, md] = text.split(' ')
  assert.match(png, /^@.*cld-pi-github\.com-\d+\.png$/)
  assert.equal(md, `${png.slice(0, -'.png'.length)}.f12.md`)
  assert.equal(readFileSync(png.slice(1), 'utf8'), 'png of T1')
  const report = readFileSync(md.slice(1), 'utf8')
  assert.match(report, /URL: https:\/\/github\.com\/a\/b/)
  assert.match(report, /- \[error\] boom ⏎ line 2  \(https:\/\/github\.com\/app\.js:3\)/)
  assert.match(report, /MCP is not installed/)
  await tick()
  const cfg = JSON.parse(readFileSync(join(home, '.F12-mcp.json'), 'utf8'))
  assert.deepEqual(cfg.allowedUrlPattern, ['https://github.com/*'])
  assert.ok(existsSync(join(home, 'f12-mcp-offered')))
  assert.equal(dialogs.at(-1).title, 'Let Claude use this Chrome?')
  await pi.pick(items[0], '//')
  await tick()
  assert.equal(dialogs.filter(d => d.title === 'Let Claude use this Chrome?').length, 1)
})

test('//gh/ offers tab and history URLs on the site; the pick is typed as-is and trusted', async () => {
  const home = tmp()
  const { pi } = fakePi(home)
  const tabs = [{ targetId: 'T1', title: 'x', url: 'https://github.com/open', type: 'page' }]
  const visited = [{ url: 'https://github.com/seen' }, { url: 'https://gitlab.com/no' }]
  f12({ home, cdp: fakeCdp({ url: 'ws://x', dir: '/chrome' }, tabs, visited) })(pi)
  assert.deepEqual(await pi.source('//gh/'), ['https://github.com/open', 'https://github.com/seen'])
  assert.equal(await pi.pick('https://github.com/seen', '//gh/'), 'https://github.com/seen')
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.F12-mcp.json'), 'utf8')).allowedUrlPattern, ['https://github.com/*'])
})

test('pi.ext.f12.addTrust and an existing MCP: config created at start, no offer', async () => {
  const home = tmp()
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'chrome-devtools': {} } }))
  const { pi } = fakePi(home)
  f12({ home, cdp: fakeCdp(null) })(pi)
  await tick()
  assert.equal(readFileSync(join(home, '.F12-mcp.json'), 'utf8'), '{}\n')
  await pi.ext.f12.addTrust('https://a.com/*')
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.F12-mcp.json'), 'utf8')).allowedUrlPattern, ['https://a.com/*'])
})

test('pi.ext.f12.devtools: tab by URL or id, optional reload, the live entries', async () => {
  const home = tmp()
  const { pi, dialogs } = fakePi(home)
  const tabs = [{ targetId: 'T1', title: 'Repo', url: 'https://github.com/a/b', type: 'page' }]
  const cdp = fakeCdp({ url: 'ws://x', dir: null }, tabs)
  const seen = []
  cdp.reloads = []
  cdp.reload = async (_, id) => void cdp.reloads.push(id)
  cdp.devtools = async (_, id) => (seen.push(id), [{ kind: 'console', level: 'log', text: id, at: '' }])
  f12({ home, cdp })(pi)

  assert.deepEqual(await pi.ext.f12.devtools('https://github.com/a', { reload: true }), [{ kind: 'console', level: 'log', text: 'T1', at: '' }])
  assert.deepEqual(cdp.reloads, ['T1'])
  await pi.ext.f12.devtools('T1')
  assert.deepEqual(cdp.reloads, ['T1']) // no reload unless asked
  assert.deepEqual(seen, ['T1', 'T1'])

  assert.equal(await pi.ext.f12.devtools('https://gitlab.com/'), null)
  assert.equal(dialogs.at(-1).body, 'No Chrome tab for https://gitlab.com/')
})

test('pi.ext.f12.devtools: no debuggable Chrome explains chrome://inspect', async () => {
  const home = tmp()
  const { pi, dialogs } = fakePi(home)
  f12({ home, cdp: fakeCdp(null) })(pi)
  assert.equal(await pi.ext.f12.devtools('any'), null)
  assert.match(dialogs[0].body, /chrome:\/\/inspect/)
})

test('f12Report: MCP pointer, unreadable console, the last `max` entries', () => {
  const base = { title: 'T', url: 'https://a.com/', png: '/tmp/a.png' }
  assert.match(f12Report({ ...base, entries: [], mcp: true }), /list_pages, then select_page[\s\S]*\(empty\)/)
  assert.match(f12Report({ ...base, entries: null, mcp: true }), /could not read the console/)
  const many = Array.from({ length: 5 }, (_, i) => ({ kind: 'log', level: 'warning', text: `w${i}`, at: '' }))
  const r = f12Report({ ...base, entries: many, mcp: false, max: 2 })
  assert.match(r, /\(5, last 2\)/)
  assert.ok(!r.includes('w2') && r.includes('- [log warning] w4'))
})
