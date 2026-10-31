import { format } from 'node:util';
// stdout is exclusively the framed RPC transport; CLI/library logs go to stderr.
console.log = (...args) => process.stderr.write(format(...args) + '\n');
console.info = console.log;
process.env.DUET_DESKTOP_RUNTIME = 'native';
await import('../electron/main.mjs');
const { ready, shutdown } = await import('./runtime.mjs');
ready();
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
