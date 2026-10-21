// /m: open the magpie panel; offer the install command when it's missing.
const install = 'curl -fsSL https://usemagpie.ai/install.sh | sh'

export default pi => {
  pi.command('m', async () => {
    const bin = `${process.env.HOME}/.local/bin/magpie`
    if ((await pi.sh`test -x ${bin}`).code === 0) return pi.sh`${bin} panel >/dev/null 2>&1 &`
    await pi.dialog({
      title: 'magpie is not installed',
      body: `OK copies the installer:\n${install}`,
      OK: () => pi.sh`printf %s ${install} | (wl-copy || xclip -selection clipboard || pbcopy) 2>/dev/null`.then(() => {}),
    })
  })
}
