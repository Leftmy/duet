// Minimal CDP driver for testing the app: node scripts/cdp.mjs shot <out.png> | eval "<js>"
const port = process.env.CDP_PORT || 9333;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pages = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
const page = pages.find((t) => /index\.html|127\.0\.0\.1:5199/.test(t.url)) ?? pages[0];
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'shot') {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(arg, Buffer.from(res.result.data, 'base64'));
  console.log('saved', arg);
} else if (cmd === 'evalfile') {
  const fs = await import('node:fs');
  const res = await send('Runtime.evaluate', { expression: fs.readFileSync(arg, 'utf8'), awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 1));
} else if (cmd === 'eval') {
  const res = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 1));
}
ws.close();
process.exit(0);
