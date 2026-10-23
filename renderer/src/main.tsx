import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import { App } from './App';
import { DetachedApp } from './features/detach/DetachedApp';
import { isDetachedWindow } from './features/detach/mode';
import { useStore } from './store';
import { UIBoundary } from './components/UIBoundary';

// Handy for inspecting state from DevTools (Ctrl+Shift+I).
(window as any).__deskStore = useStore;

const report = (error: { message?: string; stack?: string }) => window.desk.call('desk:ui-error', error).catch(() => {});
window.addEventListener('error', (e) => { if (e.message) report({ message: e.message, stack: e.error?.stack }); });
window.addEventListener('unhandledrejection', (e) => report({ message: String(e.reason?.message ?? e.reason), stack: e.reason?.stack }));

createRoot(document.getElementById('root')!).render(<UIBoundary>{isDetachedWindow() ? <DetachedApp /> : <App />}</UIBoundary>);
