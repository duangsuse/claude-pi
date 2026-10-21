// Tab titles for terminals that name tabs themselves (pi.tui.title):
// Yakuake, Konsole and Guake over D-Bus. Others use the window title (OSC 2).
import { execFile } from 'node:child_process'

const run = (cmd, args) =>
  new Promise(resolve => execFile(cmd, args, { timeout: 2000 }, (err, out) => resolve(err ? null : String(out).trim())))

const gdbus = (dest, path, method, ...args) =>
  run('gdbus', ['call', '--session', '--dest', dest, '--object-path', path, '--method', method, ...args])

// gdbus prints GVariant tuples: ('text',) or (3,)
const unwrap = r => r?.match(/^\((?:'((?:[^'\\]|\\.)*)'|(-?\d+)),?\)$/s)?.slice(1).find(x => x != null)
const gstr = s => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

async function qdbusBin() {
  for (const b of ['qdbus6', 'qdbus']) if ((await run(b, ['--version'])) != null) return b
  return null
}

// Yakuake: Konsole session /Sessions/N is Yakuake terminal N-1 (Konsole
// counts sessions from 1, Yakuake terminals from 0, one each per terminal).
async function yakuake(env, q) {
  const owner = unwrap(await gdbus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.GetNameOwner', 'org.kde.yakuake'))
  if (!owner || owner !== env.KONSOLE_DBUS_SERVICE) return null
  const n = Number(env.KONSOLE_DBUS_SESSION?.split('/').pop())
  if (!n) return null
  const id = await run(q, ['org.kde.yakuake', '/yakuake/sessions', 'org.kde.yakuake.sessionIdForTerminalId', String(n - 1)])
  if (id == null || Number(id) < 0) return null
  return {
    get: () => run(q, ['org.kde.yakuake', '/yakuake/tabs', 'org.kde.yakuake.tabTitle', id]),
    set: t => run(q, ['org.kde.yakuake', '/yakuake/tabs', 'org.kde.yakuake.setTabTitle', id, t]),
  }
}

// Konsole: the tab shows the session's displayed title (role 1).
function konsole(env, q) {
  const call = (...a) => run(q, [env.KONSOLE_DBUS_SERVICE, env.KONSOLE_DBUS_SESSION, ...a])
  return {
    get: () => call('org.kde.konsole.Session.title', '1'),
    set: t => call('org.kde.konsole.Session.setTitle', '1', t),
  }
}

// Guake: every tab's shell has GUAKE_TAB_UUID.
function guake(env) {
  const call = (m, ...a) => gdbus('org.guake3.RemoteControl', '/org/guake3/RemoteControl', `org.guake3.RemoteControl.${m}`, ...a)
  const uuid = gstr(env.GUAKE_TAB_UUID)
  return {
    get: async () => {
      const i = unwrap(await call('get_index_from_uuid', uuid))
      return i == null ? null : unwrap(await call('get_tab_name', i))
    },
    set: t => call('rename_tab_uuid', uuid, gstr(t)),
  }
}

/** The tab-title backend for this terminal ({ get, set }), or null. */
export async function pickTab(env = process.env) {
  if (env.GUAKE_TAB_UUID) return guake(env)
  if (env.KONSOLE_DBUS_SERVICE && env.KONSOLE_DBUS_SESSION) {
    const q = await qdbusBin()
    if (q) return (await yakuake(env, q)) ?? konsole(env, q)
  }
  return null
}
