import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Code2, History, MessageSquareText, RotateCcw } from 'lucide-react';
import { closeDialog, useDialog } from '../lib/dialog';
import { useStore } from '../store';
import { basename } from '../lib/format';
import { spring, useOverlay } from './Popover';
import { t } from '../i18n';

const backdrop = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
const card = {
  initial: { opacity: 0, scale: 0.96, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98, y: 6 },
  transition: spring,
};

/** Generic confirm dialog driven by askConfirm(). */
export function ConfirmDialog() {
  const d = useDialog((s) => s.current);
  useOverlay(Boolean(d));
  useEffect(() => {
    if (!d) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog(false);
      if (e.key === 'Enter') closeDialog(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [d]);
  return (
    <AnimatePresence>
      {d && (
        <motion.div className="modal-backdrop" {...backdrop} onMouseDown={() => closeDialog(false)}>
          <motion.div className="modal confirm" {...card} onMouseDown={(e) => e.stopPropagation()}>
            <div className="confirm-head">
              {d.danger && (
                <span className="confirm-icon danger">
                  <AlertTriangle size={16} />
                </span>
              )}
              <h3>{d.title}</h3>
            </div>
            {d.message && <p className="confirm-text">{d.message}</p>}
            {d.details && d.details.length > 0 && (
              <div className="confirm-details">
                {d.details.map((x, i) => (
                  <div key={i} className="truncate">
                    {x}
                  </div>
                ))}
              </div>
            )}
            <div className="approval-actions">
              <button className="btn ghost" onClick={() => closeDialog(false)}>
                {d.cancelLabel ?? t('common.cancel')}
              </button>
              <button className={`btn primary ${d.danger ? 'danger' : ''}`} autoFocus onClick={() => closeDialog(true)}>
                {d.confirmLabel ?? t('common.continue')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

type Mode = 'both' | 'conversation' | 'code';
type Preview = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number } | null;

/** "Rewind to this message": conversation, code, or both — like /rewind in Claude Code. */
export function RewindDialog() {
  const dlg = useStore((s) => s.rewindDialog);
  const thread = useStore((s) => (s.rewindDialog ? s.threads[s.rewindDialog.threadId] : undefined));
  const performRewind = useStore((s) => s.performRewind);
  const [preview, setPreview] = useState<Preview>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>('both');
  const [busy, setBusy] = useState(false);
  useOverlay(Boolean(dlg));

  const entryIndex = thread && dlg ? thread.entries.findIndex((e) => e.id === dlg.entryId) : -1;
  const entry = entryIndex >= 0 ? thread!.entries[entryIndex] : undefined;
  const prevTurn = thread && entryIndex > 0 ? [...thread.entries.slice(0, entryIndex)].reverse().find((e) => e.kind === 'turn') : undefined;
  const caps = useStore((s) => (thread ? s.providers[thread.provider]?.caps : undefined));
  // Turn-based agents (Codex) can drop any number of their own turns; anchor-based ones need the previous turn's anchor.
  const conversationOk =
    Boolean(entry) && (caps?.rollback === 'turns' || entryIndex === 0 || Boolean(prevTurn && prevTurn.kind === 'turn' && prevTurn.lastUuid));
  const filesOk = caps?.rewindFiles !== false;
  const files = preview?.filesChanged ?? [];
  const codeOk = Boolean(preview?.canRewind) && files.length > 0;

  useEffect(() => {
    if (!dlg || !thread || !entry || entry.kind !== 'user' || !entry.uuid || !filesOk) {
      setPreview(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setPreview(null);
    window.desk
      .rewind({
        threadId: thread.id,
        uuid: entry.uuid,
        dryRun: true,
        config: { provider: thread.provider, cwd: thread.cwd, model: thread.model, effort: thread.effort, permissionMode: thread.permissionMode, resume: thread.sessionId },
      })
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setPreview({ canRewind: false, error: String(e?.message ?? e) }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlg?.entryId]);

  // Pick the most useful option available once we know what can be rewound.
  useEffect(() => {
    if (loading) return;
    setMode(codeOk && conversationOk ? 'both' : conversationOk ? 'conversation' : 'code');
  }, [loading, codeOk, conversationOk]);

  const close = () => useStore.setState({ rewindDialog: null });
  const options: { m: Mode; icon: typeof History; title: string; hint: string; ok: boolean }[] = [
    { m: 'both', icon: RotateCcw, title: t('dialogs.rewindBoth'), hint: t('dialogs.rewindBothHint'), ok: conversationOk && codeOk },
    { m: 'conversation', icon: MessageSquareText, title: t('dialogs.rewindConversation'), hint: t('dialogs.rewindConversationHint'), ok: conversationOk },
    { m: 'code', icon: Code2, title: t('dialogs.rewindCode'), hint: t('dialogs.rewindCodeHint'), ok: codeOk },
  ];
  const codeNote = loading
    ? t('dialogs.checkingFiles')
    : !entry?.kind || entry.kind !== 'user' || !entry.uuid
      ? t('dialogs.noSnapshot')
      : preview && !preview.canRewind
        ? t('dialogs.cannotRewindCode', { reason: preview.error ?? t('dialogs.noSnapshotReason') })
        : files.length === 0
          ? t('dialogs.noFileChanges')
          : null;

  return (
    <AnimatePresence>
      {dlg && entry && entry.kind === 'user' && (
        <motion.div className="modal-backdrop" {...backdrop} onMouseDown={close}>
          <motion.div className="modal confirm rewind" {...card} onMouseDown={(e) => e.stopPropagation()}>
            <div className="confirm-head">
              <span className="confirm-icon">
                <History size={16} />
              </span>
              <h3>{t('dialogs.rewindTitle')}</h3>
            </div>
            <div className="rewind-quote">{entry.text || t('dialogs.image')}</div>

            <div className="rewind-files">
              {codeNote ? (
                <span className={`muted small ${loading ? 'shimmer' : ''}`}>{codeNote}</span>
              ) : (
                <>
                  <div className="rewind-files-head">
                    <span>{t('dialogs.filesWillRevert')}</span>
                    <span className="step-stats">
                      <span className="add">+{preview?.insertions ?? 0}</span>
                      <span className="del">−{preview?.deletions ?? 0}</span>
                    </span>
                  </div>
                  {files.slice(0, 8).map((f) => (
                    <div key={f} className="truncate muted small" title={f}>
                      {basename(f)} <span className="rewind-path">{f}</span>
                    </div>
                  ))}
                  {files.length > 8 && <div className="muted small">{t('dialogs.andMore', { n: files.length - 8 })}</div>}
                </>
              )}
            </div>

            <div className="rewind-options">
              {options.map((o) => (
                <button key={o.m} className={`rewind-option ${mode === o.m ? 'is-on' : ''}`} disabled={!o.ok || loading} onClick={() => setMode(o.m)}>
                  <o.icon size={16} />
                  <span className="rewind-option-text">
                    <span>{o.title}</span>
                    <span className="muted small">{o.hint}</span>
                  </span>
                  <span className="radio">{mode === o.m && <span />}</span>
                </button>
              ))}
            </div>

            <div className="approval-actions">
              <button className="btn ghost" onClick={close}>
                {t('common.cancel')}
              </button>
              <button
                className="btn primary danger"
                disabled={busy || loading || !options.find((o) => o.m === mode)?.ok}
                onClick={async () => {
                  setBusy(true);
                  await performRewind(thread!.id, entry.id, mode);
                  setBusy(false);
                  close();
                }}
              >
                <RotateCcw size={13} /> {t('dialogs.rewind')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
