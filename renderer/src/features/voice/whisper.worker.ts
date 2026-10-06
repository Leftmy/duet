// Speech-to-text worker: Whisper via transformers.js, fully local after the first model download.
import { env, pipeline, type ProgressInfo } from '@huggingface/transformers';
// ONNX Runtime wasm files are bundled by Vite (no CDN), so the app works offline.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import { WEBGPU_UNAVAILABLE, type VoiceDevice, type WorkerIn, type WorkerOut } from './protocol';

const MODELS = ['onnx-community/whisper-base', 'Xenova/whisper-base'];

// Minimal typing for the dedicated worker scope (the project compiles against DOM libs only).
const scope = self as unknown as {
  postMessage(msg: WorkerOut): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};
const post = (msg: WorkerOut) => scope.postMessage(msg);

env.allowLocalModels = false;
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
if (onnx.wasm) {
  onnx.wasm.wasmPaths = {
    wasm: new URL(ortWasmUrl, self.location.href).href,
    mjs: new URL(ortMjsUrl, self.location.href).href,
  };
}

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

let loading: Promise<{ asr: Asr; device: 'webgpu' | 'wasm' }> | null = null;

async function hasWebGpu() {
  try {
    const gpu = (navigator as any).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function create(model: string, device: 'webgpu' | 'wasm') {
  // Aggregate per-file download progress into one number for the UI.
  const files: Record<string, { loaded: number; total: number }> = {};
  const progress_callback = (p: ProgressInfo) => {
    if (p.status !== 'progress') return;
    files[p.file] = { loaded: p.loaded, total: p.total };
    let loaded = 0;
    let total = 0;
    for (const f of Object.values(files)) {
      loaded += f.loaded;
      total += f.total;
    }
    post({ type: 'progress', loaded, total });
  };
  // WASM: int8 weights (~80 MB). WebGPU: fp32 encoder + q4 decoder (the combo HF's own demo uses).
  const dtype = device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
  const asr = await pipeline('automatic-speech-recognition', model, { device, dtype: dtype as any, progress_callback });
  return asr as unknown as Asr;
}

async function load(pref: VoiceDevice) {
  const devices: ('webgpu' | 'wasm')[] = pref === 'wasm' ? ['wasm'] : (await hasWebGpu()) ? ['webgpu', 'wasm'] : ['wasm'];
  if (pref === 'webgpu' && devices[0] !== 'webgpu') throw new Error(WEBGPU_UNAVAILABLE);
  let lastErr: unknown;
  for (const device of devices) {
    for (const model of MODELS) {
      try {
        const asr = await create(model, device);
        if (device === 'webgpu') {
          // Warm-up compiles the shaders and proves the GPU path actually works.
          await asr(new Float32Array(16000), { language: 'english', task: 'transcribe' });
        }
        return { asr, device };
      } catch (e) {
        lastErr = e;
        console.warn('[voice] load failed', model, device, e);
      }
    }
  }
  throw lastErr;
}

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

scope.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    loading ??= load(msg.device ?? 'wasm');
    try {
      const { device } = await loading;
      post({ type: 'ready', device });
    } catch (err) {
      loading = null;
      post({ type: 'error', message: errText(err) });
    }
  } else if (msg.type === 'transcribe') {
    try {
      loading ??= load('wasm');
      const { asr } = await loading;
      const out = await asr(msg.audio, {
        task: 'transcribe',
        ...(msg.language ? { language: msg.language } : {}),
        // Long recordings (up to 2 min) are split into overlapping 30 s windows.
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).replace(/\s+/g, ' ').trim();
      post({ type: 'result', id: msg.id, text });
    } catch (err) {
      post({ type: 'error', id: msg.id, message: errText(err) });
    }
  }
};
