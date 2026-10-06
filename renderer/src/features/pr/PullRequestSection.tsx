// "Pull Request" section for the Git tab: PR card with CI checks, or a create-PR form.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Check,
  ChevronRight,
  CircleMinus,
  Copy,
  ExternalLink,
  Eye,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestCreate,
  GitPullRequestDraft,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { useStore } from '../../store';
import { t } from '../../i18n';
import { collapse } from '../../components/ToolRow';
import { Markdown } from '../../components/Markdown';
import { errText, type FailedLog, type PrCheck, type PrDraft, type PrInfo, type PrStatus } from './types';
import './pr.css';

const OPEN_KEY = 'pr.section.open';
const REFRESH_MS = 30000;

// Unsent form contents survive tab switches (keyed by cwd + branch).
const drafts = new Map<string, { base: string; title: string; body: string; draft: boolean }>();

function readOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeOpen(v: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, v ? '1' : '0');
  } catch {}
}

function copy(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => useStore.getState().toast(t('common.copied')))
    .catch(() => useStore.getState().toast(t('pr.copyFailed'), 'error'));
}

function checkCounts(checks: PrCheck[]) {
  const c = { ok: 0, failed: 0, pending: 0, skipped: 0 };
  for (const x of checks) c[x.bucket]++;
  return c;
}

function checksSummary(checks: PrCheck[]) {
  if (!checks.length) return t('pr.noChecks');
  const c = checkCounts(checks);
  const total = checks.length - c.skipped;
  const parts = [t('pr.checksPassed', { count: total, ok: c.ok })];
  if (c.failed) parts.push(t('pr.checksFailed', { count: c.failed }));
  if (c.pending) parts.push(t('pr.checksPending', { count: c.pending }));
  if (c.skipped) parts.push(t('pr.checksSkipped', { count: c.skipped }));
  return parts.join(' · ');
}

function CheckIcon({ bucket, size = 13 }: { bucket: PrCheck['bucket']; size?: number }) {
  if (bucket === 'ok') return <Check size={size} className="prs-ic ok" strokeWidth={2.6} />;
  if (bucket === 'failed') return <X size={size} className="prs-ic fail" strokeWidth={2.6} />;
  if (bucket === 'pending') return <LoaderCircle size={size} className="prs-ic pending spin" />;
  return <CircleMinus size={size} className="prs-ic muted" />;
}

function StateChip({ pr }: { pr: PrInfo }) {
  if (pr.state === 'MERGED')
    return (
      <span className="prs-state is-merged">
        <GitMerge size={11} /> {t('pr.stateMerged')}
      </span>
    );
  if (pr.state === 'CLOSED')
    return (
      <span className="prs-state is-closed">
        <GitPullRequestClosed size={11} /> {t('pr.stateClosed')}
      </span>
    );
  if (pr.isDraft)
    return (
      <span className="prs-state is-draft">
        <GitPullRequestDraft size={11} /> {t('pr.stateDraft')}
      </span>
    );
  return (
    <span className="prs-state is-open">
      <GitPullRequest size={11} /> {t('pr.stateOpen')}
    </span>
  );
}

const REVIEW_LABEL: Record<string, { key: string; tone: string }> = {
  APPROVED: { key: 'pr.reviewApproved', tone: 'ok' },
  CHANGES_REQUESTED: { key: 'pr.reviewChanges', tone: 'fail' },
  REVIEW_REQUIRED: { key: 'pr.reviewRequired', tone: '' },
};

function Hint({ text, cmd, onRetry, busy }: { text: string; cmd: string; onRetry: () => void; busy: boolean }) {
  return (
    <div className="prs-hint">
      <div className="small">{text}</div>
      <div className="prs-code">
        <code className="truncate">{cmd}</code>
        <button className="icon-btn sm" title={t('pr.copy')} onClick={() => copy(cmd)}>
          <Copy size={12} />
        </button>
      </div>
      <button className="btn ghost prs-sm-btn" disabled={busy} onClick={onRetry}>
        <RefreshCw size={12} className={busy ? 'spin' : ''} /> {t('pr.checkAgain')}
      </button>
    </div>
  );
}

function PrCard({ pr, cwd, threadId, loading, onRefresh }: { pr: PrInfo; cwd: string; threadId: string; loading: boolean; onRefresh: () => void }) {
  const toast = useStore((s) => s.toast);
  const [fixing, setFixing] = useState(false);
  const [showChecks, setShowChecks] = useState(true);
  const counts = checkCounts(pr.checks);
  const review = pr.reviewDecision ? REVIEW_LABEL[pr.reviewDecision] : null;
  const failed = pr.checks.filter((c) => c.bucket === 'failed');

  const fix = async () => {
    setFixing(true);
    try {
      const r = await window.desk.call<FailedLog>('pr:failedLogs', cwd);
      const fence = r.log.includes('```') ? '````' : '```';
      const text = [
        t('pr.fixIntro', { number: pr.number, title: pr.title, checks: failed.map((c) => c.name).join(', ') || r.name }),
        t('pr.fixLog', { run: r.name, url: r.url ? ` (${r.url})` : '', truncated: r.truncated ? t('pr.fixTruncated') : '' }),
        t('pr.fixAsk'),
        '',
        `${fence}text`,
        r.log,
        fence,
      ].join('\n');
      useStore.getState().send(threadId, text, []);
      toast(t('pr.logSent'));
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setFixing(false);
    }
  };

  return (
    <div className="prs-card">
      <div className="prs-title-row">
        <button className="prs-num" title={t('pr.openOnGitHub')} onClick={() => window.desk.openExternal(pr.url)}>
          #{pr.number}
        </button>
        <span className="prs-title truncate" title={pr.title}>
          {pr.title}
        </span>
      </div>
      <div className="prs-chips">
        <StateChip pr={pr} />
        {pr.baseRefName && <span className="chip">→ {pr.baseRefName}</span>}
        {review && pr.state === 'OPEN' && <span className={`chip prs-tone-${review.tone}`}>{t(review.key)}</span>}
        {pr.mergeable === 'CONFLICTING' && pr.state === 'OPEN' && <span className="chip prs-tone-fail">{t('pr.conflicts')}</span>}
      </div>
      {pr.checks.length > 0 ? (
        <>
          <button className="prs-summary" onClick={() => setShowChecks((v) => !v)}>
            <ChevronRight size={12} className={`prs-chev ${showChecks ? 'is-open' : ''}`} />
            <CheckIcon bucket={counts.failed ? 'failed' : counts.pending ? 'pending' : 'ok'} size={12} />
            <span className="truncate">{checksSummary(pr.checks)}</span>
          </button>
          <AnimatePresence initial={false}>
            {showChecks && (
              <motion.div className="prs-checks" {...collapse}>
                {pr.checks.map((c, i) => (
                  <div
                    key={`${c.name}-${i}`}
                    className={`prs-check ${c.url ? 'is-link' : ''}`}
                    title={c.url ? t('pr.checkOpen', { name: c.name }) : c.name}
                    onClick={() => c.url && window.desk.openExternal(c.url)}
                  >
                    <CheckIcon bucket={c.bucket} size={12} />
                    <span className="truncate">{c.name}</span>
                    {c.bucket === 'failed' && c.conclusion && c.conclusion !== 'failure' && <span className="muted small">{c.conclusion}</span>}
                    {c.url && <ExternalLink size={11} className="prs-check-ext" />}
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ) : (
        <div className="muted small prs-summary-static">{t('pr.noChecks')}</div>
      )}
      <div className="prs-actions">
        <button className="btn prs-sm-btn" onClick={() => window.desk.openExternal(pr.url)}>
          <ExternalLink size={12} /> {t('pr.openOnGitHub')}
        </button>
        <button className="btn ghost prs-sm-btn" disabled={loading} onClick={onRefresh}>
          <RefreshCw size={12} className={loading ? 'spin' : ''} /> {t('common.refresh')}
        </button>
        {failed.length > 0 && (
          <button className="btn primary prs-sm-btn" disabled={fixing} onClick={fix}>
            {fixing ? <RefreshCw size={12} className="spin" /> : <Wand2 size={12} />} {t('pr.askFix')}
          </button>
        )}
      </div>
    </div>
  );
}

function CreateForm({ st, cwd, onCreated }: { st: PrStatus; cwd: string; onCreated: () => void }) {
  const toast = useStore((s) => s.toast);
  const key = `${cwd}|${st.branch}`;
  const saved = drafts.get(key);
  const [open, setOpen] = useState(Boolean(saved && (saved.title || saved.body)));
  const [branches, setBranches] = useState<string[]>(st.defaultBranch ? [st.defaultBranch] : []);
  const [base, setBase] = useState(saved?.base || st.defaultBranch || '');
  const [title, setTitle] = useState(saved?.title ?? '');
  const [body, setBody] = useState(saved?.body ?? '');
  const [isDraft, setIsDraft] = useState(saved?.draft ?? false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState<null | 'gen' | 'push' | 'create'>(null);

  useEffect(() => {
    drafts.set(key, { base, title, body, draft: isDraft });
  }, [key, base, title, body, isDraft]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    window.desk
      .call<string[]>('pr:branches', cwd)
      .then((list) => {
        if (!alive) return;
        const d = st.defaultBranch;
        const rest = list.filter((b) => b !== d && b !== st.branch).sort((a, b) => a.localeCompare(b));
        const all = d ? [d, ...rest] : rest;
        setBranches(all);
        setBase((cur) => (cur && all.includes(cur) ? cur : all[0] ?? cur));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, cwd, st.defaultBranch, st.branch]);

  const generate = async () => {
    if (!base) return;
    setBusy('gen');
    try {
      const d = await window.desk.call<PrDraft>('pr:draft', cwd, base);
      setTitle(d.title);
      setBody(d.body);
      setPreview(false);
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const needsPush = !st.upstream || st.ahead > 0;
  const create = async () => {
    try {
      if (needsPush) {
        setBusy('push');
        await window.desk.call('pr:push', cwd);
      }
      setBusy('create');
      const r = await window.desk.call<{ url: string }>('pr:create', cwd, { base, title: title.trim(), body, draft: isDraft });
      drafts.delete(key);
      toast(t('pr.created', { url: r.url }));
      onCreated();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pushNote = !st.upstream
    ? t('pr.branchUnpublished')
    : st.ahead > 0
      ? t('pr.commitsWillPush', { count: st.ahead })
      : null;
  const noCommits = base === st.defaultBranch && st.commitsAhead === 0 && Boolean(st.upstream);
  const step = busy === 'push' ? t('pr.stepPush') : busy === 'create' ? t('pr.stepCreate') : busy === 'gen' ? t('pr.stepGen') : null;

  if (!open)
    return (
      <button className="btn prs-create-btn" onClick={() => setOpen(true)}>
        <GitPullRequestCreate size={13} /> {t('pr.createPullRequest')}
        {st.commitsAhead > 0 && (
          <span className="muted small">
            {t('pr.commits', { count: st.commitsAhead })}
          </span>
        )}
      </button>
    );

  return (
    <div className="prs-form">
      <div className="prs-row">
        <span className="muted small prs-label">
          {st.branch} →
        </span>
        <select className="input prs-select" value={base} disabled={!!busy} onChange={(e) => setBase(e.target.value)}>
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <button className="btn prs-sm-btn" disabled={!!busy || !base} onClick={generate} title={t('pr.generateHint')}>
          {busy === 'gen' ? <RefreshCw size={12} className="spin" /> : <Sparkles size={12} />} {t('pr.generate')}
        </button>
        <button className="icon-btn sm" title={t('pr.collapse')} onClick={() => setOpen(false)}>
          <X size={12} />
        </button>
      </div>
      <input className="input prs-input" placeholder={t('pr.titlePlaceholder')} value={title} maxLength={256} disabled={busy === 'gen'} onChange={(e) => setTitle(e.target.value)} />
      <div className="prs-body-wrap">
        {preview ? (
          <div className="prs-preview">{body.trim() ? <Markdown text={body} /> : <span className="muted small">{t('pr.emptyBody')}</span>}</div>
        ) : (
          <textarea
            className="input prs-textarea"
            rows={6}
            placeholder={t('pr.bodyPlaceholder')}
            value={body}
            disabled={busy === 'gen'}
            onChange={(e) => setBody(e.target.value)}
          />
        )}
        <button className="icon-btn sm prs-preview-btn" title={preview ? t('pr.editBody') : t('pr.preview')} onClick={() => setPreview((v) => !v)}>
          {preview ? <Pencil size={12} /> : <Eye size={12} />}
        </button>
      </div>
      {(pushNote || noCommits) && <div className="prs-note small">{noCommits ? t('pr.noCommitsVs', { branch: base }) : pushNote}</div>}
      <div className="prs-row">
        <label className="prs-draft-toggle" onClick={() => !busy && setIsDraft((v) => !v)}>
          <span role="checkbox" aria-checked={isDraft} className={`check ${isDraft ? 'is-on' : ''}`}>
            {isDraft && <Check size={10} strokeWidth={3.5} />}
          </span>
          <span className="small">{t('pr.draft')}</span>
        </label>
        <div className="spacer" />
        {step && <span className="muted small prs-step">{step}</span>}
        <button className="btn primary prs-sm-btn" disabled={!!busy || !title.trim() || !base} onClick={create}>
          {busy === 'push' || busy === 'create' ? <RefreshCw size={12} className="spin" /> : <GitPullRequestCreate size={12} />} {t('pr.createPr')}
        </button>
      </div>
    </div>
  );
}

/**
 * Pull Request block for the Git tab. `version` can be bumped by the parent to force a re-read
 * (e.g. after a commit or push in the Git tab).
 */
export function PullRequestSection({ cwd, threadId, version = 0 }: { cwd: string; threadId: string; version?: number }) {
  const [st, setSt] = useState<PrStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(readOpen);
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!cwd) return;
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const s = await window.desk.call<PrStatus>('pr:status', cwd);
      if (req === reqRef.current) setSt(s);
    } catch (e) {
      if (req === reqRef.current)
        setSt((cur) => ({
          ...(cur ?? { ghInstalled: true, authed: true, isRepo: true, isGitHub: true, repo: null, branch: null, defaultBranch: null, upstream: null, ahead: 0, commitsAhead: 0 }),
          error: errText(e),
        }));
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setSt(null);
  }, [cwd]);

  useEffect(() => {
    load();
  }, [load, version]);

  // Poll while CI is still running.
  const pending = st?.pr?.state === 'OPEN' && st.pr.checks.some((c) => c.bucket === 'pending');
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  if (!cwd || (st && !st.isRepo)) return null;

  const toggle = () =>
    setOpen((v) => {
      writeOpen(!v);
      return !v;
    });

  let content: ReactNode;
  if (!st) {
    content = <div className="skeleton-line shimmer-bg" style={{ width: '55%', margin: '4px 0' }} />;
  } else if (!st.isGitHub) {
    content = <div className="muted small">{t('pr.notGitHub')}</div>;
  } else if (!st.ghInstalled) {
    content = <Hint text={t('pr.needGh')} cmd="winget install GitHub.cli" onRetry={load} busy={loading} />;
  } else if (!st.authed) {
    content = <Hint text={t('pr.needAuth')} cmd="gh auth login" onRetry={load} busy={loading} />;
  } else if (st.pr) {
    content = <PrCard pr={st.pr} cwd={cwd} threadId={threadId} loading={loading} onRefresh={load} />;
  } else if (st.error) {
    content = (
      <div className="prs-error small">
        <span>{st.error}</span>
        <button className="btn ghost prs-sm-btn" disabled={loading} onClick={load}>
          <RefreshCw size={12} className={loading ? 'spin' : ''} /> {t('pr.retry')}
        </button>
      </div>
    );
  } else if (!st.branch) {
    content = <div className="muted small">{t('pr.detached')}</div>;
  } else if (st.branch === st.defaultBranch) {
    content = <div className="muted small">{t('pr.onDefaultBranch', { branch: st.branch })}</div>;
  } else {
    content = <CreateForm key={`${cwd}|${st.branch}`} st={st} cwd={cwd} onCreated={load} />;
  }

  const pr = st?.pr;
  const counts = pr ? checkCounts(pr.checks) : null;
  return (
    <div className="prs">
      <div className="prs-head" onClick={toggle}>
        <ChevronRight size={13} className={`prs-chev ${open ? 'is-open' : ''}`} />
        <GitPullRequest size={13} />
        <span className="prs-head-title">Pull Request</span>
        {!open && pr && (
          <span className="prs-head-sum muted small truncate">
            #{pr.number}
            {counts && pr.checks.length > 0 && (
              <CheckIcon bucket={counts.failed ? 'failed' : counts.pending ? 'pending' : 'ok'} size={11} />
            )}
          </span>
        )}
        <div className="spacer" />
        {st?.repo && open && <span className="muted small truncate prs-repo">{st.repo}</span>}
        <button
          className="icon-btn sm"
          title={t('common.refresh')}
          onClick={(e) => {
            e.stopPropagation();
            load();
          }}
        >
          <RefreshCw size={12} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="prs-body" {...collapse}>
            <div className="prs-inner">{content}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
