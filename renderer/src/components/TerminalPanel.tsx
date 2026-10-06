import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { MessageSquarePlus, Plus, SquareTerminal, X } from 'lucide-react';
import type { Thread } from '../types';
import { useStore } from '../store';
import { basename, uid } from '../lib/format';
import { t } from '../i18n';

interface TermInfo {
  id: string;
  cwd: string;
  title: string;
  exited?: number;
}

// Terminals outlive the panel: output is buffered here and replayed when the tab is shown again.
const terms: TermInfo[] = [];
const buffers = new Map<string, string>();
let wired = false;
let activeId: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function wire() {
  if (wired) return;
  wired = true;
  window.desk.onTermData(({ id, data }) => {
    const prev = buffers.get(id) ?? '';
    buffers.set(id, (prev + data).slice(-400_000));
    sinks.get(id)?.(data);
  });
  window.desk.onTermExit(({ id, exitCode }) => {
    const tab = terms.find((x) => x.id === id);
    if (tab) tab.exited = exitCode;
    sinks.get(id)?.(`\r\n\x1b[90m[${t('terminal.exited', { code: exitCode })}]\x1b[0m\r\n`);
    notify();
  });
}
const sinks = new Map<string, (data: string) => void>();

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g, '');

export function TerminalPanel({ thread }: { thread: Thread }) {
  const [, force] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const insert = useStore((s) => s.insertToComposer);
  const dark = useStore((s) => s.resolvedTheme === 'dark');

  useEffect(() => {
    wire();
    const l = () => force((n) => n + 1);
    listeners.add(l);
    if (!terms.length) create();
    return () => {
      listeners.delete(l);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function create() {
    const id = 't-' + uid();
    const cwd = thread.cwd || '';
    terms.push({ id, cwd, title: cwd ? basename(cwd) : '' });
    activeId = id;
    window.desk.termCreate({ id, cwd, cols: 100, rows: 30 }).catch(() => {});
    notify();
  }

  function kill(id: string) {
    window.desk.termKill(id);
    const i = terms.findIndex((x) => x.id === id);
    if (i >= 0) terms.splice(i, 1);
    buffers.delete(id);
    if (activeId === id) activeId = terms[terms.length - 1]?.id ?? null;
    notify();
  }

  // Mount an xterm for the active terminal and replay its buffer.
  useLayoutEffect(() => {
    const el = hostRef.current;
    const id = activeId;
    if (!el || !id) return;
    el.innerHTML = '';
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: {
        background: cssVar('--code-bg'),
        foreground: cssVar('--text'),
        cursor: cssVar('--text'),
        selectionBackground: 'rgba(77,142,247,0.35)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.write(buffers.get(id) ?? '');
    sinks.set(id, (d) => term.write(d));
    const sub = term.onData((d) => window.desk.termWrite(id, d));
    const doFit = () => {
      try {
        fit.fit();
        window.desk.termResize(id, term.cols, term.rows);
      } catch {}
    };
    requestAnimationFrame(doFit);
    const ro = new ResizeObserver(() => requestAnimationFrame(doFit));
    ro.observe(el);
    term.focus();
    (el as any).__term = term;
    return () => {
      ro.disconnect();
      sub.dispose();
      sinks.delete(id);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, dark, terms.length]);

  const sendToChat = () => {
    const term: Terminal | undefined = (hostRef.current as any)?.__term;
    const sel = term?.getSelection();
    let text = sel?.trim() ? sel : '';
    if (!text && term) {
      // Read the rendered screen (ConPTY positions the cursor instead of emitting newlines).
      const buf = term.buffer.active;
      const end = buf.baseY + buf.cursorY;
      const lines: string[] = [];
      for (let y = Math.max(0, end - 60); y <= end; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      text = lines.join('\n').trim();
    }
    if (!text) text = stripAnsi(buffers.get(activeId ?? '') ?? '').split('\n').slice(-60).join('\n').trim();
    if (!text) return;
    insert(`${t('terminal.outputHeader')}\n\`\`\`\n${text}\n\`\`\`\n`);
  };

  return (
    <div className="term">
      <div className="files-tabs">
        <div className="files-tabs-scroll">
          {terms.map((tab) => (
            <div
              key={tab.id}
              className={`ftab ${tab.id === activeId ? 'is-on' : ''}`}
              onClick={() => {
                activeId = tab.id;
                notify();
              }}
              title={tab.cwd}
            >
              <SquareTerminal size={12} />
              <span className="truncate">{tab.title || t('terminal.title')}</span>
              {tab.exited != null && <span className="muted small">·{tab.exited}</span>}
              <button
                className="ftab-x"
                onClick={(e) => {
                  e.stopPropagation();
                  kill(tab.id);
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <button className="icon-btn sm" title={t('terminal.newTerminal')} onClick={create}>
          <Plus size={14} />
        </button>
        <button className="pill sm" title={t('terminal.toChatHint')} onClick={sendToChat}>
          <MessageSquarePlus size={12} /> {t('terminal.toChat')}
        </button>
      </div>
      <div className="term-host" ref={hostRef} />
      {!terms.length && (
        <div className="changes-empty muted">
          <button className="pill" onClick={create}>
            <Plus size={13} /> {t('terminal.openTerminal')}
          </button>
        </div>
      )}
    </div>
  );
}
