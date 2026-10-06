import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bug, ExternalLink, Globe, Lock, RotateCw, X } from 'lucide-react';
import type { BrowserState } from '../types';
import { useStore } from '../store';
import { t } from '../i18n';

const EMPTY: BrowserState = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };

/**
 * Built-in browser tab. The page itself is a native view owned by the main process;
 * this component draws the toolbar and keeps the view glued to the placeholder's rectangle.
 */
export function BrowserPanel({ threadId }: { threadId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserState>(EMPTY);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  // Native views draw above the DOM, so hide the page while a modal is open.
  const covered = useStore((s) => s.settingsOpen || s.overlays > 0 || Boolean(s.zoomImage));

  useEffect(() => {
    setState(EMPTY);
    const off = window.desk.onBrowserState((s) => s.key === threadId && setState(s));
    window.desk.browserState(threadId).then(setState).catch(() => {});
    return () => {
      off();
      window.desk.browserSetVisible(false);
    };
  }, [threadId]);

  useEffect(() => {
    if (!editing) setAddress(state.url);
  }, [state.url, editing]);

  useEffect(() => {
    window.desk.browserSetVisible(!covered, threadId);
  }, [covered, threadId]);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        window.desk.browserSetBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
      });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener('resize', sync);
    // The panel slides in with a spring; keep following it for a moment.
    const follow = setInterval(sync, 50);
    const stop = setTimeout(() => clearInterval(follow), 700);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
      clearInterval(follow);
      clearTimeout(stop);
      cancelAnimationFrame(raf);
    };
  }, []);

  const secure = state.url.startsWith('https://');
  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="icon-btn sm" disabled={!state.canGoBack} onClick={() => window.desk.browserControl('back', threadId)} title={t('common.back')}>
          <ArrowLeft size={14} />
        </button>
        <button className="icon-btn sm" disabled={!state.canGoForward} onClick={() => window.desk.browserControl('forward', threadId)} title={t('browser.forward')}>
          <ArrowRight size={14} />
        </button>
        <button
          className="icon-btn sm"
          onClick={() => window.desk.browserControl(state.loading ? 'stop' : 'reload', threadId)}
          title={state.loading ? t('browser.stop') : t('common.refresh')}
        >
          {state.loading ? <X size={14} /> : <RotateCw size={13} />}
        </button>
        <form
          className="browser-url"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            if (address.trim()) window.desk.browserNavigate(address.trim(), threadId);
            (document.activeElement as HTMLElement)?.blur();
          }}
        >
          {secure ? <Lock size={11} className="muted" /> : <Globe size={11} className="muted" />}
          <input
            value={address}
            placeholder={t('browser.addressPlaceholder')}
            onFocus={(e) => {
              setEditing(true);
              e.target.select();
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
          />
        </form>
        <button className="icon-btn sm" onClick={() => window.desk.browserControl('external', threadId)} title={t('browser.openExternal')}>
          <ExternalLink size={13} />
        </button>
        <button className="icon-btn sm" onClick={() => window.desk.browserControl('devtools', threadId)} title={t('browser.devtools')}>
          <Bug size={13} />
        </button>
      </div>
      {state.loading && <div className="browser-progress" />}
      <div className="browser-host" ref={hostRef}>
        
      </div>
    </div>
  );
}
