// Vite `?url` imports of the ONNX Runtime wasm files used by whisper.worker.ts.
declare module 'onnxruntime-web/*?url' {
  const url: string;
  export default url;
}
