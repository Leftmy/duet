// UI-thread side of voice input: worker lifecycle, model state, recording helpers.
import { create } from 'zustand';
import { t } from '../../i18n';
import { WEBGPU_UNAVAILABLE, type VoiceDevice, type WorkerIn, type WorkerOut } from './protocol';

/** 'wasm' = int8 CPU model (~80 MB, works everywhere). 'auto' tries WebGPU first (~200 MB download). */
export const VOICE_DEVICE: VoiceDevice = 'wasm';
export const MAX_RECORD_MS = 2 * 60 * 1000;

type ModelStatus = 'idle' | 'loading' | 'ready' | 'error';

interface VoiceModelState {
  status: ModelStatus;
  loaded: number;
  total: number;
  device: 'webgpu' | 'wasm' | null;
}

/** Shared between every MicButton instance (hero + docked composer). */
export const useVoiceModel = create<VoiceModelState>(() => ({ status: 'idle', loaded: 0, total: 0, device: null }));

let worker: Worker | null = null;
let loadPromise: Promise<void> | null = null;
let loadResolve: (() => void) | null = null;
let loadReject: ((e: Error) => void) | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WorkerOut>) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      useVoiceModel.setState({ loaded: msg.loaded, total: msg.total });
    } else if (msg.type === 'ready') {
      useVoiceModel.setState({ status: 'ready', device: msg.device });
      loadResolve?.();
    } else if (msg.type === 'result') {
      pending.get(msg.id)?.resolve(msg.text);
      pending.delete(msg.id);
    } else if (msg.type === 'error') {
      const err = new Error(msg.message === WEBGPU_UNAVAILABLE ? t('voice.webgpuUnavailable') : msg.message);
      if (msg.id != null) {
        pending.get(msg.id)?.reject(err);
        pending.delete(msg.id);
      } else {
        useVoiceModel.setState({ status: 'error' });
        loadPromise = null;
        loadReject?.(err);
      }
    }
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || t('voice.workerCrashed'));
    useVoiceModel.setState({ status: 'error' });
    loadPromise = null;
    loadReject?.(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

const send = (msg: WorkerIn, transfer: Transferable[] = []) => getWorker().postMessage(msg, transfer);

/** Starts (once) loading the Whisper model; resolves when it is ready. */
export function ensureModel(): Promise<void> {
  if (loadPromise) return loadPromise;
  if (useVoiceModel.getState().status === 'ready') return Promise.resolve();
  useVoiceModel.setState({ status: 'loading', loaded: 0, total: 0 });
  loadPromise = new Promise<void>((resolve, reject) => {
    loadResolve = resolve;
    loadReject = reject;
  });
  loadPromise.catch(() => {});
  send({ type: 'load', device: VOICE_DEVICE });
  return loadPromise;
}

/** Mono 16 kHz samples → text. */
export async function transcribe(audio: Float32Array, language: string | null): Promise<string> {
  await ensureModel();
  const id = ++seq;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'transcribe', id, audio, language }, [audio.buffer]);
  });
}

/** Decodes a recorded blob (webm/opus) into mono Float32 at 16 kHz. */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i];
    }
    for (let i = 0; i < out.length; i++) out[i] /= buf.numberOfChannels;
    return out;
  } finally {
    ctx.close().catch(() => {});
  }
}

/** Root-mean-square level; used to skip near-silent clips (Whisper hallucinates on silence). */
export function rms(audio: Float32Array) {
  let sum = 0;
  for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / Math.max(1, audio.length));
}

export function pickMimeType() {
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/** Human-readable reason for getUserMedia / MediaRecorder failures. */
export function micErrorText(e: any) {
  const name = e?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return t('voice.micDenied');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('voice.micNotFound');
  if (name === 'NotReadableError') return t('voice.micBusy');
  return t('voice.micError', { error: e?.message ?? e });
}
