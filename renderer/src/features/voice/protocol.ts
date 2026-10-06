// Messages between the UI thread and whisper.worker.ts.
export type VoiceDevice = 'auto' | 'webgpu' | 'wasm';

/** Error message the worker sends when WebGPU was requested but is missing; the UI localizes it. */
export const WEBGPU_UNAVAILABLE = 'webgpu-unavailable';

export type WorkerIn =
  | { type: 'load'; device?: VoiceDevice }
  | { type: 'transcribe'; id: number; audio: Float32Array; language?: string | null };

export type WorkerOut =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; message: string };
