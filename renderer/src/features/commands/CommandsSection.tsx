import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FolderOpen, Pencil, Plus, RefreshCw, Save, Sparkles, SquareSlash, Trash2, X } from 'lucide-react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { markdown } from '@codemirror/lang-markdown';
import { useStore, projectName } from '../../store';
import { askConfirm } from '../../lib/dialog';
import { notifyCommandsChanged } from './events';
import { getTemplates, buildFile, nameError, readFront, type CmdKind, type CmdTemplate } from './templates';
import { t } from '../../i18n';
import { AgentTabs } from '../../components/SettingsExtra';
import type { ProviderId } from '../../types';
import '../instructions/instructions.css';
import './commands.css';

export { onCommandsChanged, reprobeCommands } from './events';

export interface CmdItem {
  scope: 'user' | 'project';
  kind: CmdKind;
  name: string;
  path: string;
  description: string;
  argumentHint: string;
}

interface CmdPaths {
  home: string;
  trash: string;
  user: { commands: string; skills: string };
  project?: { commands: string; skills: string };
}

interface NewForm {
  kind: CmdKind;
  scope: 'user' | 'project';
  name: string;
  description: string;
  argumentHint: string;
  allowedTools: string;
  template: string;
}

type Mode = { type: 'edit'; item: CmdItem } | { type: 'new' } | null;

const errText = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
const kindLabel = (kind: CmdKind) => t(`commands.kind.${kind}`);

function blankForm(kind: CmdKind, scope: 'user' | 'project'): NewForm {
  return { kind, scope, name: '', description: '', argumentHint: '', allowedTools: '', template: '' };
}

/** A row exactly like the composer's "/" menu. */
function MenuPreview({ name, description, argumentHint }: { name: string; description: string; argumentHint: string }) {
  return (
    <div className="cmd-preview">
      <div className="cmd-preview-label">{t('commands.preview.label')}</div>
      <div className="cmd-preview-menu">
        <div className="slash-item is-active">
          <span className="slash-name">/{name || t('commands.preview.name')}</span>
          <span className="slash-desc">{description || t('commands.noDescription')}</span>
        </div>
      </div>
      <div className="cmd-preview-usage muted small">
        {t('commands.preview.usage')} <code>/{name || t('commands.preview.name')}{argumentHint ? ` ${argumentHint}` : ''}</code>
      </div>
    </div>
  );
}

export function CommandsSection() {
  const cwd = useStore((s) => s.threads[s.activeId]?.cwd || '');
  // Each agent keeps its own commands and skills (~/.claude vs ~/.codex).
  const [agent, setAgent] = useState<ProviderId>('claude');
  const dark = useStore((s) => s.resolvedTheme === 'dark');
  const toast = useStore((s) => s.toast);
  const [items, setItems] = useState<CmdItem[] | null>(null);
  const [paths, setPaths] = useState<CmdPaths | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [form, setForm] = useState<NewForm>(() => blankForm('command', 'user'));
  const [dirty, setDirty] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [preview, setPreview] = useState({ description: '', argumentHint: '' });

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const savedRef = useRef('');
  const modeRef = useRef<Mode>(null);
  const saveRef = useRef<() => void>(() => {});
  const loadToken = useRef(0);
  const previewTimer = useRef<number | undefined>(undefined);
  modeRef.current = mode;

  const hasProject = !!paths?.project;
  const projLabel = cwd ? t('commands.projectNamed', { name: projectName(cwd) }) : t('commands.project');

  const makeState = useCallback(
    (text: string) =>
      EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          themeComp.current.of(dark ? oneDark : []),
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (saveRef.current(), true) }]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const text = u.state.doc.toString();
            setDirty(text !== savedRef.current);
            window.clearTimeout(previewTimer.current);
            previewTimer.current = window.setTimeout(() => setPreview(readFront(text)), 200);
          }),
        ],
      }),
    // Theme changes go through the compartment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const loadList = useCallback(async () => {
    try {
      const [list, p] = await Promise.all([window.desk.call<CmdItem[]>('cmd:list', cwd || null, agent), window.desk.call<CmdPaths>('cmd:paths', cwd || null, agent)]);
      setItems(list);
      setPaths(p);
      return list;
    } catch (e) {
      toast(t('commands.listFailed', { error: errText(e) }), 'error');
      setItems([]);
      return [];
    }
  }, [cwd, toast, agent]);

  const openItem = useCallback(
    async (item: CmdItem) => {
      const token = ++loadToken.current;
      setMode({ type: 'edit', item });
      setDirty(false);
      setLoadErr(null);
      setRenaming(null);
      setPreview({ description: item.description, argumentHint: item.argumentHint });
      try {
        const r = await window.desk.call<{ text: string }>('cmd:read', item.path, cwd || null, agent);
        if (token !== loadToken.current) return;
        savedRef.current = r.text;
        viewRef.current?.setState(makeState(r.text));
        setPreview(readFront(r.text));
      } catch (e) {
        if (token !== loadToken.current) return;
        setLoadErr(errText(e));
      }
    },
    [cwd, makeState, agent],
  );

  const startNew = useCallback(
    (kind: CmdKind, scope: 'user' | 'project', tpl?: CmdTemplate) => {
      ++loadToken.current;
      const tp = tpl ?? getTemplates().find((x) => x.kind === kind && !x.name)!;
      setMode({ type: 'new' });
      setLoadErr(null);
      setRenaming(null);
      setForm({ kind, scope, name: tp.name, description: tp.description, argumentHint: tp.argumentHint, allowedTools: tp.allowedTools, template: tp.id });
      savedRef.current = tp.body;
      viewRef.current?.setState(makeState(tp.body));
      setPreview(readFront(tp.body));
      setDirty(false);
    },
    [makeState],
  );

  // Reload on project change; keep the open item when it is still listed.
  useEffect(() => {
    loadList().then((list) => {
      const cur = modeRef.current;
      if (cur?.type === 'new') return;
      const keep = cur?.type === 'edit' && list.find((i) => i.path === cur.item.path);
      if (keep) setMode({ type: 'edit', item: keep });
      else if (list[0]) openItem(list[0]);
      else setMode(null);
    });
  }, [loadList, openItem]);

  useEffect(() => {
    if (!hostRef.current) return;
    viewRef.current = new EditorView({ parent: hostRef.current });
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
      window.clearTimeout(previewTimer.current);
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(dark ? oneDark : []) });
  }, [dark]);

  // Project scope disappears when there is no project; fall back to user scope in the form.
  useEffect(() => {
    if (!hasProject && form.scope === 'project') setForm((f) => ({ ...f, scope: 'user' }));
  }, [hasProject, form.scope]);

  const templates = useMemo(getTemplates, []);
  const baseTpl = templates.find((x) => x.id === form.template);
  const formDirty =
    mode?.type === 'new' &&
    (dirty ||
      form.name !== (baseTpl?.name ?? '') ||
      form.description !== (baseTpl?.description ?? '') ||
      form.argumentHint !== (baseTpl?.argumentHint ?? '') ||
      form.allowedTools !== (baseTpl?.allowedTools ?? ''));
  const anyDirty = mode?.type === 'edit' ? dirty : formDirty;

  const guard = async () =>
    !anyDirty ||
    askConfirm({
      title: t('commands.leave.title'),
      message: t(mode?.type === 'new' ? 'commands.leave.newMessage' : 'commands.leave.editMessage'),
      confirmLabel: t('commands.leave.confirm'),
      danger: true,
    });

  const select = async (item: CmdItem) => {
    if (mode?.type === 'edit' && mode.item.path === item.path) return;
    if (!(await guard())) return;
    openItem(item);
  };

  const onNew = async (kind: CmdKind) => {
    if (!(await guard())) return;
    startNew(kind, mode?.type === 'edit' ? mode.item.scope : hasProject ? 'project' : 'user');
  };

  const applyTemplate = async (tpl: CmdTemplate) => {
    if (dirty && !(await askConfirm({ title: t('commands.replace.title'), message: t('commands.replace.message'), confirmLabel: t('commands.replace.confirm'), danger: true }))) return;
    startNew(tpl.kind, form.scope, tpl);
  };

  const after = (op: 'write' | 'delete' | 'rename', path: string) => notifyCommandsChanged({ op, path, cwd: cwd || undefined });

  const save = async () => {
    const m = modeRef.current;
    const view = viewRef.current;
    if (!m || !view || saving || loadErr) return;
    const text = view.state.doc.toString();
    if (m.type === 'edit') {
      if (text === savedRef.current) return;
      setSaving(true);
      try {
        const r = await window.desk.call<CmdItem>('cmd:write', { path: m.item.path, cwd: cwd || null, text, agent });
        savedRef.current = text;
        setDirty(view.state.doc.toString() !== text);
        toast(t('commands.saved'));
        after('write', r.path);
        const list = await loadList();
        const fresh = list.find((i) => i.path === m.item.path);
        if (fresh && modeRef.current?.type === 'edit' && modeRef.current.item.path === fresh.path) setMode({ type: 'edit', item: fresh });
      } catch (e) {
        toast(t('commands.saveFailed', { error: errText(e) }), 'error');
      } finally {
        setSaving(false);
      }
      return;
    }
    const err = nameError(form.kind, form.name);
    if (err) {
      toast(err, 'error');
      return;
    }
    const file = buildFile({ name: form.kind === 'skill' ? form.name : undefined, description: form.description, argumentHint: form.argumentHint, allowedTools: form.allowedTools }, text);
    setSaving(true);
    try {
      const r = await window.desk.call<CmdItem>('cmd:write', { scope: form.scope, kind: form.kind, name: form.name, cwd: cwd || null, text: file, agent });
      toast(t(form.kind === 'skill' ? 'commands.skillCreated' : 'commands.commandCreated', { name: r.name }));
      after('write', r.path);
      await loadList();
      await openItem(r);
    } catch (e) {
      toast(t('commands.createFailed', { error: errText(e) }), 'error');
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;

  const remove = async () => {
    if (mode?.type !== 'edit') return;
    const it = mode.item;
    const ok = await askConfirm({
      title: t(it.kind === 'skill' ? 'commands.delete.skillTitle' : 'commands.delete.commandTitle', { name: it.name }),
      message: t(it.kind === 'skill' ? 'commands.delete.skillMessage' : 'commands.delete.commandMessage'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await window.desk.call('cmd:delete', it.path, cwd || null, agent);
      toast(t('commands.movedToTrash'));
      after('delete', it.path);
      const list = await loadList();
      if (list[0]) openItem(list[0]);
      else {
        ++loadToken.current;
        setMode(null);
        viewRef.current?.setState(makeState(''));
        setDirty(false);
      }
    } catch (e) {
      toast(t('commands.deleteFailed', { error: errText(e) }), 'error');
    }
  };

  const commitRename = async () => {
    if (mode?.type !== 'edit' || renaming === null) return;
    const it = mode.item;
    const next = renaming.trim().replace(/^\//, '');
    if (!next || next === it.name) {
      setRenaming(null);
      return;
    }
    const err = nameError(it.kind, next);
    if (err) {
      toast(err, 'error');
      return;
    }
    if (dirty) {
      toast(t('commands.saveFirst'), 'error');
      return;
    }
    try {
      const r = await window.desk.call<CmdItem>('cmd:rename', it.path, next, cwd || null, agent);
      setRenaming(null);
      toast(t('commands.renamed'));
      after('rename', r.path);
      await loadList();
      await openItem(r);
    } catch (e) {
      toast(t('commands.renameFailed', { error: errText(e) }), 'error');
    }
  };

  const refresh = async () => {
    if (!(await guard())) return;
    const list = await loadList();
    const cur = modeRef.current;
    if (cur?.type === 'new') return;
    const keep = cur?.type === 'edit' && list.find((i) => i.path === cur.item.path);
    if (keep) openItem(keep);
    else if (list[0]) openItem(list[0]);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // CodeMirror handles Mod-s itself (and marks the event as handled); this covers the form inputs.
    if (!e.defaultPrevented && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  };

  const shownPath = (p: string) => (paths?.home && p.toLowerCase().startsWith(paths.home.toLowerCase()) ? '~' + p.slice(paths.home.length) : p);

  const groups = useMemo(
    () => [
      { scope: 'user' as const, title: t('commands.group.user'), items: (items ?? []).filter((i) => i.scope === 'user') },
      ...(hasProject ? [{ scope: 'project' as const, title: projLabel, items: (items ?? []).filter((i) => i.scope === 'project') }] : []),
    ],
    [items, hasProject, projLabel],
  );

  const newTarget = useMemo(() => {
    if (mode?.type !== 'new' || !paths) return '';
    const root = form.scope === 'project' && paths.project ? paths.project : paths.user;
    const n = form.name || t('commands.namePlaceholder');
    return form.kind === 'skill' ? `${root.skills}\\${n}\\SKILL.md` : `${root.commands}\\${n.split(':').join('\\')}.md`;
  }, [mode, paths, form.scope, form.kind, form.name]);

  const editing = mode?.type === 'edit' ? mode.item : null;
  const nameErr = mode?.type === 'new' && form.name ? nameError(form.kind, form.name) : null;
  const pv =
    mode?.type === 'new'
      ? { name: form.name, description: form.description.trim() || preview.description, argumentHint: form.argumentHint.trim() }
      : { name: editing?.name ?? '', ...preview };

  return (
    <div className="cmds" onKeyDown={onKeyDown}>
      <div className="set-head-row">
        <h2>{t('commands.title')}</h2>
        <span className="spacer" />
        <button className="pill sm" onClick={() => onNew('command')} title={t('commands.newCommand')}>
          <Plus size={12} /> {t('commands.command')}
        </button>
        <button className="pill sm" onClick={() => onNew('skill')} title={t('commands.newSkill')}>
          <Plus size={12} /> {t('commands.skill')}
        </button>
        <button className="icon-btn" title={t('commands.reload')} onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>
      <AgentTabs value={agent} onChange={setAgent} />
      <p className="muted small">
        {t('commands.intro.before')} <code>/review</code>
        {t('commands.intro.after')}
        {!cwd && ' ' + t('commands.intro.noProject')}
      </p>

      <div className="instr-layout cmd-layout">
        <div className="instr-list">
          {!items && <div className="muted small instr-empty">{t('common.loading')}</div>}
          {items &&
            groups.map((g) => (
              <div key={g.scope} className="instr-group">
                <div className="instr-group-title truncate" title={g.scope === 'project' ? cwd : paths?.user.commands}>
                  {g.title}
                </div>
                {!g.items.length && <div className="muted small instr-empty">{t('commands.empty')}</div>}
                {g.items.map((i) => (
                  <button
                    key={i.path}
                    className={`instr-item cmd-item ${editing?.path === i.path ? 'is-active' : ''}`}
                    title={`${kindLabel(i.kind)} · ${i.path}`}
                    onClick={() => select(i)}
                  >
                    {i.kind === 'skill' ? <Sparkles size={13} /> : <SquareSlash size={13} />}
                    <span className="instr-item-text">
                      <span className="truncate cmd-item-name">/{i.name}</span>
                      <span className="instr-item-meta truncate">{i.description || t('commands.noDescription')}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
        </div>

        <div className="instr-main">
          {mode?.type === 'new' && (
            <div className="cmd-form">
              <div className="cmd-form-head">
                <span className="cmd-form-title">{t(form.kind === 'skill' ? 'commands.newSkill' : 'commands.newCommand')}</span>
                <span className="spacer" />
                <button
                  className="icon-btn sm"
                  title={t('common.cancel')}
                  onClick={async () => {
                    if (!(await guard())) return;
                    const first = items?.[0];
                    if (first) openItem(first);
                    else {
                      setMode(null);
                      setDirty(false);
                    }
                  }}
                >
                  <X size={13} />
                </button>
              </div>
              <div className="cmd-templates">
                {templates.filter((x) => x.kind === form.kind).map((x) => (
                  <button key={x.id} className={`pill sm ${form.template === x.id ? 'is-on' : ''}`} onClick={() => applyTemplate(x)}>
                    {x.label}
                  </button>
                ))}
              </div>
              <div className="cmd-form-row">
                <label className="cmd-field cmd-field-name">
                  <span>{t('commands.field.name')}</span>
                  <span className={`cmd-name-input ${nameErr ? 'is-bad' : ''}`}>
                    <span className="cmd-name-prefix">/</span>
                    <input
                      className="input"
                      value={form.name}
                      placeholder={form.kind === 'skill' ? 'my-skill' : t('commands.field.namePlaceholder')}
                      spellCheck={false}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.toLowerCase().replace(/\s+/g, '-') }))}
                    />
                  </span>
                </label>
                <label className="cmd-field">
                  <span>{t('commands.field.scope')}</span>
                  <select className="input select" value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value as 'user' | 'project' }))}>
                    <option value="user">{t('commands.scope.user')}</option>
                    <option value="project" disabled={!hasProject}>
                      {hasProject ? projLabel : t('commands.scope.noProject')}
                    </option>
                  </select>
                </label>
              </div>
              {nameErr && <div className="instr-error small">{nameErr}</div>}
              <label className="cmd-field">
                <span>{t('commands.field.description')}</span>
                <input
                  className="input"
                  value={form.description}
                  placeholder={t(form.kind === 'skill' ? 'commands.field.descriptionSkill' : 'commands.field.descriptionCommand')}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </label>
              <div className="cmd-form-row">
                <label className="cmd-field">
                  <span>{t('commands.field.argumentHint')}</span>
                  <input className="input" value={form.argumentHint} placeholder={t('commands.field.argumentHintPlaceholder')} onChange={(e) => setForm((f) => ({ ...f, argumentHint: e.target.value }))} />
                </label>
                <label className="cmd-field">
                  <span>{t('commands.field.allowedTools')}</span>
                  <input className="input" value={form.allowedTools} placeholder="Read, Bash(git diff:*)" onChange={(e) => setForm((f) => ({ ...f, allowedTools: e.target.value }))} />
                </label>
              </div>
              <div className="cmd-form-hint muted small">
                {t(form.kind === 'skill' ? 'commands.hint.skillText' : 'commands.hint.commandText')} <code>$ARGUMENTS</code> {t('commands.hint.arguments')} <code>$1</code>,{' '}
                <code>$2</code>… {t('commands.hint.positional')}
              </div>
            </div>
          )}

          {mode && (
            <div className="instr-toolbar">
              {mode.type === 'edit' && renaming !== null ? (
                <input
                  className="input cmd-rename"
                  autoFocus
                  value={renaming}
                  spellCheck={false}
                  onChange={(e) => setRenaming(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setRenaming(null);
                    }
                  }}
                  onBlur={() => setRenaming(null)}
                />
              ) : (
                <span className="instr-path truncate" title={editing?.path ?? newTarget}>
                  {editing ? shownPath(editing.path) : shownPath(newTarget)}
                </span>
              )}
              {dirty && <span className="instr-dirty" title={t('commands.unsaved')} />}
              <span className="spacer" />
              {editing && (
                <>
                  <button className="icon-btn sm" title={t('common.rename')} onMouseDown={(e) => e.preventDefault()} onClick={() => setRenaming(renaming === null ? editing.name : null)}>
                    <Pencil size={13} />
                  </button>
                  <button className="icon-btn sm" title={t('commands.showInFolder')} onClick={() => window.desk.showInFolder(editing.path)}>
                    <FolderOpen size={13} />
                  </button>
                  <button className="icon-btn sm cmd-del" title={t('commands.deleteToTrash')} onClick={remove}>
                    <Trash2 size={13} />
                  </button>
                </>
              )}
              <button
                className="pill sm"
                disabled={saving || !!loadErr || (mode.type === 'edit' ? !dirty : !!nameError(form.kind, form.name))}
                onClick={save}
                title="Ctrl+S"
              >
                {mode.type === 'new' ? <Plus size={12} /> : <Save size={12} />}
                {t(mode.type === 'new' ? 'common.create' : 'common.save')}
              </button>
            </div>
          )}

          <div
            ref={hostRef}
            className={`cm-host instr-editor cmd-editor ${mode?.type === 'new' ? 'is-short' : ''}`}
            style={{ display: !mode || loadErr ? 'none' : 'block' }}
          />
          {mode && loadErr && <div className="instr-editor instr-load-err muted small">{loadErr}</div>}
          {!mode && items && (
            <div className="instr-editor instr-load-err cmd-empty muted small">
              <div>{t('commands.none')}</div>
              <button className="pill sm" onClick={() => onNew('command')}>
                <Plus size={12} /> {t('commands.createFirst')}
              </button>
            </div>
          )}
          {mode && !loadErr && <MenuPreview {...pv} />}
        </div>
      </div>
    </div>
  );
}
