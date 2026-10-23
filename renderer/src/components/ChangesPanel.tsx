import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FileDiff,
  FolderSearch,
  GitBranch,
  Globe,
  RefreshCw,
  Sparkles,
  SquareTerminal,
  Undo2,
  Wand2,
  X,
  ListTodo,
} from 'lucide-react';
import type { GitFile, GitStatus, Thread, ToolItem } from '../types';
import { basename, shortPath } from '../lib/format';
import { buildDiff, diffStats, parseUnifiedDiff, toolDiff, toolKind, type DiffLine } from '../lib/tools';
import { DiffView, collapse } from './ToolRow';
import { MenuItem, Popover, spring } from './Popover';
import { AgentsTab } from './Agents';
import { TasksTab } from './TasksBar';
import { askConfirm } from '../lib/dialog';
import { BrowserPanel } from './BrowserPanel';
import { FilesPanel } from './FilesPanel';
import { TerminalPanel } from './TerminalPanel';
import { useStore } from '../store';
import { PullRequestSection } from '../features/pr/PullRequestSection';
import { isDetachedWindow } from '../features/detach/mode';
import { t } from '../i18n';

import { collectChanges, type FileChange } from '../lib/changes';

const FileRow = memo(function FileRow({ fc, cwd }: { fc: FileChange; cwd: string }) {
  const [open, setOpen] = useState(false);
  const rel = shortPath(fc.path, cwd);
  const dir = rel.slice(0, Math.max(0, rel.length - basename(rel).length)).replace(/[\\/]$/, '');
  return (
    <div className={`change ${open ? 'is-open' : ''}`}>
      <div className="change-row" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className="change-chevron" />
        <span className="change-name truncate" title={fc.path}>
          {basename(fc.path)}
          {dir && <span className="muted"> {dir}</span>}
        </span>
        {fc.created && <span className="chip">{t('changes.new')}</span>}
        <span className="step-stats">
          {fc.add > 0 && <span className="add">+{fc.add}</span>}
          {fc.del > 0 && <span className="del">−{fc.del}</span>}
        </span>
        <button
          className="icon-btn sm"
          title={t('changes.openFile')}
          onClick={(e) => {
            e.stopPropagation();
            window.desk.openPath(fc.path);
          }}
        >
          <ExternalLink size={12} />
        </button>
        <button
          className="icon-btn sm"
          title={t('changes.revealInExplorer')}
          onClick={(e) => {
            e.stopPropagation();
            window.desk.showInFolder(fc.path);
          }}
        >
          <FolderSearch size={12} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="change-body" {...collapse}>
            {fc.items.map((it, i) => {
              const lines = toolDiff(it);
              return lines ? (
                <div key={it.id} className="change-diff">
                  {fc.items.length > 1 && <div className="change-step muted">{t('changes.editN', { n: i + 1 })}</div>}
                  <DiffView lines={lines} max={600} file={fc.path} />
                </div>
              ) : null;
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

const GIT_STATUS_KEY: Record<GitFile['status'], string | null> = {
  new: 'changes.new',
  added: 'changes.added',
  deleted: 'changes.deleted',
  renamed: 'changes.renamed',
  modified: null,
};

const GitRow = memo(function GitRow({
  file,
  root,
  version,
  checked,
  onToggle,
  onDiscard,
}: {
  file: GitFile;
  root: string;
  version: number;
  checked: boolean;
  onToggle: () => void;
  onDiscard: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<DiffLine[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dir = file.path.slice(0, Math.max(0, file.path.length - basename(file.path).length)).replace(/\/$/, '');

  useEffect(() => {
    setLines(null);
  }, [version]);

  useEffect(() => {
    if (!open || lines) return;
    let alive = true;
    window.desk
      .gitFileDiff(root, file.path, file.untracked)
      .then((r) => {
        if (!alive) return;
        if (r.kind === 'dir') setNote(t('changes.newFolder'));
        else if (r.kind === 'binary') setNote(t('tools.binaryFile'));
        else if (r.kind === 'too-large') setNote(t('changes.tooLarge'));
        else if (r.kind === 'new') setLines(buildDiff('', r.text ?? ''));
        else setLines(parseUnifiedDiff(r.text ?? ''));
      })
      .catch((e) => alive && setNote(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [open, lines, root, file]);

  const labelKey = GIT_STATUS_KEY[file.status];
  const label = labelKey ? t(labelKey) : null;
  return (
    <div className={`change ${open ? 'is-open' : ''}`}>
      <div className="change-row" onClick={() => setOpen((v) => !v)}>
        <span
          role="checkbox"
          aria-checked={checked}
          className={`check ${checked ? 'is-on' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {checked && <Check size={10} strokeWidth={3.5} />}
        </span>
        <ChevronRight size={13} className="change-chevron" />
        <span className={`change-name truncate ${file.status === 'deleted' ? 'is-deleted' : ''}`} title={file.abs}>
          {basename(file.path)}
          {dir && <span className="muted"> {dir}</span>}
        </span>
        {label && <span className="chip">{label}</span>}
        <span className="step-stats">
          {file.add > 0 && <span className="add">+{file.add}</span>}
          {file.del > 0 && <span className="del">−{file.del}</span>}
        </span>
        {file.status !== 'deleted' && (
          <button
            className="icon-btn sm"
            title={t('changes.openFile')}
            onClick={(e) => {
              e.stopPropagation();
              window.desk.openPath(file.abs);
            }}
          >
            <ExternalLink size={12} />
          </button>
        )}
        <button
          className="icon-btn sm danger-hover"
          title={file.untracked ? t('changes.deleteNewFile') : t('changes.discardFile')}
          onClick={(e) => {
            e.stopPropagation();
            onDiscard();
          }}
        >
          <Undo2 size={12} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="change-body" {...collapse}>
            {note ? (
              <div className="change-step muted">{note}</div>
            ) : lines ? (
              <DiffView lines={lines} max={800} file={file.abs} />
            ) : (
              <div className="skeleton-line shimmer-bg" style={{ margin: 12, width: '60%' }} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

function BranchPicker({ root, branch, onChanged }: { root: string; branch?: string | null; onChanged: () => void }) {
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [name, setName] = useState('');
  const close = useCallback(() => setOpen(false), []);
  const go = (b: string, create: boolean) => {
    setOpen(false);
    window.desk
      .gitCheckout(root, b, create)
      .then(() => {
        toast(create ? t('changes.branchCreated', { branch: b }) : t('changes.switchedTo', { branch: b }));
        onChanged();
      })
      .catch((e) => toast(String(e?.message ?? e), 'error'));
  };
  return (
    <Popover
      open={open}
      onClose={close}
      side="bottom"
      align="left"
      width={260}
      trigger={() => (
        <button
          className="pill sm"
          onClick={() => {
            if (!open) window.desk.gitBranches(root).then(setBranches).catch(() => {});
            setOpen((v) => !v);
          }}
        >
          <GitBranch size={12} />
          <span className="pill-strong">{branch ?? '—'}</span>
          <ChevronDown size={12} className="muted" />
        </button>
      )}
    >
      <div className="menu-title">{t('changes.branches')}</div>
      <div className="menu-scroll">
        {branches.map((b) => (
          <MenuItem key={b} label={b} checked={b === branch} onClick={() => b !== branch && go(b, false)} />
        ))}
      </div>
      <div className="menu-sep" />
      <form
        className="branch-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) go(name.trim(), true);
        }}
      >
        <input className="input" placeholder={t('changes.newBranch')} value={name} onChange={(e) => setName(e.target.value)} />
      </form>
    </Popover>
  );
}

function GitTab({ thread }: { thread: Thread }) {
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<null | 'commit' | 'push' | 'pull' | 'msg'>(null);

  const refresh = useCallback(() => {
    if (!thread.cwd) return;
    setLoading(true);
    window.desk
      .gitStatus(thread.cwd)
      .then((s) => {
        setStatus(s);
        setVersion((v) => v + 1);
      })
      .catch(() => setStatus({ isRepo: false, files: [] }))
      .finally(() => setLoading(false));
  }, [thread.cwd]);

  // Re-read the working tree whenever a turn finishes (Claude may have touched files).
  useEffect(() => {
    if (thread.status === 'idle') refresh();
  }, [refresh, thread.status, thread.entries.length]);

  if (!thread.cwd) return <div className="changes-empty muted">{t('changes.noProject')}</div>;
  if (status && !status.isRepo) return <div className="changes-empty muted">{t('changes.notRepo')}</div>;

  const files = status?.files ?? [];
  const selected = files.filter((f) => !excluded.has(f.path));
  const totals = selected.reduce((a, f) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 });
  const root = status?.root ?? '';

  const run = async (kind: 'commit' | 'push' | 'pull', fn: () => Promise<unknown>, ok: (r: any) => string) => {
    setBusy(kind);
    try {
      const r = await fn();
      toast(ok(r));
      refresh();
      return true;
    } catch (e: any) {
      toast(String(e?.message ?? e), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const commit = async (andPush: boolean) => {
    const paths = selected.map((f) => f.path);
    const done = await run('commit', () => window.desk.gitCommit(root, paths, message), (r) => t('changes.committed', { hash: r }));
    if (!done) return;
    setMessage('');
    setExcluded(new Set());
    if (andPush) await run('push', () => window.desk.gitPush(root), () => t('changes.pushed'));
  };

  const draft = async () => {
    setBusy('msg');
    try {
      const m = await window.desk.commitMessage(root, selected.map((f) => f.path));
      if (m) setMessage(m);
    } catch (e: any) {
      toast(String(e?.message ?? e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const discard = async (f: GitFile) => {
    const ok = await askConfirm({
      title: f.untracked ? t('changes.deleteNewFileTitle') : t('changes.discardFileTitle'),
      message: f.untracked ? t('changes.deleteNewFileMessage') : t('changes.discardFileMessage'),
      details: [f.path],
      confirmLabel: f.untracked ? t('common.delete') : t('changes.discard'),
      danger: true,
    });
    if (!ok) return;
    window.desk
      .gitDiscard(root, f.path, f.untracked)
      .then(() => refresh())
      .catch((e) => toast(String(e?.message ?? e), 'error'));
  };

  const toggle = (p: string) =>
    setExcluded((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const allOn = files.length > 0 && excluded.size === 0;

  return (
    <>
      <div className="git-bar">
        {status && <BranchPicker root={root} branch={status.branch} onChanged={refresh} />}
        {status && files.length > 0 && (
          <span className="step-stats">
            <span className="muted">
              {t('changes.selectedOf', { n: selected.length, total: files.length })}
            </span>
            <span className="add">+{totals.add}</span>
            <span className="del">−{totals.del}</span>
          </span>
        )}
        <div className="spacer" />
        {status?.upstream && (status.behind ?? 0) > 0 && (
          <button className="pill sm" disabled={!!busy} onClick={() => run('pull', () => window.desk.gitPull(root), () => t('changes.pulled'))}>
            <ArrowDown size={12} /> {status.behind}
          </button>
        )}
        {status?.hasHead && (!status.upstream || (status.ahead ?? 0) > 0) && (
          <button
            className="pill sm"
            title={status.upstream ? t('changes.pushCommits') : t('changes.publishBranch')}
            disabled={!!busy}
            onClick={() => run('push', () => window.desk.gitPush(root), () => t('changes.pushed'))}
          >
            {busy === 'push' ? <RefreshCw size={12} className="spin" /> : <ArrowUp size={12} />}
            {status.upstream ? t('changes.pushN', { n: status.ahead }) : t('changes.publish')}
          </button>
        )}
        <button className="icon-btn sm" title={t('common.refresh')} onClick={refresh}>
          <RefreshCw size={12} className={loading ? 'spin' : ''} />
        </button>
      </div>
      {files.length > 0 && (
        <div className="git-select">
          <span
            role="checkbox"
            aria-checked={allOn}
            className={`check ${allOn ? 'is-on' : excluded.size < files.length ? 'is-mixed' : ''}`}
            onClick={() => setExcluded(allOn ? new Set(files.map((f) => f.path)) : new Set())}
          >
            {allOn && <Check size={10} strokeWidth={3.5} />}
          </span>
          <span className="muted small">{allOn ? t('changes.allFiles') : t('changes.selectedN', { n: selected.length })}</span>
        </div>
      )}
      <div className="changes-list">
        {!status ? (
          <div className="skeleton">
            {[70, 50, 85].map((w, i) => (
              <div key={i} className="skeleton-line shimmer-bg" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : status.files.length === 0 ? (
          <div className="changes-empty muted">{t('changes.clean')}</div>
        ) : (
          <>
            {status.files.slice(0, showAll ? undefined : 200).map((f) => (
              <GitRow
                key={f.path}
                file={f}
                root={root}
                version={version}
                checked={!excluded.has(f.path)}
                onToggle={() => toggle(f.path)}
                onDiscard={() => discard(f)}
              />
            ))}
            {!showAll && status.files.length > 200 && (
              <button className="side-more" onClick={() => setShowAll(true)}>
                {t('changes.showMore', { n: status.files.length - 200 })}
              </button>
            )}
          </>
        )}
      </div>
      {status?.isRepo && <PullRequestSection cwd={thread.cwd} threadId={thread.id} version={version} />}
      {files.length > 0 && (
        <div className="commit-box">
          <div className="commit-input-wrap">
            <textarea
              className="input commit-input"
              rows={message.includes('\n') ? 4 : 2}
              placeholder={t('changes.commitMessage')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && message.trim() && selected.length) commit(false);
              }}
            />
            <button className="icon-btn sm commit-ai" title={t('changes.suggestMessage')} disabled={!!busy || !selected.length} onClick={draft}>
              {busy === 'msg' ? <RefreshCw size={12} className="spin" /> : <Wand2 size={13} />}
            </button>
          </div>
          <div className="commit-actions">
            <button className="btn" disabled={!!busy || !message.trim() || !selected.length} onClick={() => commit(true)}>
              {t('changes.commitAndPush')}
            </button>
            <button className="btn primary" disabled={!!busy || !message.trim() || !selected.length} onClick={() => commit(false)}>
              {busy === 'commit' ? <RefreshCw size={12} className="spin" /> : <Check size={13} />}
              {t('changes.commit')} {selected.length < files.length ? `(${selected.length})` : ''}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function ChangesPanel({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const files = useMemo(() => collectChanges(thread), [thread.entries]);
  const tab = useStore((s) => s.panelTab);
  const setTab = useStore((s) => s.setPanelTab);
  const agentCount = Object.keys(thread.agents).length;
  const bgTasks = Object.values(thread.tasks).filter((x) => x.background);
  const taskCount = bgTasks.filter((x) => x.status === 'running' || x.status === 'pending' || x.status === 'paused').length || bgTasks.length;
  const totals = files.reduce((a, f) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 });
  const TABS = [
    { k: 'chat' as const, icon: <FileDiff size={13} />, label: t('changes.tabChat'), count: files.length },
    { k: 'git' as const, icon: <GitBranch size={13} />, label: 'Git', count: 0 },
    { k: 'agents' as const, icon: <Sparkles size={13} />, label: t('changes.tabAgents'), count: agentCount },
    { k: 'tasks' as const, icon: <ListTodo size={13} />, label: t('changes.tabTasks'), count: taskCount },
    { k: 'browser' as const, icon: <Globe size={13} />, label: t('changes.tabBrowser'), count: 0 },
    { k: 'files' as const, icon: <FileCode2 size={13} />, label: t('changes.tabFiles'), count: 0 },
    { k: 'terminal' as const, icon: <SquareTerminal size={13} />, label: t('changes.tabTerminal'), count: 0 },
  ];
  return (
    <div className="changes-content">
      <div className="changes-head">
        <div className="tabs">
          {TABS.filter((x) => x.k !== 'browser' || !isDetachedWindow()).map(({ k, icon, label, count }) => (
            <button key={k} className={`tab ${tab === k ? 'is-on' : ''}`} onClick={() => setTab(k)} title={label}>
              {tab === k && <motion.span layoutId="changes-tab" className="tab-bg" transition={spring} />}
              {icon}
              {tab === k && <span>{label}</span>}
              {count > 0 && <span className="muted">{count}</span>}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title={t('common.close')}>
          <X size={15} />
        </button>
      </div>
      {tab === 'chat' ? (
        <>
          {files.length > 0 && (
            <div className="git-bar">
              <span className="step-stats">
                <span className="muted">{t('changes.filesN', { count: files.length })}</span>
                <span className="add">+{totals.add}</span>
                <span className="del">−{totals.del}</span>
              </span>
            </div>
          )}
          <div className="changes-list">
            {files.length === 0 ? (
              <div className="changes-empty muted">{t('changes.noChanges')}</div>
            ) : (
              files.map((fc) => <FileRow key={fc.path} fc={fc} cwd={thread.cwd} />)
            )}
          </div>
        </>
      ) : tab === 'git' ? (
        <GitTab thread={thread} />
      ) : tab === 'agents' ? (
        <AgentsTab thread={thread} />
      ) : tab === 'tasks' ? (
        <TasksTab thread={thread} />
      ) : tab === 'files' ? (
        <FilesPanel thread={thread} />
      ) : tab === 'terminal' ? (
        <TerminalPanel thread={thread} />
      ) : (
        <BrowserPanel threadId={thread.id} />
      )}
    </div>
  );
}
