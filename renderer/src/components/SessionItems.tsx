import { useCallback, useState } from 'react';
import { motion } from 'motion/react';
import { ListTree, Play, Sparkle, X } from 'lucide-react';
import type { Thread, ToolItem } from '../types';
import { useStore } from '../store';
import { MenuItem, Popover } from './Popover';
import { t } from '../i18n';

export const CHAPTER_TOOL = 'mcp__ccd_session__mark_chapter';
export const TASK_TOOL = 'mcp__ccd_session__spawn_task';
export const DISMISS_TOOL = 'mcp__ccd_session__dismiss_task';
export const isSessionTool = (name: string) => name.startsWith('mcp__ccd_session__');

/** Divider for a chapter Claude marked with mark_chapter. */
export function ChapterRow({ item }: { item: ToolItem }) {
  const title = String(item.input?.title ?? '');
  if (!title) return null;
  return (
    <div className="chapter" id={`chapter-${item.id}`} title={item.input?.summary}>
      <span className="chapter-line" />
      <span className="chapter-title">{title}</span>
      <span className="chapter-line" />
    </div>
  );
}

/** Suggested follow-up task (spawn_task) with a one-click start in a new chat. */
export function TaskCard({ item }: { item: ToolItem }) {
  const startTaskChat = useStore((s) => s.startTaskChat);
  const cwd = useStore((s) => s.threads[s.activeId]?.cwd);
  const taskId = item.result?.match(/task_[\w-]+/)?.[0];
  const dismissed = useStore((s) => {
    const th = s.threads[s.activeId];
    if (!th || !taskId) return false;
    return th.entries.some((e) => e.kind === 'turn' && e.items.some((x) => x.kind === 'tool' && x.name === DISMISS_TOOL && x.input?.task_id === taskId));
  });
  const [hidden, setHidden] = useState(false);
  if (dismissed || hidden || !item.input?.title) return null;
  return (
    <motion.div className="task-card" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <Sparkle size={14} className="task-card-icon" />
      <div className="task-card-body">
        <div className="task-card-title">{item.input.title}</div>
        {item.input.tldr && <div className="muted small">{item.input.tldr}</div>}
      </div>
      <button className="btn primary" onClick={() => startTaskChat(item.input.prompt, item.input.cwd || cwd)}>
        <Play size={12} /> {t('session.startInNewChat')}
      </button>
      <button className="icon-btn sm" title={t('common.hide')} onClick={() => setHidden(true)}>
        <X size={12} />
      </button>
    </motion.div>
  );
}

export function chaptersOf(thread: Thread) {
  const out: { id: string; title: string; summary?: string }[] = [];
  for (const e of thread.entries) {
    if (e.kind !== 'turn') continue;
    for (const it of e.items) if (it.kind === 'tool' && it.name === CHAPTER_TOOL && it.input?.title) out.push({ id: it.id, title: it.input.title, summary: it.input.summary });
  }
  return out;
}

/** Table of contents built from the chat's chapters. */
export function ChaptersMenu({ thread }: { thread: Thread }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const chapters = chaptersOf(thread);
  if (!chapters.length) return null;
  return (
    <Popover
      open={open}
      onClose={close}
      side="bottom"
      align="right"
      width={300}
      trigger={() => (
        <button className={`icon-btn ${open ? 'is-on' : ''}`} title={t('session.contents')} onClick={() => setOpen((v) => !v)}>
          <ListTree size={15} />
        </button>
      )}
    >
      <div className="menu-title">{t('session.chapters')}</div>
      <div className="menu-scroll">
        {chapters.map((c, i) => (
          <MenuItem
            key={c.id}
            icon={<span className="toc-num">{i + 1}</span>}
            label={c.title}
            hint={c.summary}
            onClick={() => {
              setOpen(false);
              document.getElementById(`chapter-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          />
        ))}
      </div>
    </Popover>
  );
}
