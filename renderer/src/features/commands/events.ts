// Hook point for "custom commands/skills changed on disk" so the slash-command list can be refreshed.
import { useStore } from '../../store';
import type { SlashCommand } from '../../types';

export interface CommandsChange {
  op: 'write' | 'delete' | 'rename';
  path: string;
  cwd?: string;
}

type Listener = (e: CommandsChange) => void;
const listeners = new Set<Listener>();

/** Subscribe to changes made from the commands editor. Returns an unsubscribe function. */
export function onCommandsChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function notifyCommandsChanged(e: CommandsChange) {
  for (const cb of [...listeners]) {
    try {
      cb(e);
    } catch (err) {
      console.error('[commands] listener failed', err);
    }
  }
}

interface CmdItem {
  scope: 'user' | 'project';
  name: string;
  description: string;
  argumentHint: string;
}

let timer: number | undefined;

/**
 * Re-reads the slash-command list: forces a fresh probe (user-scope commands/skills, plugins, built-ins) and
 * adds project-scope commands of `cwd` that the probe cannot see (it runs in the home folder).
 * Debounced; safe to call often.
 */
export function reprobeCommands(cwd?: string, delay = 600): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(async () => {
    try {
      const [probe, local] = await Promise.all([
        window.desk.probe(true).catch(() => null),
        window.desk.call<CmdItem[]>('cmd:list', cwd || null).catch(() => [] as CmdItem[]),
      ]);
      const base: SlashCommand[] = probe?.commands ?? useStore.getState().commands;
      const seen = new Set(base.map((c) => c.name));
      const extra = local
        .filter((c) => !seen.has(c.name))
        .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint || undefined }));
      useStore.setState({ commands: [...base, ...extra] });
    } catch (err) {
      console.error('[commands] re-probe failed', err);
    }
  }, delay);
}
