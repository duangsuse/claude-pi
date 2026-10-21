// /ad <dir>: /add-dir it (answering CC's "Yes, for this session"), then
// show `tree -L 2` of it.
const confirm = 'Yes, for this session'

export default pi => {
  pi.command('ad', async ([dir]) => {
    if (!dir) return pi.dialog({ body: 'usage: /ad <dir>', timeout: 2500 })
    await pi`/add-dir ${dir}`
    if (await pi.tui.wait(confirm, 3000)) {
      await pi.tui.press('enter')
      await pi.tui.wait(s => !s.text.includes(confirm), 3000)
    }
    await pi`!tree -L 2 ${dir}`
  })
}
