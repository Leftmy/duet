import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  FilePen,
  FilePlus2,
  FileCode2,
  FileText,
  Globe,
  ListChecks,
  MessageSquare,
  MessageSquarePlus,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import type { ToolItem } from '../types';
import { toolStats, toolDiff, toolKind, toolSummary, type DiffLine } from '../lib/tools';
import { duration } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Markdown } from './Markdown';
import { useStore } from '../store';
import { t } from '../i18n';

const ICONS = {
  shell: SquareTerminal,
  read: FileText,
  edit: FilePen,
  write: FilePlus2,
  search: Search,
  web: Globe,
  agent: Bot,
  todo: ListChecks,
  question: CircleHelp,
  plan: ListChecks,
  skill: Sparkles,
  mcp: Plug,
  other: Wrench,
};

export const collapse = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { height: { type: 'spring' as const, stiffness: 420, damping: 40 }, opacity: { duration: 0.18 } },
};

/** Diff lines; with `file` set, each line can take a review comment that is later sent to Claude. */
export function DiffView({ lines, max = 400, file }: { lines: DiffLine[]; max?: number; file?: string }) {
  const shown = lines.slice(0, max);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const activeId = useStore((s) => s.activeId);
  const addReview = useStore((s) => s.addReview);
  const allComments = useStore((s) => s.review[s.activeId]);
  const comments = file && allComments ? allComments.filter((c) => c.file === file) : [];
  const commit = (l: DiffLine) => {
    if (draft.trim() && file) {
      addReview(activeId, { file, line: l.text, sign: l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ', text: draft.trim() });
    }
    setDraft('');
    setEditing(null);
  };
  return (
    <div className="diff">
      {shown.map((l, i) => (
        <div key={i}>
          <div className={`diff-line diff-${l.type} ${file && l.type !== 'sep' ? 'can-comment' : ''}`}>
            {file && l.type !== 'sep' && (
              <button className="diff-comment-btn" title={t('tools.commentLine')} onClick={() => setEditing(editing === i ? null : i)}>
                <MessageSquarePlus size={11} />
              </button>
            )}
            <span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}</span>
            <span className="diff-text">{l.text || ' '}</span>
          </div>
          {comments
            .filter((c) => c.line === l.text && (c.sign === '+' ? l.type === 'add' : c.sign === '-' ? l.type === 'del' : l.type === 'ctx'))
            .map((c) => (
              <div key={c.id} className="diff-note">
                <MessageSquare size={11} /> {c.text}
              </div>
            ))}
          {editing === i && (
            <div className="diff-editor">
              <textarea
                className="input"
                autoFocus
                rows={2}
                placeholder={t('tools.commentPlaceholder')}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commit(l);
                  }
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
              <div className="approval-actions">
                <button className="btn ghost" onClick={() => setEditing(null)}>
                  {t('common.cancel')}
                </button>
                <button className="btn primary" disabled={!draft.trim()} onClick={() => commit(l)}>
                  {t('common.add')}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      {lines.length > max && <div className="diff-line diff-sep">{t('tools.moreLines', { count: lines.length - max })}</div>}
    </div>
  );
}

function Todos({ todos }: { todos: any[] }) {
  const done = todos.filter((td) => td.status === 'completed').length;
  return (
    <div className="plan-card">
      <div className="plan-head">
        <ListChecks size={14} />
        <span>{t('tools.plan')}</span>
        <span className="muted">
          {t('tools.planProgress', { done, total: todos.length })}
        </span>
      </div>
      {todos.map((td, i) => (
        <div key={i} className={`todo todo-${td.status}`}>
          <span className="todo-box">{td.status === 'completed' && <Check size={11} strokeWidth={3} />}</span>
          <span>{td.status === 'in_progress' ? td.activeForm || td.content : td.content}</span>
        </div>
      ))}
    </div>
  );
}

function StatusFoot({ item }: { item: ToolItem }) {
  if (item.status === 'running') return <span className="status-foot shimmer">{t('tools.statusRunning')}</span>;
  return item.status === 'error' ? (
    <span className="status-foot err">
      <X size={12} /> {t('common.error')}
    </span>
  ) : (
    <span className="status-foot ok">
      <Check size={12} /> {t('tools.statusSuccess')}
    </span>
  );
}

function Details({ item, cwd }: { item: ToolItem; cwd?: string }) {
  const kind = toolKind(item.name);
  const diff = useMemo(() => (kind === 'edit' || kind === 'write' ? toolDiff(item) : null), [item, kind]);
  const i = item.input ?? {};
  if (diff) {
    return (
      <div className="detail-card">
        <div className="detail-path" title={i.file_path}>
          {i.file_path?.replace(cwd ?? '\u0000', '').replace(/^[\\/]/, '')}
        </div>
        <DiffView lines={diff} file={i.file_path} />
        {item.status === 'error' && item.result && <pre className="detail-out err-text">{item.result}</pre>}
      </div>
    );
  }
  if (kind === 'shell') {
    return (
      <div className="detail-card terminal">
        <pre className="detail-out">
          <span className="prompt">$ </span>
          {i.command}
          {item.result ? '\n\n' + item.result.slice(0, 20000) : ''}
        </pre>
        <div className="detail-foot">
          {item.endedAt && <span className="muted">{duration(item.endedAt - item.startedAt)}</span>}
          <StatusFoot item={item} />
        </div>
      </div>
    );
  }
  if (kind === 'agent') {
    const subs = item.subs ?? [];
    return (
      <div className="detail-card agent-card">
        {i.prompt && <div className="agent-prompt">{String(i.prompt).slice(0, 600)}</div>}
        {subs.length > 0 && (
          <div className="agent-subs">
            {subs.slice(-40).map((s, n) => (
              <div key={n} className="agent-sub">
                {s}
              </div>
            ))}
          </div>
        )}
        {item.result && (
          <div className="agent-result">
            <Markdown text={item.result.slice(0, 20000)} />
          </div>
        )}
        <div className="detail-foot">
          {item.endedAt && <span className="muted">{duration(item.endedAt - item.startedAt)}</span>}
          <StatusFoot item={item} />
        </div>
      </div>
    );
  }
  if (item.name === 'ExitPlanMode' && i.plan) {
    return (
      <div className="detail-card">
        <Markdown text={i.plan} />
      </div>
    );
  }
  const raw = item.result ?? (item.inputJson || JSON.stringify(item.input, null, 2));
  // Image results are shown as pictures (above the card); drop their text placeholders.
  const body = item.images?.length ? raw.split(`${t('tools.imagePlaceholder')}\n`).join('').split(t('tools.imagePlaceholder')).join('').trim() : raw;
  if (item.images?.length && !body) return null;
  return (
    <div className="detail-card">
      <pre className="detail-out">{body.slice(0, 20000) || '—'}</pre>
      <div className="detail-foot">
        <StatusFoot item={item} />
      </div>
    </div>
  );
}

export const ToolRow = memo(function ToolRow({ item, cwd }: { item: ToolItem; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const activeId = useStore((s) => s.activeId);
  // Moving a running call to the background is an agent feature (Claude Code), not a generic one.
  const canBackground = useStore((s) => s.providers[s.threads[s.activeId]?.provider ?? 'claude']?.caps?.backgroundTasks !== false);
  const now = useNow(item.status === 'running');
  const kind = toolKind(item.name);
  const Icon = ICONS[kind];
  const s = toolSummary(item);
  const stats = useMemo(() => (kind === 'edit' || kind === 'write' ? toolStats(item) : null), [item.input, item.name, kind]);

  if (item.name === 'TodoWrite' && Array.isArray(item.input?.todos)) return <Todos todos={item.input.todos} />;

  const running = item.status === 'running';
  const elapsed = running && now - item.startedAt > 2500 ? duration(now - item.startedAt) : null;

  return (
    <div className={`step ${open ? 'is-open' : ''}`}>
      <button className="step-row" onClick={() => setOpen((v) => !v)} title={s.title}>
        <Icon size={14} className="step-icon" />
        <span className={`step-text ${running ? 'shimmer' : ''}`}>
          {s.verb}
          {s.subject && (s.code ? <code className="step-code">{s.subject}</code> : <span className="step-subject"> {s.subject}</span>)}
        </span>
        {stats && (stats.add > 0 || stats.del > 0) && (
          <span className="step-stats">
            {stats.add > 0 && <span className="add">+{stats.add}</span>}
            {stats.del > 0 && <span className="del">−{stats.del}</span>}
          </span>
        )}
        {kind === 'agent' && item.subSteps > 0 && (
          <span className="step-meta">
            {t('agents.steps', { count: item.subSteps })}{running && item.lastSub ? ` · ${item.lastSub}` : ''}
          </span>
        )}
        {item.status === 'error' && <span className="step-err">{t('tools.errorBadge')}</span>}
        {elapsed && <span className="step-meta">{elapsed}</span>}
        {canBackground && running && (kind === 'shell' || kind === 'agent') && !item.input?.run_in_background && now - item.startedAt > 3000 && (
          <span
            role="button"
            className="step-action"
            title={t('tools.toBackgroundHint')}
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().backgroundTask(activeId, item.id);
            }}
          >
            {t('tools.toBackground')}
          </span>
        )}
        {item.input?.run_in_background && <span className="chip">{t('agents.background')}</span>}
        {(kind === 'read' || kind === 'edit' || kind === 'write') && (item.input?.file_path || item.input?.notebook_path) && (
          <span
            role="button"
            className="step-action icon"
            title={t('tools.openInEditor')}
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().openFile(item.input.file_path ?? item.input.notebook_path);
            }}
          >
            <FileCode2 size={12} />
          </span>
        )}
        <ChevronRight size={13} className="step-chevron" />
      </button>
      {item.images && item.images.length > 0 && (
        <div className="step-shots">
          {item.images.map((img, n) => (
            <img
              key={n}
              src={`data:${img.mediaType};base64,${img.data}`}
              alt=""
              onClick={() => useStore.setState({ zoomImage: `data:${img.mediaType};base64,${img.data}` })}
            />
          ))}
        </div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="step-details" {...collapse}>
            <Details item={item} cwd={cwd} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
