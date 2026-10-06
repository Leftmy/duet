import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2, Mic } from 'lucide-react';
import { useStore } from '../../store';
import { getLang, t } from '../../i18n';
import { decodeToMono16k, ensureModel, MAX_RECORD_MS, micErrorText, pickMimeType, rms, transcribe, useVoiceModel } from './voice';
import './voice.css';

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';

interface Props {
  onText: (text: string) => void;
  disabled?: boolean;
  /** Whisper language ('russian', 'english'…); defaults to the UI language. transformers.js has no auto-detect: null falls back to English. */
  language?: string | null;
}

const toastError = (text: string) => useStore.getState().toast(text, 'error');

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtMb(bytes: number) {
  return t('voice.mb', { n: Math.round(bytes / 1e6) });
}

/** Whisper language name for the current UI language. */
const uiSpeechLanguage = () => (getLang() === 'ru' ? 'russian' : 'english');

export function MicButton({ onText, disabled, language = uiSpeechLanguage() }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const model = useVoiceModel();
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; started: number; timer: number } | null>(null);
  const cancelled = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const release = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    window.clearInterval(r.timer);
    r.stream.getTracks().forEach((track) => track.stop());
    rec.current = null;
  }, []);

  // Unmount (thread switch etc.): drop the recording and free the mic.
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      if (rec.current?.recorder.state === 'recording') rec.current.recorder.stop();
      release();
    };
  }, [release]);

  const finish = useCallback(async (blob: Blob) => {
    setPhase('transcribing');
    try {
      const audio = await decodeToMono16k(blob);
      if (audio.length < 16000 * 0.3 || rms(audio) < 0.002) {
        useStore.getState().toast(t('voice.silence'));
        return;
      }
      const text = await transcribe(audio, language);
      if (cancelled.current) return;
      if (text) onTextRef.current(text);
      else useStore.getState().toast(t('voice.nothingRecognized'));
    } catch (e: any) {
      toastError(t('voice.transcribeFailed', { error: e?.message ?? e }));
    } finally {
      if (!cancelled.current) setPhase('idle');
    }
  }, [language]);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toastError(t('voice.unsupported'));
      return;
    }
    setPhase('starting');
    // Lazy: the model starts loading on the first click, in parallel with recording.
    ensureModel().catch((e) => toastError(t('voice.modelLoadFailed', { error: e?.message ?? e })));
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      setPhase('idle');
      toastError(micErrorText(e));
      return;
    }
    if (cancelled.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      release();
      if (cancelled.current) return;
      finish(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
    };
    recorder.onerror = () => {
      release();
      if (!cancelled.current) setPhase('idle');
      toastError(t('voice.recordError'));
    };
    const started = Date.now();
    const timer = window.setInterval(() => {
      const ms = Date.now() - started;
      setElapsed(ms);
      if (ms >= MAX_RECORD_MS && recorder.state === 'recording') recorder.stop();
    }, 250);
    rec.current = { recorder, stream, started, timer };
    setElapsed(0);
    recorder.start(1000);
    setPhase('recording');
  }, [finish, release]);

  const stop = useCallback(() => {
    const r = rec.current;
    if (r && r.recorder.state === 'recording') r.recorder.stop();
  }, []);

  const toggle = useCallback(() => {
    if (phase === 'idle') start();
    else if (phase === 'recording') stop();
  }, [phase, start, stop]);

  const wrapRef = useRef<HTMLDivElement>(null);
  useMicToggleEvent(wrapRef, toggle, !disabled || phase === 'recording');

  const downloading = model.status === 'loading' && model.total > 0 && model.loaded < model.total && phase !== 'idle';
  const pct = model.total ? Math.floor((model.loaded / model.total) * 100) : 0;
  const recording = phase === 'recording';

  const title =
    phase === 'recording'
      ? t('voice.stop')
      : phase === 'transcribing'
        ? t('voice.transcribing')
        : t('voice.start');

  return (
    <div className="voice-mic" ref={wrapRef}>
      <button
        type="button"
        className={`icon-btn voice-btn ${recording ? 'is-recording' : ''}`}
        title={title}
        disabled={(disabled && phase === 'idle') || phase === 'starting' || phase === 'transcribing'}
        onClick={toggle}
      >
        {recording ? (
          <span className="voice-rec">
            <span className="voice-dot" />
            <span className="voice-time">{fmt(elapsed)}</span>
          </span>
        ) : phase === 'transcribing' || phase === 'starting' ? (
          <Loader2 size={16} className="spin" />
        ) : (
          <Mic size={16} />
        )}
      </button>
      <AnimatePresence>
        {downloading && (
          <motion.div
            className="popover voice-pop"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }}
          >
            <div className="voice-pop-title">{t('voice.downloading', { pct })}</div>
            <div className="voice-bar">
              <div className="voice-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="muted small">
              {t('voice.downloadProgress', { loaded: fmtMb(model.loaded), total: fmtMb(model.total) })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Ctrl+M inside a composer reaches that composer's button through this (non-bubbling) event.
const TOGGLE_EVENT = 'voice:toggle';
const HOST = '.composer';

function useMicToggleEvent(wrapRef: RefObject<HTMLDivElement | null>, toggle: () => void, enabled: boolean) {
  const ref = useRef(toggle);
  ref.current = toggle;
  useEffect(() => {
    if (!enabled) return;
    const host: EventTarget = wrapRef.current?.closest(HOST) ?? window;
    const fn = () => ref.current();
    host.addEventListener(TOGGLE_EVENT, fn);
    return () => host.removeEventListener(TOGGLE_EVENT, fn);
  }, [enabled, wrapRef]);
}

/**
 * Optional Ctrl+M hotkey. Returns a keydown handler for the composer textarea:
 * `const micKey = useMicHotkey();` then `if (micKey(e)) return;` at the top of onKeyDown.
 * Returns true when the key was handled.
 */
export function useMicHotkey() {
  return useCallback((e: ReactKeyboardEvent | KeyboardEvent) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.code !== 'KeyM') return false;
    e.preventDefault();
    const target = e.target instanceof Element ? e.target.closest(HOST) : null;
    (target ?? window).dispatchEvent(new Event(TOGGLE_EVENT));
    return true;
  }, []);
}
