// The application core runs unchanged in Electron or in the native shell's Node sidecar.
// Native execution never imports the Electron package or starts Chromium.
const runtime = process.env.DUET_DESKTOP_RUNTIME === 'native'
  ? await import('../desktop/runtime.mjs') : await import('electron');
export const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Menu, screen, session, Notification } = runtime;
