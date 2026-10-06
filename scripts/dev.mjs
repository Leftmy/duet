// Dev runner: starts the Vite dev server, then launches Electron pointed at it.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.mjs', import.meta.url)) });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[dev] renderer at ${url}`);

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, CLAUDE_UI_DEV_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
