import { memo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Brain, Check, ChevronRight, Copy, CornerDownRight, GitFork, History, Info, OctagonX } from 'lucide-react';
import { useStore } from '../store';
import type { Item, NoticeItem, TextItem, ThinkingItem, Turn, UserEntry } from '../types';
import { duration } from '../lib/format';
import { useNow, useSmoothText } from '../lib/hooks';
import { Markdown } from './Markdown';
import { ToolRow, collapse } from './ToolRow';
import { AgentEventRow, AgentMessageCard, AgentRow, AgentSendRow } from './Agents';
import { toolKind } from '../lib/tools';
import { CHAPTER_TOOL, ChapterRow, DISMISS_TOOL, TASK_TOOL, TaskCard } from './SessionItems';
import { t } from '../i18n';

const enter = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const },
};

function StreamText({ item, live }: { item: TextItem; live: boolean }) {
  const text = useSmoothText(item.text, live && !item.confirmed);
  return <Markdown text={text} />;
}

function Thinking({ item, live }: { item: ThinkingItem; live: boolean }) {
  const [open, setOpen] = useState(false);
  const active = live && !item.endedAt;
  const now = useNow(active);
  const ms = (item.endedAt ?? now) - item.startedAt;
  const label = active ? t('turn.thinking') : ms > 900 ? t('turn.thoughtFor', { time: duration(ms) }) : t('turn.thoughts');
  const hasText = item.text.trim().length > 0;
  return (
    <div className={`step ${open ? 'is-open' : ''}`}>
      <button className="step-row" onClick={() => hasText && setOpen((v) => !v)} disabled={!hasText}>
        <Brain size={14} className="step-icon" />
        <span className={`step-text ${active ? 'shimmer' : ''}`}>{label}</span>
        {hasText && <ChevronRight size={13} className="step-chevron" />}
      </button>
      <AnimatePresence initial={false}>
        {open && hasText && (
          <motion.div className="step-details" {...collapse}>
            <div className="thinking-text">
              <Markdown text={item.text} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Notice({ item }: { item: NoticeItem }) {
  const Icon = item.tone === 'error' ? OctagonX : item.tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`notice notice-${item.tone}`}>
      <Icon size={14} />
      <span>{item.text}</span>
    </div>
  );
}

export const ItemView = memo(function ItemView({ item, live, cwd }: { item: Item; live: boolean; cwd: string }) {
  switch (item.kind) {
    case 'text':
      return <StreamText item={item} live={live} />;
    case 'thinking':
      return <Thinking item={item} live={live} />;
    case 'tool':
      if (item.name === CHAPTER_TOOL) return <ChapterRow item={item} />;
      if (item.name === TASK_TOOL) return <TaskCard item={item} />;
      if (item.name === DISMISS_TOOL) return null;
      if (toolKind(item.name) === 'agent') return <AgentRow item={item} />;
      if (item.name === 'SendMessage') return <AgentSendRow item={item} />;
      return <ToolRow item={item} cwd={cwd} />;
    case 'notice':
      return <Notice item={item} />;
    case 'agentmsg':
      return <AgentMessageCard item={item} />;
    case 'agentevent':
      return <AgentEventRow item={item} />;
    case 'steer':
      return (
        <div className="steer-row">
          <div className="steer-bubble">
            <div className="steer-label">
              <CornerDownRight size={12} />
              {item.delivered ? t('turn.steerDelivered') : t('turn.steerPending')}
            </div>
            {item.images && item.images.length > 0 && (
              <div className="bubble-images">
                {item.images.map((img) => (
                  <img key={img.id} src={`data:${img.mediaType};base64,${img.data}`} alt="" />
                ))}
              </div>
            )}
            {item.text && <div className="bubble-text">{item.text}</div>}
          </div>
        </div>
      );
  }
});

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="icon-btn sm"
      title={t('common.copy')}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1400);
      }}
    >
      {ok ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function splitTrailing(items: Item[]) {
  let i = items.length;
  while (i > 0 && (items[i - 1].kind === 'text' || items[i - 1].kind === 'notice' || items[i - 1].kind === 'agentevent')) i--;
  return { steps: items.slice(0, i), tail: items.slice(i) };
}

export const TurnView = memo(function TurnView({ turn, threadId, cwd, activity }: { turn: Turn; threadId: string; cwd: string; activity?: string }) {
  const canFork = useStore((s) => s.providers[s.threads[threadId]?.provider]?.caps?.fork !== false);
  const [expanded, setExpanded] = useState(false);
  const live = !turn.done;
  const split = splitTrailing(turn.items);
  // Chapters and task suggestions stay visible even when the turn's steps are collapsed.
  const pinned = (x: Item) => x.kind === 'tool' && (x.name === CHAPTER_TOOL || x.name === TASK_TOOL);
  const steps = split.steps.filter((x) => !pinned(x));
  const tail = split.tail;
  const chapters = split.steps.filter((x) => x.kind === 'tool' && x.name === CHAPTER_TOOL);
  const tasks = split.steps.filter((x) => x.kind === 'tool' && x.name === TASK_TOOL);
  const collapsible = turn.done && steps.length > 0;
  const last = turn.items[turn.items.length - 1];
  const busy =
    live &&
    !(last?.kind === 'text' && !last.confirmed) &&
    !(last?.kind === 'tool' && last.status === 'running') &&
    !(last?.kind === 'thinking' && !last.endedAt);
  const finalText = tail
    .filter((x): x is TextItem => x.kind === 'text')
    .map((x) => x.text)
    .join('\n\n');

  const workedLabel = turn.durationMs
    ? t('turn.workedFor', { time: duration(turn.durationMs) })
    : t('turn.stepsDone', { count: steps.filter((s) => s.kind === 'tool').length || steps.length });

  return (
    <motion.div className="turn" data-entry={turn.id} {...enter}>
      {collapsible ? (
        <>
          {chapters.map((it) => (
            <ItemView key={it.id} item={it} live={false} cwd={cwd} />
          ))}
          <button className={`worked ${expanded ? 'is-open' : ''}`} onClick={() => setExpanded((v) => !v)}>
            <span>{workedLabel}</span>
            <ChevronRight size={13} className="step-chevron" />
          </button>
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div className="worked-body" {...collapse}>
                <div className="items">
                  {steps.map((it) => (
                    <ItemView key={it.id} item={it} live={false} cwd={cwd} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="worked-rule" />
          <div className="items">
            {tail.map((it) => (
              <ItemView key={it.id} item={it} live={false} cwd={cwd} />
            ))}
            {tasks.map((it) => (
              <ItemView key={it.id} item={it} live={false} cwd={cwd} />
            ))}
          </div>
        </>
      ) : (
        <div className="items">
          {turn.items.map((it) => (
            <motion.div key={it.id} {...enter}>
              <ItemView item={it} live={live} cwd={cwd} />
            </motion.div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {busy && (
          <motion.div className="step busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <span className="step-text shimmer">{activity ?? t('turn.thinking')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {turn.error && (
        <div className="notice notice-error">
          <OctagonX size={14} />
          <span>{turn.error}</span>
        </div>
      )}
      {turn.interrupted && (
        <div className="notice notice-warn">
          <AlertTriangle size={14} />
          <span>{t('turn.stopped')}</span>
        </div>
      )}
      {turn.done && finalText && (
        <div className="turn-actions">
          <CopyBtn text={finalText} />
          {turn.lastUuid && canFork && (
            <button
              className="icon-btn sm"
              title={t('turn.forkHere')}
              onClick={() => useStore.getState().forkFrom(threadId, turn.lastUuid)}
            >
              <GitFork size={13} />
            </button>
          )}
          {turn.durationMs != null && !collapsible && <span className="muted">{duration(turn.durationMs)}</span>}
        </div>
      )}
    </motion.div>
  );
});

function SummaryCard({ entry }: { entry: UserEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div className="summary-card" data-entry={entry.id} {...enter}>
      <button className={`worked ${open ? 'is-open' : ''}`} onClick={() => setOpen((v) => !v)}>
        <History size={13} />
        <span>{t('turn.summaryTitle')}</span>
        <ChevronRight size={13} className="step-chevron" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div {...collapse} style={{ overflow: 'hidden' }}>
            <div className="summary-body">
              <Markdown text={entry.text.replace(/^This session is being continued[^\n]*\n(The summary below[^\n]*\n)?/i, '')} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export const UserBubble = memo(function UserBubble({ entry, threadId }: { entry: UserEntry; threadId: string }) {
  if (entry.summary) return <SummaryCard entry={entry} />;
  return <UserMessage entry={entry} threadId={threadId} />;
});

const UserMessage = memo(function UserMessage({ entry, threadId }: { entry: UserEntry; threadId: string }) {
  const openRewind = useStore((s) => s.openRewind);
  const canRewind = useStore((s) => s.providers[s.threads[threadId]?.provider]?.caps?.rollback !== false);
  return (
    <motion.div className="user-row" data-entry={entry.id} {...enter}>
      <div className="user-actions">
        {entry.text && <CopyBtn text={entry.text} />}
        {canRewind && (entry.uuid || entry.text) && (
          <button
            className="icon-btn sm"
            title={t('turn.rewindHere')}
            onClick={() => openRewind(threadId, entry.id)}
          >
            <History size={13} />
          </button>
        )}
      </div>
      <div className="user-bubble">
        {entry.images && entry.images.length > 0 && (
          <div className="bubble-images">
            {entry.images.map((img) => (
              <img
                key={img.id}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt=""
                onClick={() => useStore.setState({ zoomImage: `data:${img.mediaType};base64,${img.data}` })}
              />
            ))}
          </div>
        )}
        {entry.text && <div className="bubble-text">{entry.text}</div>}
      </div>
    </motion.div>
  );
});
