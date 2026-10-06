import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Braces, Brain, FileText, FolderOpen, RefreshCw, Save, Plus } from 'lucide-react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { useStore } from '../../store';
import { askConfirm } from '../../lib/dialog';
import { basename } from '../../lib/format';
import { t } from '../../i18n';
import './instructions.css';

export interface InstrDoc {
  id: string;
  group: 'global' | 'project' | 'memory';
  label: string;
  path: string;
  exists: boolean;
  kind: 'md' | 'json';
  size: number;
}

export interface InstrHook {
  source: 'user' | 'project' | 'local';
  file: string;
  event: string;
  matcher: string;
  commands: string[];
  error?: string;
}

const GROUPS: InstrDoc['group'][] = ['global', 'project', 'memory'];
const sourceLabel = (source: string) => (['user', 'project', 'local'].includes(source) ? t(`instructions.source.${source}`) : source);
const JSON_TEMPLATE = '{\n  \n}\n';

// ipcRenderer.invoke wraps errors as "Error invoking remote method 'x': Error: ..."
const errText = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

function jsonError(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const m = /position (\d+)/.exec(msg);
    const pos = m ? Number(m[1]) : text.length;
    const line = text.slice(0, pos).split('\n').length;
    const clean = msg.replace(/\s*\(line \d+ column \d+\)/, '').replace(/\s*in JSON at position \d+/, '');
    return t('instructions.invalidJson', { error: clean, line });
  }
}

const sizeLabel = (n: number) => (n < 1024 ? t('instructions.size.bytes', { n }) : t('instructions.size.kb', { n: (n / 1024).toFixed(n < 10240 ? 1 : 0) }));

function DocIcon({ doc }: { doc: InstrDoc }) {
  if (doc.group === 'memory') return <Brain size={13} />;
  return doc.kind === 'json' ? <Braces size={13} /> : <FileText size={13} />;
}

export function InstructionsSection() {
  const cwd = useStore((s) => s.threads[s.activeId]?.cwd || '');
  const dark = useStore((s) => s.resolvedTheme === 'dark');
  const toast = useStore((s) => s.toast);
  const [docs, setDocs] = useState<InstrDoc[] | null>(null);
  const [sel, setSel] = useState<InstrDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [hooks, setHooks] = useState<InstrHook[]>([]);
  const [saving, setSaving] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const savedRef = useRef('');
  const selRef = useRef<InstrDoc | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const loadToken = useRef(0);
  const validateTimer = useRef<number | undefined>(undefined);
  selRef.current = sel;

  const loadHooks = useCallback(() => {
    window.desk
      .call<InstrHook[]>('instr:hooksSummary', cwd || null)
      .then(setHooks)
      .catch(() => setHooks([]));
  }, [cwd]);

  const makeState = useCallback(
    (doc: InstrDoc, text: string) =>
      EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          doc.kind === 'json' ? json() : [markdown(), EditorView.lineWrapping],
          themeComp.current.of(dark ? oneDark : []),
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (saveRef.current(), true) }]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const text = u.state.doc.toString();
            setDirty(text !== savedRef.current);
            if (doc.kind !== 'json') return;
            window.clearTimeout(validateTimer.current);
            validateTimer.current = window.setTimeout(() => setJsonErr(jsonError(text)), 250);
          }),
        ],
      }),
    // Theme changes are applied through the compartment, not by rebuilding state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const open = useCallback(
    async (doc: InstrDoc) => {
      const token = ++loadToken.current;
      setSel(doc);
      setDirty(false);
      setJsonErr(null);
      setLoadErr(null);
      try {
        const r = await window.desk.call<{ text: string; exists: boolean }>('instr:read', doc.path);
        if (token !== loadToken.current) return;
        const text = r.exists ? r.text : doc.kind === 'json' ? JSON_TEMPLATE : '';
        savedRef.current = text;
        viewRef.current?.setState(makeState(doc, text));
        if (doc.kind === 'json' && r.exists && text.trim()) setJsonErr(jsonError(text));
        if (r.exists !== doc.exists) setSel({ ...doc, exists: r.exists });
      } catch (e) {
        if (token !== loadToken.current) return;
        setLoadErr(errText(e));
      }
    },
    [makeState],
  );

  const loadList = useCallback(async () => {
    try {
      const list = await window.desk.call<InstrDoc[]>('instr:list', cwd || null);
      setDocs(list);
      return list;
    } catch (e) {
      toast(t('instructions.listFailed', { error: errText(e) }), 'error');
      setDocs([]);
      return [];
    }
  }, [cwd, toast]);

  // Reload the list when the active project changes; keep the current file if it is still listed.
  useEffect(() => {
    loadList().then((list) => {
      const cur = selRef.current;
      const keep = cur && list.find((d) => d.path === cur.path);
      if (keep) setSel(keep);
      else if (list[0]) open(list[0]);
    });
    loadHooks();
  }, [loadList, loadHooks, open]);

  useEffect(() => {
    if (!hostRef.current) return;
    viewRef.current = new EditorView({ parent: hostRef.current });
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
      window.clearTimeout(validateTimer.current);
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(dark ? oneDark : []) });
  }, [dark]);

  const select = async (doc: InstrDoc) => {
    if (doc.path === sel?.path) return;
    if (
      dirty &&
      !(await askConfirm({
        title: t('instructions.leave.title'),
        message: t('instructions.leave.message', { name: sel ? basename(sel.path) : '' }),
        confirmLabel: t('instructions.leave.confirm'),
        danger: true,
      }))
    )
      return;
    open(doc);
  };

  const save = async () => {
    const doc = selRef.current;
    const view = viewRef.current;
    if (!doc || !view || saving || loadErr) return;
    const text = view.state.doc.toString();
    if (doc.kind === 'json') {
      const err = jsonError(text);
      setJsonErr(err);
      if (err) return;
    }
    setSaving(true);
    try {
      await window.desk.call('instr:write', doc.path, text);
      if (selRef.current?.path !== doc.path) return;
      savedRef.current = text;
      setDirty(view.state.doc.toString() !== text);
      toast(t(doc.exists ? 'instructions.saved' : 'instructions.created'));
      const list = await loadList();
      const fresh = list.find((d) => d.path === doc.path);
      if (fresh && selRef.current?.path === doc.path) setSel(fresh);
      if (doc.kind === 'json') loadHooks();
    } catch (e) {
      const bad = doc.kind === 'json' ? jsonError(text) : null;
      if (bad) setJsonErr(bad);
      else toast(t('instructions.saveFailed', { error: errText(e) }), 'error');
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;

  const refresh = async () => {
    if (dirty && !(await askConfirm({ title: t('instructions.reload.title'), message: t('instructions.reload.message'), confirmLabel: t('instructions.reload.confirm'), danger: true }))) return;
    const list = await loadList();
    const cur = selRef.current && list.find((d) => d.path === selRef.current!.path);
    if (cur) open(cur);
    else if (list[0]) open(list[0]);
    loadHooks();
  };

  // Show paths under the user profile as "~\...".
  const home = useMemo(() => {
    const g = docs?.find((d) => d.group === 'global');
    return g ? g.path.replace(/[\\/]\.claude[\\/][^\\/]+$/, '') : '';
  }, [docs]);
  const shownPath = (p: string) => (home && p.toLowerCase().startsWith(home.toLowerCase()) ? '~' + p.slice(home.length) : p);

  const grouped = useMemo(() => GROUPS.map((g) => ({ group: g, items: (docs ?? []).filter((d) => d.group === g) })), [docs]);
  const isSettings = sel?.kind === 'json';

  return (
    <div className="instr">
      <div className="set-head-row">
        <h2>{t('instructions.title')}</h2>
        <button className="icon-btn" title={t('instructions.reload')} onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>
      <p className="muted small">
        {t('instructions.intro')}
        {!cwd && ' ' + t('instructions.intro.noProject')}
      </p>

      <div className="instr-layout">
        <div className="instr-list">
          {!docs && <div className="muted small instr-empty">{t('common.loading')}</div>}
          {docs &&
            grouped.map(({ group, items }) => {
              if (!items.length && (group !== 'memory' || !cwd)) return null;
              return (
                <div key={group} className="instr-group">
                  <div className="instr-group-title">{t(`instructions.group.${group}`)}</div>
                  {!items.length && <div className="muted small instr-empty">{t('instructions.empty')}</div>}
                  {items.map((d) => (
                    <button
                      key={d.id}
                      className={`instr-item ${sel?.path === d.path ? 'is-active' : ''} ${d.exists ? '' : 'is-missing'}`}
                      title={d.path}
                      onClick={() => select(d)}
                    >
                      <DocIcon doc={d} />
                      <span className="instr-item-text">
                        <span className="truncate">{d.label}</span>
                        <span className="instr-item-meta">{d.exists ? sizeLabel(d.size) : t('instructions.notCreated')}</span>
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
        </div>

        <div className="instr-main">
          <div className="instr-toolbar">
            <span className="instr-path truncate" title={sel?.path}>
              {sel ? shownPath(sel.path) : ''}
            </span>
            {dirty && <span className="instr-dirty" title={t('instructions.unsaved')} />}
            <span className="spacer" />
            <button className="icon-btn sm" title={t(sel?.exists ? 'instructions.showInFolder' : 'instructions.notCreatedYet')} disabled={!sel?.exists} onClick={() => sel && window.desk.showInFolder(sel.path)}>
              <FolderOpen size={13} />
            </button>
            <button className="pill sm" disabled={!sel || saving || !!loadErr || (sel.exists && !dirty)} onClick={save} title="Ctrl+S">
              {sel && !sel.exists ? <Plus size={12} /> : <Save size={12} />}
              {t(sel && !sel.exists ? 'common.create' : 'common.save')}
            </button>
          </div>
          <div ref={hostRef} className="cm-host instr-editor" style={{ display: loadErr ? 'none' : 'block' }} />
          {loadErr && <div className="instr-editor instr-load-err muted small">{loadErr}</div>}
          {jsonErr && <div className="instr-error small">{jsonErr}</div>}
        </div>
      </div>

      {isSettings && (
        <div className="instr-hooks">
          <h3>{t('instructions.hooks.title')}</h3>
          <p className="muted small">
            {t('instructions.hooks.intro1')} <code>Bash</code> {t('instructions.hooks.or')} <code>Edit|Write</code>
            {t('instructions.hooks.intro2')} <code>"hooks"</code> {t('instructions.hooks.intro3')}
          </p>
          {hooks.length === 0 ? (
            <div className="muted small">{t('instructions.hooks.none')}</div>
          ) : (
            <div className="instr-hook-list">
              {hooks.map((h, i) => (
                <div key={i} className={`instr-hook ${sel && h.file.toLowerCase() === sel.path.toLowerCase() ? 'is-current' : ''}`} title={h.file}>
                  <span className="chip">{sourceLabel(h.source)}</span>
                  {h.error ? (
                    <span className="instr-error small">{h.error}</span>
                  ) : (
                    <>
                      <span className="instr-hook-event">{h.event}</span>
                      <span className="muted">·</span>
                      <span className="muted small">{h.matcher || t('instructions.hooks.all')}</span>
                      <span className="muted">·</span>
                      <span className="instr-hook-cmd truncate" title={h.commands.join('\n')}>
                        {h.commands.join(' ; ') || '—'}
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
