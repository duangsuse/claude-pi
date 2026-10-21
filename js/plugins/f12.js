// Chrome tabs (P5) + pi.ext.f12.
//   `//` + Tab      fzf over the open tabs (title — host); the pick is
//                   screenshotted to $TMPDIR and typed as `@/tmp/….png`.
//   `//gh/` + Tab   URLs from the tabs and Chrome's history whose host
//                   matches `gh` (github.com), typed as-is.
// Every site picked either way goes into ~/.F12-mcp.json's allowedUrlPattern
// (pi.ext.f12.addTrust), the config of the chrome-devtools MCP that gives
// Claude the browser; the first `//` offers that MCP's install command.
// Chrome must have remote debugging allowed (chrome://inspect/#remote-debugging);
// CLAUDE_P_CDP=<port|url> points at another browser (agent tests: 9224).
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as cdpLib from '../cdp.js'

export const inspectUrl = 'chrome://inspect/#remote-debugging'
export const mcpInstall =
  'claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest \\\n  --autoConnect --config ~/.F12-mcp.json --watchConfig'

/** `//gh/rest` → { site: 'gh', rest }; `//` or `//title` (tab mode) → null. */
export function parseToken(tok) {
  const m = /^\/\/([^/\s]+)\/(.*)$/.exec(tok)
  return m ? { site: m[1].toLowerCase(), rest: m[2] } : null
}

const bareHost = url => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** `gh` names github.com: a prefix of the host, or its letters in order from the first. */
export function siteMatch(site, host) {
  host = host.toLowerCase()
  if (!site || !host) return false
  if (host.startsWith(site)) return true
  if (host[0] !== site[0]) return false
  let i = 0
  for (const ch of host.split('.')[0]) if (ch === site[i]) i++
  return i === site.length
}

/** http(s) URLs on a matching site, deduplicated, in the given order. */
export function urlItems(site, urls) {
  const seen = new Set()
  return urls.filter(u => /^https?:/.test(u) && siteMatch(site, bareHost(u)) && !seen.has(u) && seen.add(u))
}

/** One fzf line per tab: `title — host` (unique, single line). */
export function tabItems(targets) {
  const seen = new Map()
  return targets.map(t => {
    const base = `${(t.title || t.url).replace(/\s+/g, ' ').trim()} — ${bareHost(t.url) || t.url}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { label: n > 1 ? `${base} (${n})` : base, target: t }
  })
}

/** allowedUrlPattern for a page: its origin, any path. null for non-web URLs. */
export function trustPattern(url) {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.host}/*` : null
  } catch {
    return null
  }
}

/** Append `pattern` to the config's allowedUrlPattern (creating the file); true if it was new. */
export async function addTrust(file, pattern) {
  let cfg = {}
  try {
    cfg = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${file}: ${e.message}`)
  }
  const list = cfg.allowedUrlPattern ?? []
  if (list.includes(pattern)) return false
  cfg.allowedUrlPattern = [...list, pattern]
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n')
  return true
}

/** Whether ~/.claude.json has a chrome-devtools MCP server (user or any project scope). */
export function mcpInstalled(claudeJson) {
  let cfg
  try {
    cfg = JSON.parse(claudeJson)
  } catch {
    return false
  }
  const scopes = [cfg.mcpServers, ...Object.values(cfg.projects ?? {}).map(p => p?.mcpServers)]
  return scopes.some(s => s && 'chrome-devtools' in s)
}

const copy = (pi, text) => pi.sh`printf %s ${text} | (wl-copy || xclip -selection clipboard || pbcopy) 2>/dev/null`

/**
 * The plugin, with its world injectable for tests: `home` (for
 * ~/.F12-mcp.json and ~/.claude.json), `env`, and the CDP functions.
 */
export const f12 = ({ home = homedir(), env = process.env, cdp = cdpLib, shots = tmpdir() } = {}) => pi => {
  const mcpConfig = join(home, '.F12-mcp.json')
  const trust = async pattern => {
    try {
      await addTrust(mcpConfig, pattern)
    } catch (e) {
      pi.dialog({ body: `allowedUrlPattern not updated: ${e.message}`, timeout: 4000 })
    }
  }
  pi.ext.f12 = { addTrust: trust }

  // chrome-devtools-mcp --config fails when the file is missing. `{}`, not an
  // empty allowedUrlPattern: the MCP rejects an empty list.
  const installed = async () => mcpInstalled(await readFile(join(home, '.claude.json'), 'utf8').catch(() => ''))
  const ensureConfig = async () => {
    if (!existsSync(mcpConfig)) await writeFile(mcpConfig, '{}\n')
  }
  installed()
    .then(yes => yes && ensureConfig())
    .catch(() => {})
  pi.tui.dispose(() => delete pi.ext.f12)

  // One connection for the session: with chrome://inspect's switch, each
  // new one may ask the user to Allow it.
  let browser = null // Promise<{ cdp, dir } | null>
  const open = async () => {
    const b = await browser
    if (b?.cdp && !b.cdp.closed) return b
    browser = (async () => {
      const at = await cdp.findBrowser({ env, home })
      if (!at) return null
      const allow = setTimeout(() => pi.dialog({ body: 'Chrome: click Allow to let cld-pi connect', timeout: 6000 }), 1500)
      try {
        return { cdp: await cdp.connect(at.url), dir: at.dir }
      } catch {
        return { cdp: null, dir: at.dir }
      } finally {
        clearTimeout(allow)
      }
    })()
    return browser
  }
  pi.tui.dispose(() => browser?.then(b => b?.cdp?.close()))

  const offline = () =>
    pi.dialog({
      title: 'Chrome remote debugging is off',
      body: `Open ${inspectUrl} in Chrome (144+),\nallow remote debugging, then Tab again.\nThe MCP's allowedUrlPattern needs Chrome 149+.`,
      'Copy URL': () => void copy(pi, inspectUrl),
      OK: () => {},
    })

  // First `//`: offer the chrome-devtools MCP (its --config file has to exist first).
  const offerMcp = async () => {
    const marker = join(pi.tui.state.init?.dataDir ?? join(home, 'claude', '-p'), 'f12-mcp-offered')
    if (existsSync(marker)) return
    await writeFile(marker, '')
    await ensureConfig()
    if (await installed()) return
    pi.dialog({
      title: 'Let Claude use this Chrome?',
      body: `Install the chrome-devtools MCP (once, in a shell):\n\n${mcpInstall}\n\nSites you pick with // are added to ~/.F12-mcp.json.`,
      Copy: () => void copy(pi, mcpInstall.replace('\\\n  ', '')),
      Later: () => {},
    })
  }

  let shown = new Map() // fzf line → tab, from the last `//` Tab
  pi.complete(
    '//',
    async tok => {
      const url = parseToken(tok)
      const b = await open()
      if (url) {
        const onTabs = b?.cdp ? (await cdp.tabs(b.cdp).catch(() => [])).map(t => t.url) : []
        const visited = (await cdp.history(b?.dir)).map(h => h.url)
        return urlItems(url.site, [...onTabs, ...visited])
      }
      if (!b?.cdp) {
        offline()
        return []
      }
      const items = tabItems(await cdp.tabs(b.cdp))
      shown = new Map(items.map(i => [i.label, i.target]))
      return items.map(i => i.label)
    },
    async (item, tok) => {
      if (parseToken(tok)) {
        const p = trustPattern(item)
        if (p) await trust(p)
        return item
      }
      const t = shown.get(item)
      const b = await browser
      if (!t || !b?.cdp) return null
      let png
      try {
        png = await cdp.screenshot(b.cdp, t.targetId)
      } catch (e) {
        pi.dialog({ body: `screenshot failed: ${e.message}`, timeout: 4000 })
        return null
      }
      const file = join(shots, `cld-pi-${bareHost(t.url).replace(/[^\w.-]/g, '_') || 'tab'}-${Date.now()}.png`)
      await writeFile(file, png)
      const p = trustPattern(t.url)
      if (p) await trust(p)
      offerMcp().catch(() => {})
      return `@${file}`
    },
  )
}

export default f12()
