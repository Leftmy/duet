import { memo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, Check, ChevronRight, FileText, Square, SquareTerminal, X } from 'lucide-react';
import type { BgTask, Thread } from '../types';
import { useStore } from '../store';
import { duration } from '../lib/format';
import { useNow } from '../lib/hooks';
import { collapse } from './ToolRow';
import { spring } from './Popover';
import { t } from '../i18n';

const isRunning = (task: BgTask) => task.status === 'running' || task.status === 'pending' || task.status === 'paused';

const TaskRow = memo(function TaskRow({ threadId, task }: { threadId: string; task: BgTask }) {
  const stopTask = useStore((s) => s.stopTask);
  const dismiss = useStore((s) => s.dismissTask);
  const running = isRunning(task);
  const now = useNow(running);
  const [output, setOutput] = useState<{ text: string; truncated: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const shell = /bash|shell/i.test(task.type ?? '');
  const Icon = shell ? SquareTerminal : Bot;
  const failed = task.status === 'failed' || task.status === 'killed' || task.status === 'stopped';

  const toggleOutput = async () => {
    if (open) return setOpen(false);
    if (task.outputFile && !output) setOutput(await window.desk.taskOutput(task.outputFile));
    setOpen(true);
  };

  const meta = [
    duration((task.endedAt ?? now) - task.startedAt),
    task.toolUses ? t('tasks.steps', { count: task.toolUses }) : null,
    running ? task.lastTool : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <motion.div className="task" layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={spring}>
      <div className="task-row">
        <span className={`task-state ${running ? 'is-running' : failed ? 'is-failed' : 'is-done'}`}>
          {running ? <span className="task-spinner" /> : failed ? <X size={11} strokeWidth={3} /> : <Check size={11} strokeWidth={3} />}
        </span>
        <Icon size={14} className="muted" />
        <span className={`task-desc truncate ${running ? 'shimmer' : ''}`} title={task.description}>
          {task.description}
        </span>
        <span className="task-meta truncate">{meta}</span>
        <div className="spacer" />
        {(task.summary || task.outputFile) && (
          <button className={`pill sm ${open ? 'is-on' : ''}`} onClick={toggleOutput}>
            <FileText size={12} />
            {t('tasks.output')}
            <ChevronRight size={12} className={`task-chevron ${open ? 'is-open' : ''}`} />
          </button>
        )}
        {running ? (
          <button className="pill sm tone-danger" title={t('tasks.stopTask')} onClick={() => stopTask(threadId, task.id)}>
            <Square size={10} fill="currentColor" />
            {t('tasks.stop')}
          </button>
        ) : (
          <button className="icon-btn sm" title={t('common.hide')} onClick={() => dismiss(threadId, task.id)}>
            <X size={12} />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="task-output" {...collapse}>
            {task.summary && <div className="task-summary">{task.summary}</div>}
            {output && (
              <pre className="detail-out">
                {output.truncated ? '…\n' : ''}
                {output.text}
              </pre>
            )}
            {task.outputFile && (
              <button className="side-more" onClick={() => window.desk.openPath(task.outputFile!)}>
                {t('tasks.openOutputFile')}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
});

export function TasksBar({ thread }: { thread: Thread }) {
  const [collapsed, setCollapsed] = useState(false);
  const tasks = Object.values(thread.tasks)
    .filter((x) => x.background && !x.dismissed)
    .sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || b.startedAt - a.startedAt);
  if (!tasks.length) return null;
  const running = tasks.filter(isRunning).length;
  return (
    <motion.div className="tasks" layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <button className="tasks-head" onClick={() => setCollapsed((v) => !v)}>
        <ChevronRight size={13} className={`task-chevron ${collapsed ? '' : 'is-open'}`} />
        <span>{t('tasks.title')}</span>
        <span className="muted">{running ? t('tasks.running', { count: running }) : t('tasks.allDone')}</span>
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div className="tasks-list" {...collapse}>
            <AnimatePresence initial={false}>
              {tasks.map((task) => (
                <TaskRow key={task.id} threadId={thread.id} task={task} />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
