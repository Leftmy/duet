import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { CornerDownLeft, FolderOpen, LoaderCircle, MessageSquare, Search, Sparkles, User } from 'lucide-react';
import { useStore } from '../../store';
import { basename, relativeTime } from '../../lib/format';
import { spring, useOverlay } from '../../components/Popover';
import { t } from '../../i18n';
import './search.css';

export interface SearchHit {
  sessionId: string;
  cwd: string;
  title: string;
  uuid: string;
  role: 'user' | 'assistant';
  snippet: string;
  ts: number;
  score: number;
}

interface SearchState {
  open: boolean;
  /** Last query is kept so reopening shows the previous results. */
  q: string;
  setOpen(open: boolean): void;
  setQ(q: string): void;
}

export const useSearchStore = create<SearchState>((set) => ({
  open: false,
  q: '',
  setOpen: (open) => set({ open }),
  setQ: (q) => set({ q }),
}));

export const openSearch = () => useSearchStore.getState().setOpen(true);
const closeSearch = () => useSearchStore.getState().setOpen(false);

/** Scrolls the message with this uuid into view once the thread has rendered it, and flashes it. */
/** Detail of the `desk:reveal` event the thread view answers by scrolling to the message. */
export interface RevealRequest {
  uuid: string;
  /** Session the hit belongs to; only that chat answers. */
  sessionId?: string;
  /** Snippet text, used when the uuid is not in the loaded branch of the chat. */
  text?: string;
  handled?: boolean;
}

export function revealMessage(uuid: string, text?: string, sessionId?: string) {
  if (!uuid && !text) return;
  const started = Date.now();
  const attempt = () => {
    const req: RevealRequest = { uuid, text, sessionId };
    window.dispatchEvent(new CustomEvent('desk:reveal', { detail: req }));
    if (!req.handled && Date.now() - started < 20000) setTimeout(attempt, 150);
  };
  attempt();
}

const backdrop = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
const card = {
  initial: { opacity: 0, scale: 0.96, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98, y: 6 },
  transition: spring,
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wraps every query word in <mark>; React escapes the text itself. */
function highlight(text: string, words: string[]): ReactNode {
  if (!words.length) return text;
  const re = new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi');
  const parts = text.split(re);
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>));
}

interface Group {
  sessionId: string;
  title: string;
  cwd: string;
  ts: number;
  hits: { hit: SearchHit; index: number }[];
}

function groupHits(hits: SearchHit[]): Group[] {
  const groups: Group[] = [];
  const byId = new Map<string, Group>();
  for (const hit of hits) {
    let g = byId.get(hit.sessionId);
    if (!g) {
      g = { sessionId: hit.sessionId, title: hit.title, cwd: hit.cwd, ts: hit.ts, hits: [] };
      byId.set(hit.sessionId, g);
      groups.push(g);
    }
    g.ts = Math.max(g.ts, hit.ts);
    g.hits.push({ hit, index: 0 });
  }
  // Flat indices follow the visual order so ↑/↓ walk the list top to bottom.
  let i = 0;
  for (const g of groups) for (const h of g.hits) h.index = i++;
  return groups;
}

export function SearchModal() {
  const open = useSearchStore((s) => s.open);
  const q = useSearchStore((s) => s.q);
  const setQ = useSearchStore((s) => s.setQ);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [sel, setSel] = useState(0);
  const reqId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  useOverlay(open);

  useEffect(() => {
    if (!open) return;
    const off = window.desk.subscribe<{ done: number; total: number }>('search:progress', (p) => {
      setProgress(p.done >= p.total ? null : p);
    });
    // Warm the index on open so the first real query is instant.
    if (!q.trim()) window.desk.call('search:query', { q: '', limit: 1 }).catch(() => {});
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Debounced query.
  useEffect(() => {
    if (!open) return;
    const text = q.trim();
    const id = ++reqId.current;
    if (!text) {
      setHits(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      window.desk
        .call<SearchHit[]>('search:query', { q: text, limit: 60 })
        .then((r) => {
          if (id !== reqId.current) return;
          setHits(r);
          setError(null);
          setSel(0);
        })
        .catch((e) => id === reqId.current && setError(String(e?.message ?? e)))
        .finally(() => id === reqId.current && setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, open]);

  const groups = useMemo(() => groupHits(hits ?? []), [hits]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits.map((h) => h.hit)), [groups]);
  const words = useMemo(() => [...new Set(q.trim().toLowerCase().split(/\s+/).filter(Boolean))], [q]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (hit: SearchHit) => {
    closeSearch();
    useStore.getState().openSession({ sessionId: hit.sessionId, title: hit.title, cwd: hit.cwd, lastModified: hit.ts });
    revealMessage(hit.uuid, hit.snippet, hit.sessionId);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSearch();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const onInputKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flat.length) setSel((s) => (s + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) setSel((s) => (s - 1 + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = flat[sel];
      if (hit) choose(hit);
    }
  };

  const text = q.trim();
  let body: ReactNode;
  if (error) body = <div className="search-empty">{t('search.error', { error })}</div>;
  else if (!text)
    body = (
      <div className="search-empty">
        <Search size={22} />
        <div>{t('search.introTitle')}</div>
        <div className="muted small">{t('search.introHint')}</div>
      </div>
    );
  else if (!hits)
    body = (
      <div className="search-skeleton">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton-line shimmer-bg" style={{ width: `${80 - i * 15}%` }} />
        ))}
      </div>
    );
  else if (!hits.length)
    body = (
      <div className="search-empty">
        <MessageSquare size={22} />
        <div>{t('search.noResults')}</div>
        <div className="muted small">{t('search.noResultsHint')}</div>
      </div>
    );
  else
    body = groups.map((g) => (
      <div key={g.sessionId} className="search-group">
        <div className="search-group-head">
          <span className="search-group-title truncate">{g.title}</span>
          {g.cwd && (
            <span className="search-group-proj truncate" title={g.cwd}>
              <FolderOpen size={12} />
              {basename(g.cwd)}
            </span>
          )}
          <span className="muted small search-group-time">{g.ts ? relativeTime(g.ts) : ''}</span>
        </div>
        {g.hits.map(({ hit, index }) => (
          <button
            key={hit.uuid}
            data-idx={index}
            className={`search-hit ${index === sel ? 'is-sel' : ''}`}
            onMouseMove={() => index !== sel && setSel(index)}
            onClick={() => choose(hit)}
          >
            <span className={`search-role ${hit.role}`} title={hit.role === 'user' ? t('search.you') : 'Claude'}>
              {hit.role === 'user' ? <User size={13} /> : <Sparkles size={13} />}
            </span>
            <span className="search-snippet">{highlight(hit.snippet, words)}</span>
            {index === sel && <CornerDownLeft size={13} className="search-enter" />}
          </button>
        ))}
      </div>
    ));

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop search-backdrop" {...backdrop} onMouseDown={closeSearch}>
          <motion.div className="modal search-modal" {...card} onMouseDown={(e) => e.stopPropagation()}>
            <div className="search-bar">
              {loading ? <LoaderCircle size={18} className="search-spin" /> : <Search size={18} />}
              <input
                autoFocus
                className="search-input"
                placeholder={t('search.placeholder')}
                value={q}
                spellCheck={false}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onInputKey}
                onFocus={(e) => e.currentTarget.select()}
              />
              <kbd className="search-kbd">Esc</kbd>
            </div>
            {progress && (
              <div className="search-progress">
                <span className="shimmer small">
                  {t('search.indexing', { done: progress.done, total: progress.total })}
                </span>
                <div className="search-progress-bar">
                  <motion.div
                    className="search-progress-fill"
                    animate={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                    transition={spring}
                  />
                </div>
              </div>
            )}
            <div className="search-results" ref={listRef}>
              {body}
            </div>
            {flat.length > 0 && (
              <div className="search-foot muted small">
                <span>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> {t('search.select')}
                </span>
                <span>
                  <kbd>Enter</kbd> {t('search.open')}
                </span>
                <span className="search-foot-count">
                  {t('search.footCount', { matches: t('search.matches', { count: flat.length }), chats: t('search.chats', { count: groups.length }) })}
                </span>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
