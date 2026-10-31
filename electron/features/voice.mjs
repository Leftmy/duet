// Voice input: lets the app window use the microphone (audio only). Speech-to-text itself runs
// in the renderer (Whisper in a Web Worker), so nothing else is needed from the main process.
import { session } from '../desktop.mjs';

// Permissions the app's own window may use; everything else is denied.
// clipboard-sanitized-write = navigator.clipboard.writeText (copy buttons).
const ALLOWED = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);

function audioOnly(details) {
  const types = details?.mediaTypes ?? [];
  return types.length > 0 && types.every((t) => t === 'audio');
}

export function register(ctx) {
  ctx.handle('voice:ping', () => true);

  ctx.app.whenReady().then(() => {
    // Only the default session (the app UI). The built-in browser uses 'persist:desk-browser' and is left alone.
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (permission === 'media') return callback(audioOnly(details));
      callback(ALLOWED.has(permission));
    });
    ses.setPermissionCheckHandler((wc, permission, origin, details) => {
      // Checks carry a single mediaType ('audio' | 'video' | 'unknown').
      if (permission === 'media') return details?.mediaType !== 'video';
      return ALLOWED.has(permission);
    });
  });
}
