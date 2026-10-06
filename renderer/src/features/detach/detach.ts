import { useStore } from '../../store';
import { t } from '../../i18n';
import type { Thread } from '../../types';
import { ipcMessage, isDetachedWindow, type DetachInfo } from './mode';

export { isDetachedWindow } from './mode';

/**
 * Why a chat can't move to another window right now (null = it can).
 * `action` picks the wording: opening in a separate window or returning to the main one.
 */
export function detachBlocker(thread: Thread | undefined, action: 'detach' | 'return' = 'detach'): string | null {
  if (!thread) return t('detach.notFound');
  if (!thread.sessionId) return t(action === 'return' ? 'detach.emptyReturn' : 'detach.empty');
  if (thread.status === 'running' || thread.approvals.length || thread.queue.length) return t(action === 'return' ? 'detach.busyReturn' : 'detach.busy');
  if (Object.values(thread.tasks).some((x) => x.status === 'running' || x.status === 'pending')) return t('detach.tasksRunning');
  if (Object.values(thread.agents).some((a) => a.status === 'running')) return t('detach.agentsRunning');
  return null;
}

/** Moves an idle chat into its own window. Resolves true when the window was opened (or focused). */
export async function detachThread(threadId: string): Promise<boolean> {
  const { threads, toast } = useStore.getState();
  if (isDetachedWindow()) return false;
  const thread = threads[threadId];
  const blocker = detachBlocker(thread);
  if (blocker) {
    toast(blocker, 'error');
    return false;
  }
  const payload: DetachInfo = {
    threadId,
    sessionId: thread.sessionId,
    title: thread.title,
    cwd: thread.cwd,
    chain: thread.chain,
    model: thread.model,
    effort: thread.effort,
    permissionMode: thread.permissionMode,
    projectId: thread.projectId,
    draft: thread.draft || undefined,
  };
  try {
    await window.desk.call('win:detach', payload);
    return true;
  } catch (e) {
    toast(t('detach.openFailed', { error: ipcMessage(e) }), 'error');
    return false;
  }
}
