// pi.command names must also show up in CC's `/` autocomplete. CC discovers
// command files in the project / user `.claude/commands` dirs (which we must
// not write to) or in a plugin passed with `--plugin-dir`. Plugin commands
// are namespaced (`cldp-pi:ad`), but a frontmatter `name:` registers the bare
// name as an alias, so typing `/ad` matches `cldp-pi:ad (ad)` in the menu.
// The plugin dir lives in claude-p's per-run temp dir and is filled before
// claude starts (src/pi/main.zig waits for host.js's `ready`). The wrapper
// intercepts the line, so a stub body never runs.
import { mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A plugin command stub: bare alias, with a description CC shows as empty. */
export const stub = name => `---\nname: ${name}\ndescription: "​"\n---\n`

/**
 * Sync CC command stubs to `names` in the plugin dir `dir`. Returns a
 * function; `.cleanup()` removes every file it made. Without a dir (no
 * sidecar plugin), it does nothing.
 */
export function commandStubs(dir, log = () => {}) {
  const ours = new Map() // name -> path
  if (!dir) {
    const noop = () => {}
    noop.cleanup = () => {}
    return noop
  }
  const commands = join(dir, 'commands')
  const want = names => {
    const keep = new Set(names.filter(n => /^[A-Za-z0-9_-]{1,64}$/.test(n)))
    for (const [name, path] of ours) {
      if (keep.has(name)) continue
      try {
        rmSync(path)
      } catch {}
      ours.delete(name)
    }
    for (const name of keep) {
      if (ours.has(name)) continue
      const path = join(commands, name + '.md')
      let old = null
      try {
        old = readFileSync(path, 'utf8')
      } catch {}
      if (old != null && old !== stub(name)) continue // someone else's file
      try {
        mkdirSync(commands, { recursive: true })
        if (old == null) writeFileSync(path, stub(name))
        ours.set(name, path)
      } catch (e) {
        log('command stub', name, e)
      }
    }
    // Once every stub is gone, take the (now empty) dir with it.
    if (!ours.size) {
      try {
        rmdirSync(commands) // only succeeds while empty
      } catch {}
    }
  }
  want.cleanup = () => {
    for (const path of ours.values()) {
      try {
        rmSync(path)
      } catch {}
    }
    ours.clear()
    try {
      rmdirSync(commands) // never take anyone else's files with it
    } catch {}
  }
  return want
}
