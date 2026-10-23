import fs from 'node:fs';
import path from 'node:path';

/** Small local failure log. No chat snapshots or tool output. */
export function createDiagnostics(file) {
  return (kind, details = {}) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
        fs.rmSync(file + '.previous', { force: true });
        fs.renameSync(file, file + '.previous');
      }
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind, ...details }) + '\n');
    } catch { /* Diagnostics must never take down the app. */ }
  };
}
