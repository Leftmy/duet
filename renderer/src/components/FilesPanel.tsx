import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, File, Folder, FolderOpen, PanelLeftClose, PanelLeftOpen, RotateCw, Save, X } from 'lucide-react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { go } from '@codemirror/lang-go';
import { rust } from '@codemirror/lang-rust';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import type { Thread } from '../types';
import { useStore } from '../store';
import { basename } from '../lib/format';
import { collapse } from './ToolRow';
import { askConfirm } from '../lib/dialog';
import { t } from '../i18n';

function languageFor(path: string): Extension {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return javascript({ jsx: true });
  if (['ts', 'mts', 'cts'].includes(ext)) return javascript({ typescript: true });
  if (ext === 'tsx') return javascript({ typescript: true, jsx: true });
  if (['json', 'jsonc'].includes(ext)) return json();
  if (['css', 'scss', 'less'].includes(ext)) return css();
  if (['html', 'htm', 'vue', 'svelte'].includes(ext)) return html();
  if (['md', 'mdx', 'markdown'].includes(ext)) return markdown();
  if (ext === 'py') return python();
  if (ext === 'go') return go();
  if (ext === 'rs') return rust();
  if (['java', 'kt', 'kts', 'scala'].includes(ext)) return java();
  if (['c', 'h', 'cpp', 'hpp', 'cc', 'cs'].includes(ext)) return cpp();
  if (ext === 'sql') return sql();
  if (['xml', 'svg', 'csproj', 'xaml'].includes(ext)) return xml();
  if (['yml', 'yaml'].includes(ext)) return yaml();
  return [];
}

interface FileBuf {
  state: EditorState;
  saved: string;
  dirty: boolean;
  stale: boolean;
  error?: string;
}

// Editor states live outside React so switching tabs keeps undo history and cursor.
const buffers = new Map<string, FileBuf>();

const TreeNode = memo(function TreeNode({ path, name, dir, dim, depth }: { path: string; name: string; dir: boolean; dim: boolean; depth: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<{ name: string; path: string; dir: boolean; dim: boolean }[] | null>(null);
  const openFile = useStore((s) => s.openFile);
  const active = useStore((s) => s.editorActive === path);
  const toggle = async () => {
    if (!dir) return openFile(path);
    if (!children) setChildren(await window.desk.filesList(path).catch(() => []));
    setOpen((v) => !v);
  };
  return (
    <>
      <button className={`tree-row ${active ? 'is-active' : ''} ${dim ? 'is-dim' : ''}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={toggle} title={path}>
        {dir ? <ChevronRight size={12} className={`tree-chevron ${open ? 'is-open' : ''}`} /> : <span className="tree-spacer" />}
        {dir ? open ? <FolderOpen size={13} /> : <Folder size={13} /> : <File size={13} />}
        <span className="truncate">{name}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && children && (
          <motion.div {...collapse} style={{ overflow: 'hidden' }}>
            {children.map((c) => (
              <TreeNode key={c.path} {...c} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
});

export function FilesPanel({ thread }: { thread: Thread }) {
  const files = useStore((s) => s.editorFiles);
  const active = useStore((s) => s.editorActive);
  const openFile = useStore((s) => s.openFile);
  const closeFile = useStore((s) => s.closeFile);
  const dark = useStore((s) => s.resolvedTheme === 'dark');
  const toast = useStore((s) => s.toast);
  const [tree, setTree] = useState(true);
  const [roots, setRoots] = useState<{ name: string; path: string; dir: boolean; dim: boolean }[]>([]);
  const [, force] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const rerender = () => force((n) => n + 1);

  useEffect(() => {
    if (thread.cwd) window.desk.filesList(thread.cwd).then(setRoots).catch(() => setRoots([]));
  }, [thread.cwd]);

  const save = useCallback(async () => {
    const path = useStore.getState().editorActive;
    const buf = path && buffers.get(path);
    if (!path || !buf) return true;
    const text = buf.state.doc.toString();
    try {
      await window.desk.filesWrite(path, text);
      buf.saved = text;
      buf.dirty = false;
      buf.stale = false;
      rerender();
      return true;
    } catch (e: any) {
      toast(t('files.saveFailed', { error: String(e?.message ?? e) }), 'error');
      return false;
    }
  }, [toast]);

  const makeState = useCallback(
    (path: string, text: string) =>
      EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          languageFor(path),
          themeComp.current.of(dark ? oneDark : []),
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (save(), true) }]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const buf = buffers.get(path);
            if (!buf) return;
            buf.state = u.state;
            const dirty = u.state.doc.toString() !== buf.saved;
            if (dirty !== buf.dirty) {
              buf.dirty = dirty;
              rerender();
            }
          }),
        ],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dark, save],
  );

  const load = useCallback(
    async (path: string) => {
      try {
        const r = await window.desk.filesRead(path);
        if (r.binary || r.tooLarge) {
          buffers.set(path, { state: EditorState.create({ doc: '' }), saved: '', dirty: false, stale: false, error: r.binary ? t('files.binary') : t('files.tooLarge') });
        } else {
          buffers.set(path, { state: makeState(path, r.text ?? ''), saved: r.text ?? '', dirty: false, stale: false });
        }
        window.desk.filesWatch(path);
      } catch (e: any) {
        buffers.set(path, { state: EditorState.create({ doc: '' }), saved: '', dirty: false, stale: false, error: String(e?.message ?? e) });
      }
      rerender();
    },
    [makeState],
  );

  // Load newly opened files.
  useEffect(() => {
    for (const f of files) if (!buffers.has(f)) load(f);
    for (const f of [...buffers.keys()])
      if (!files.includes(f)) {
        buffers.delete(f);
        window.desk.filesUnwatch(f);
      }
  }, [files, load]);

  // Reload files changed on disk (e.g. by Claude); keep unsaved edits and flag them instead.
  useEffect(
    () =>
      window.desk.onFileChanged(async ({ path }) => {
        const buf = buffers.get(path);
        if (!buf) return;
        const r = await window.desk.filesRead(path).catch(() => null);
        if (!r || r.text == null || r.text === buf.saved) return;
        if (buf.dirty) {
          buf.stale = true;
          rerender();
          return;
        }
        buffers.set(path, { state: makeState(path, r.text), saved: r.text, dirty: false, stale: false });
        rerender();
      }),
    [makeState],
  );

  // Mount the active buffer into the editor view.
  const activeBuf = active ? buffers.get(active) : undefined;
  useEffect(() => {
    if (!hostRef.current) return;
    if (!viewRef.current) viewRef.current = new EditorView({ parent: hostRef.current });
    if (activeBuf && !activeBuf.error && viewRef.current.state !== activeBuf.state) viewRef.current.setState(activeBuf.state);
  }, [activeBuf, activeBuf?.state]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(dark ? oneDark : []) });
  }, [dark]);

  useEffect(() => () => viewRef.current?.destroy(), []);

  const close = async (path: string) => {
    const buf = buffers.get(path);
    if (
      buf?.dirty &&
      !(await askConfirm({
        title: t('files.closeUnsavedTitle'),
        message: t('files.closeUnsavedMessage', { name: basename(path) }),
        confirmLabel: t('common.close'),
        danger: true,
      }))
    )
      return;
    closeFile(path);
  };

  const reloadFromDisk = async () => {
    if (!active) return;
    buffers.delete(active);
    await load(active);
  };

  return (
    <div className="files">
      <div className="files-tabs">
        <button className="icon-btn sm" title={tree ? t('files.hideTree') : t('files.showTree')} onClick={() => setTree((v) => !v)}>
          {tree ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
        </button>
        <div className="files-tabs-scroll">
          {files.map((f) => {
            const b = buffers.get(f);
            return (
              <div key={f} className={`ftab ${f === active ? 'is-on' : ''}`} onClick={() => openFile(f)} title={f}>
                <span className="truncate">{basename(f)}</span>
                {b?.dirty ? (
                  <span className="ftab-dot" />
                ) : (
                  <button
                    className="ftab-x"
                    onClick={(e) => {
                      e.stopPropagation();
                      close(f);
                    }}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {activeBuf?.dirty && (
          <button className="pill sm" onClick={save} title={t('files.saveHint')}>
            <Save size={12} /> {t('common.save')}
          </button>
        )}
      </div>
      {activeBuf?.stale && (
        <div className="files-banner">
          {t('files.staleBanner')}
          <button className="pill sm" onClick={reloadFromDisk}>
            <RotateCw size={12} /> {t('files.reloadFromDisk')}
          </button>
        </div>
      )}
      <div className="files-body">
        {tree && (
          <div className="files-tree">
            {roots.map((r) => (
              <TreeNode key={r.path} {...r} depth={0} />
            ))}
            {!thread.cwd && <div className="muted small" style={{ padding: 10 }}>{t('files.noProject')}</div>}
          </div>
        )}
        <div className="files-editor">
          <div ref={hostRef} className="cm-host" style={{ display: activeBuf && !activeBuf.error ? 'block' : 'none' }} />
          {!active && <div className="changes-empty muted">{t('files.empty')}</div>}
          {activeBuf?.error && <div className="changes-empty muted">{activeBuf.error}</div>}
        </div>
      </div>
    </div>
  );
}
