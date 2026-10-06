import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Clock3, MessageSquare, Paperclip, Plus, Square, X } from 'lucide-react';
import { MicButton, useMicHotkey } from '../features/voice/MicButton';
import { MentionMenu } from '../features/mentions/MentionMenu';
import { useMentions } from '../features/mentions/useMentions';
import { filesToMentions, insertAtCaret } from '../features/mentions/dropFiles';
import type { ImageAttachment, Thread } from '../types';
import { useStore } from '../store';
import { fileToAttachment, uid } from '../lib/format';
import { ModelPicker, PermissionPicker } from './Pickers';
import { ApprovalCard } from './ApprovalCard';
import { spring } from './Popover';
import { TasksBar } from './TasksBar';
import { ContextRing } from './ContextRing';
import { t } from '../i18n';

export function Composer({ thread, hero }: { thread: Thread; hero?: boolean }) {
  const send = useStore((s) => s.send);
  const interrupt = useStore((s) => s.interrupt);
  const setDraft = useStore((s) => s.setDraft);
  const setDraftImages = useStore((s) => s.setDraftImages);
  const removeQueued = useStore((s) => s.removeQueued);
  const commands = useStore((s) => s.commands);
  const followUp = useStore((s) => s.settings.followUp);
  const review = useStore((s) => s.review[thread.id]);
  const sendReview = useStore((s) => s.sendReview);
  const clearReview = useStore((s) => s.clearReview);
  const composerInsert = useStore((s) => s.composerInsert);
  const isActive = useStore((s) => s.activeId === thread.id);

  const [text, setText] = useState(thread.draft);
  const [images, setImages] = useState<ImageAttachment[]>(thread.draftImages);
  const [slashIdx, setSlashIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const micKey = useMicHotkey();
  const fileRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ text, images });
  latest.current = { text, images };

  const running = thread.status === 'running';
  const approval = thread.approvals[0];

  // Persist the draft when the composer unmounts (thread switch / hero → dock).
  useEffect(
    () => () => {
      setDraft(thread.id, latest.current.text);
      setDraftImages(thread.id, latest.current.images);
    },
    [thread.id, setDraft, setDraftImages],
  );

  useEffect(() => {
    if (!approval) taRef.current?.focus();
  }, [thread.id, approval]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    ta.style.height = Math.min(ta.scrollHeight, 260) + 'px';
  }, [text]);

  // Text pushed from other panels (terminal output, etc.) lands at the end of the draft.
  const lastInsert = useRef(composerInsert?.seq ?? 0);
  useEffect(() => {
    if (!composerInsert || composerInsert.seq === lastInsert.current || !isActive) return;
    lastInsert.current = composerInsert.seq;
    setText((t) => (t.trim() ? t.replace(/\s*$/, '\n\n') : '') + composerInsert.text);
    taRef.current?.focus();
  }, [composerInsert, isActive]);

  const slash = useMemo(() => {
    const m = text.match(/^\/(\S*)$/);
    if (!m) return [];
    const q = m[1].toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [text, commands]);

  const mention = useMentions({ cwd: thread.cwd, text, setText, taRef, blocked: slash.length > 0 });

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    const added = await Promise.all(list.map(fileToAttachment));
    setImages((cur) => [...cur, ...added.map((a) => ({ ...a, id: uid() }))]);
  };

  /** Images become attachments; any other file or folder is inserted as a mention at the caret. */
  const addAnyFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    const isImg = (f: File) => f.type.startsWith('image/');
    if (list.some(isImg)) addFiles(list.filter(isImg));
    const other = list.filter((f) => !isImg(f));
    if (!other.length) return;
    const snippet = await filesToMentions(other, thread.cwd);
    if (!snippet) return;
    const ta = taRef.current;
    const next = insertAtCaret(ta, ta?.value ?? latest.current.text, snippet);
    mention.placeCaret(next.caret);
    setText(next.value);
    ta?.focus();
  };

  const hasFiles = (dt: DataTransfer) => Array.from(dt.types).includes('Files');

  const submit = () => {
    if (!text.trim() && !images.length) return;
    send(thread.id, text, images);
    setText('');
    setImages([]);
  };

  const canSend = text.trim().length > 0 || images.length > 0;

  return (
    <div className="composer-stack">
      <TasksBar thread={thread} />
      <AnimatePresence initial={false}>
        {review && review.length > 0 && (
          <motion.div className="review-bar" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <MessageSquare size={13} />
            <span>
              {t('composer.reviewComments', { count: review.length })}
            </span>
            <span className="spacer" />
            <button className="btn ghost" onClick={() => clearReview(thread.id)}>
              {t('composer.clear')}
            </button>
            <button className="btn primary" onClick={() => sendReview(thread.id)}>
              {t('composer.sendToClaude')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {thread.queue.map((q) => (
          <motion.div
            key={q.id}
            className="queued"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={spring}
          >
            <Clock3 size={13} />
            <span className="queued-text">{q.text || t('composer.image')}</span>
            <span className="muted">{t('composer.queued')}</span>
            <button className="icon-btn sm" onClick={() => removeQueued(thread.id, q.id)}>
              <X size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>

      <AnimatePresence mode="popLayout">
        {approval && <ApprovalCard key={approval.reqId} threadId={thread.id} approval={approval} cwd={thread.cwd} />}
      </AnimatePresence>

      <div
        className={`composer ${hero ? 'composer-hero' : ''} ${dragOver ? 'is-drag' : ''}`}
        onDragOver={(e) => {
          // Plain text drags (e.g. moving a selection) keep the native textarea behavior.
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={(e) => {
          setDragOver(false);
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          if (e.dataTransfer.files.length) addAnyFiles(e.dataTransfer.files);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) taRef.current?.focus();
        }}
      >
        <AnimatePresence>
          {slash.length > 0 && (
            <motion.div
              key="slash"
              className="slash-menu"
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4 }}
              transition={spring}
            >
              {slash.map((c, i) => (
                <button
                  key={c.name}
                  className={`slash-item ${i === slashIdx % slash.length ? 'is-active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setText(`/${c.name} `);
                  }}
                >
                  <span className="slash-name">/{c.name}</span>
                  <span className="slash-desc">{c.description}</span>
                </button>
              ))}
            </motion.div>
          )}
          {mention.open && (
            <MentionMenu key="mentions" items={mention.items} idx={mention.idx} loading={mention.loading} onPick={mention.pick} onHover={mention.setIdx} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {dragOver && (
            <motion.div className="mention-drop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
              <Paperclip size={15} />
              {t('composer.dropFiles')}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {images.length > 0 && (
            <motion.div className="attachments" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
              {images.map((img) => (
                <div className="thumb" key={img.id}>
                  <img src={`data:${img.mediaType};base64,${img.data}`} alt="" />
                  <button className="thumb-x" onClick={() => setImages((cur) => cur.filter((x) => x.id !== img.id))}>
                    <X size={11} />
                  </button>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <textarea
          ref={taRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={
            running
              ? followUp === 'steer'
                ? t('composer.placeholderSteer')
                : t('composer.placeholderQueue')
              : t('composer.placeholder')
          }
          onChange={(e) => {
            setText(e.target.value);
            setSlashIdx(0);
          }}
          onSelect={mention.sync}
          onFocus={mention.sync}
          onBlur={mention.sync}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (!files.length) return;
            const hasImage = files.some((f) => f.type.startsWith('image/'));
            // Non-image files alongside real text: let the text paste through.
            if (!hasImage && e.clipboardData.getData('text/plain').trim()) return;
            e.preventDefault();
            addAnyFiles(files);
          }}
          onKeyDown={(e) => {
            if (micKey(e)) return;
            if (mention.onKeyDown(e)) return;
            if (slash.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setSlashIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : slash.length - 1)) % slash.length);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                setText(`/${slash[slashIdx % slash.length].name} `);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape' && running) {
              e.preventDefault();
              interrupt(thread.id);
            }
          }}
        />

        <div className="composer-bar">
          <button className="icon-btn" title={t('composer.attachImage')} onClick={() => fileRef.current?.click()}>
            <Plus size={17} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <PermissionPicker thread={thread} />
          <div className="spacer" />
          <MicButton
            disabled={!!approval}
            onText={(t) => {
              setText((cur) => (cur.trim() ? cur.replace(/\s*$/, ' ') : '') + t);
              taRef.current?.focus();
            }}
          />
          <ContextRing thread={thread} />
          <ModelPicker thread={thread} />
          <AnimatePresence mode="wait" initial={false}>
            {running && !canSend ? (
              <motion.button
                key="stop"
                className="send-btn is-stop"
                title={t('composer.stop')}
                onClick={() => interrupt(thread.id)}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                transition={spring}
              >
                <Square size={11} fill="currentColor" />
              </motion.button>
            ) : (
              <motion.button
                key="send"
                className="send-btn"
                disabled={!canSend}
                title={t('composer.send')}
                onClick={submit}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                transition={spring}
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
