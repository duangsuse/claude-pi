// img: click a screen row that names a .png / .webp file and look at it.
// pi.click gives the row the click landed on (rows above CC's input box);
// the file opens in imv, or xdg-open's image viewer where imv is missing.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Path-like tokens on one grid row that end in .png / .webp. */
export function imagePaths(row) {
  const out = []
  const re = /(?:^|[\s"'`(\[@])((?:~|\.{1,2})?[^\s"'`()\[\]<>|]*\.(?:png|webp))(?=$|[\s"'`)\].,;:])/gi
  for (const m of String(row ?? '').matchAll(re)) {
    const tok = m[1].replace(/^@/, '') // f12 types `@/tmp/shot.png`
    if (tok && !out.includes(tok)) out.push(tok)
  }
  return out
}

/** `~` and relative paths → the path the sidecar can open. */
export const imagePath = (tok, cwd = process.cwd()) => {
  if (tok === '~' || tok.startsWith('~/')) return join(homedir(), tok.slice(1))
  return isAbsolute(tok) ? tok : resolve(cwd, tok)
}

export default pi => {
  pi.click(row => {
    const line = pi.tui.state.scr?.rows?.[row]
    for (const tok of imagePaths(line)) {
      const file = imagePath(tok)
      if (!existsSync(file)) continue
      pi.sh`if command -v imv >/dev/null 2>&1; then imv ${file} >/dev/null 2>&1; else xdg-open ${file} >/dev/null 2>&1; fi &`
      return
    }
  })
}
