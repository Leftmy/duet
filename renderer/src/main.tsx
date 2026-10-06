import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import { App } from './App';
import { DetachedApp } from './features/detach/DetachedApp';
import { isDetachedWindow } from './features/detach/mode';
import { useStore } from './store';

// Handy for inspecting state from DevTools (Ctrl+Shift+I).
(window as any).__deskStore = useStore;

createRoot(document.getElementById('root')!).render(isDetachedWindow() ? <DetachedApp /> : <App />);
