#!/usr/bin/env node
// Evaluate a JS expression in a running claude-p sidecar over CDP, the way
// you would in the F12 console. Port defaults to 9224 (agent tests); a real
// session listens on 9229.
//
//   node scripts/cdp-eval.mjs "pi.BUFFER = 'hi'"
//   CDP_PORT=9229 node scripts/cdp-eval.mjs 'pi`/help`'
const port = process.env.CDP_PORT ?? '9224'
const expr = process.argv[2]
if (!expr) {
  console.error('usage: cdp-eval.mjs <expression>')
  process.exit(2)
}
const [target] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
const { result } = await new Promise(resolve =>
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.id === 1) resolve(m)
  }),
)
ws.close()
if (result.exceptionDetails) {
  console.error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  process.exit(1)
}
console.log(JSON.stringify(result.result.value ?? result.result.description ?? result.result.type))
