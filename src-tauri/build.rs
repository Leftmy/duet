use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-changed=../electron/preload.cjs");
    println!("cargo:rerun-if-changed=../desktop/window-controls.js");
    let preload = fs::read_to_string("../electron/preload.cjs").unwrap();
    let marker = "contextBridge.exposeInMainWorld('desk', ";
    let start = preload.find(marker).expect("preload API");
    let prefix = r#"(() => {
      const listeners = new Map();
      window.__duetDeliver = (channel, payload) => {
        for (const fn of [...(listeners.get(channel) || [])]) fn({}, payload);
      };
      const ipcRenderer = {
        invoke: (channel, ...args) => window.__TAURI_INTERNALS__.invoke('duet_invoke', {channel, args}),
        on: (channel, fn) => { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(fn); },
        removeListener: (channel, fn) => listeners.get(channel)?.delete(fn)
      };
      const process = {platform: __DUET_PLATFORM__};
      const webUtils = {getPathForFile: file => file.__duetPath || ''};
      const contextBridge = {exposeInMainWorld: (key, value) => {window[key] = value}};
      window.Notification = class extends EventTarget {
        static permission = 'granted';
        static requestPermission() {return Promise.resolve('granted');}
        constructor(title, options={}) {super();ipcRenderer.invoke('desk:notification',{title,body:options.body||''});}
        close() {}
      };
      const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
      const on = channel => cb => { const h = (_e, p) => cb(p); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h); };
      const FEATURE_PREFIXES = ['pr:', 'search:', 'sched:', 'voice:', 'instr:', 'fs:', 'tg:', 'win:', 'cmd:', 'desk:'];
      const allowed = ch => typeof ch === 'string' && FEATURE_PREFIXES.some(p => ch.startsWith(p));
    "#;
    let controls = fs::read_to_string("../desktop/window-controls.js").unwrap();
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("preload.js"),
        format!("{prefix}{} window.desk.nativeHistoryPaging=true; window.desk.loadSessionPage=(...args)=>ipcRenderer.invoke('agent:loadSessionPage',...args); window.desk.loadSubagentPage=(...args)=>ipcRenderer.invoke('agent:loadSubagentPage',...args); }})(); {controls}", &preload[start..]),
    )
    .unwrap();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["duet_invoke", "window_control"]),
    ))
    .unwrap();
}
