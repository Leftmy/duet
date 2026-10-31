import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bug, ExternalLink, Globe, Lock, MoreHorizontal, Moon, Pin, Plus, RotateCw, X } from 'lucide-react';
import type { BrowserState } from '../types';
import { useStore } from '../store';
import { askConfirm, useDialog } from '../lib/dialog';
import { MenuItem, Popover } from './Popover';
import { t } from '../i18n';

const EMPTY: BrowserState = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };

/** Native pages are disposable; the Rust tab manager owns their identity and lifetime. */
export function BrowserPanel({ threadId }: { threadId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const owner = useRef(threadId);
  owner.current = threadId;
  const revision = useRef(0);
  const [state, setState] = useState<BrowserState>(EMPTY);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const native = window.desk.nativeHistoryPaging === true;
  const idle = useStore((s) => s.settings.browserIdleMinutes);
  const dialog = useDialog((s) => Boolean(s.current));
  const covered = useStore((s) => s.settingsOpen || s.overlays > 0 || Boolean(s.zoomImage));

  useEffect(() => {
    let alive = true;
    setState(EMPTY); setError(''); setNotice(''); setEditing(false); setMenu(false);
    const initial = revision.current;
    const off = window.desk.onBrowserState((s) => {
      if (alive && s.key === threadId) { revision.current++; setState(s); }
    });
    window.desk.browserState(threadId).then((s) => {
      if (alive && revision.current === initial) setState(s);
    }).catch(() => {});
    return () => { alive = false; off(); window.desk.browserSetVisible(false, threadId).catch(() => {}); };
  }, [threadId]);

  useEffect(() => { if (!editing) setAddress(state.url); }, [state.url, state.activeTabId, editing]);
  useEffect(() => {
    window.desk.browserSetVisible(!covered && !dialog, threadId).catch((e) => {
      if (owner.current === threadId) setError(String(e));
    });
  }, [covered, dialog, threadId]);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        window.desk.browserSetBounds({ x: r.left, y: r.top, width: r.width, height: r.height }).catch(() => {});
      });
    };
    sync();
    const ro = new ResizeObserver(sync); ro.observe(el);
    window.addEventListener('resize', sync);
    const follow = setInterval(sync, 50);
    const stop = setTimeout(() => clearInterval(follow), 700);
    return () => { ro.disconnect(); window.removeEventListener('resize', sync); clearInterval(follow); clearTimeout(stop); cancelAnimationFrame(raf); };
  }, [threadId]);

  const run = async (action: string, tabId = state.activeTabId, extra: Record<string, unknown> = {}) => {
    const key = threadId;
    const before = revision.current;
    setError(''); setNotice('');
    try {
      const result = native
        ? await window.desk.browserControl({ action, tabId, ...extra }, key)
        : await window.desk.browserControl(action as 'back', key);
      if (owner.current !== key) return;
      if (revision.current === before) setState(result);
      if (result.sleepReport) setNotice(t('browser.sleepReport', result.sleepReport));
      if (action === 'new-tab') { setEditing(true); setAddress(''); addressRef.current?.focus(); }
    } catch (e) {
      if (owner.current !== key) return;
      const message = String(e);
      if (['sleep-tab', 'close-tab'].includes(action) && !extra.force && (message.includes('Protected tab:') || message.includes('sleep skipped'))) {
        const ok = await askConfirm({ title: t(action === 'close-tab' ? 'browser.closeTab' : 'browser.sleepTab'), message: t('browser.protectedWarning'), confirmLabel: t('browser.force'), danger: true });
        if (ok && owner.current === key) await run(action, tabId, { ...extra, force: true });
      } else setError(message);
    }
  };

  const tabs = state.tabs ?? [];
  const selectTab = (id: string) => { setEditing(false); void run('select-tab', id); };
  const secure = state.url.startsWith('https://');
  return (
    <div className="browser" onKeyDown={(e) => {
      if (!native || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key.toLowerCase() === 't') { e.preventDefault(); void run('new-tab'); }
      if (e.key.toLowerCase() === 'w') { e.preventDefault(); void run('close-tab'); }
      if (e.key === 'Tab' && tabs.length > 1) { e.preventDefault(); const i = tabs.findIndex((tab) => tab.id === state.activeTabId); selectTab(tabs[(i + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length].id); }
    }}>
      {native && <div className="browser-tabbar">
        <div className="browser-tabs" role="tablist" aria-label={t('browser.tabs')}>
          {tabs.map((tab) => <div key={tab.id} className={`browser-tab ${tab.id === state.activeTabId ? 'active' : ''} ${tab.sleeping ? 'sleeping' : ''}`} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void run('close-tab', tab.id); } }}>
            <button role="tab" aria-selected={tab.id === state.activeTabId} title={`${tab.title || tab.url}${tab.sleeping ? ` · ${t('browser.sleeping')}` : ''}`} onClick={() => selectTab(tab.id)}>
              {tab.pinned ? <Pin size={11} /> : tab.sleeping ? <Moon size={12} /> : <Globe size={12} className={tab.loading ? 'browser-tab-loading' : ''} />}
              <span>{tab.title || (tab.url === 'about:blank' ? t('browser.newTab') : tab.url) || t('browser.newTab')}</span>
            </button>
            <button className="browser-tab-close" title={t('browser.closeTab')} aria-label={t('browser.closeTab')} onClick={() => void run('close-tab', tab.id)}><X size={12} /></button>
          </div>)}
        </div>
        <button className="icon-btn sm" aria-label={t('browser.newTab')} title={t('browser.newTab')} disabled={tabs.length >= 32} onClick={() => void run('new-tab')}><Plus size={14} /></button>
      </div>}
      <div className="browser-bar">
        <button className="icon-btn sm" disabled={!state.canGoBack} onClick={() => void run('back')} title={t('common.back')}><ArrowLeft size={14} /></button>
        <button className="icon-btn sm" disabled={!state.canGoForward} onClick={() => void run('forward')} title={t('browser.forward')}><ArrowRight size={14} /></button>
        <button className="icon-btn sm" onClick={() => void run(state.sleeping ? 'wake-tab' : state.loading ? 'stop' : 'reload')} title={state.sleeping ? t('browser.wake') : state.loading ? t('browser.stop') : t('common.refresh')}>
          {state.loading ? <X size={14} /> : <RotateCw size={13} />}
        </button>
        <form className="browser-url" onSubmit={(e) => {
          e.preventDefault(); setEditing(false); setError('');
          if (address.trim()) window.desk.browserNavigate(address.trim(), threadId).catch((err) => { if (owner.current === threadId) setError(String(err)); });
          addressRef.current?.blur();
        }}>
          {secure ? <Lock size={11} className="muted" /> : <Globe size={11} className="muted" />}
          <input ref={addressRef} value={address} aria-label={t('browser.addressPlaceholder')} placeholder={t('browser.addressPlaceholder')} onFocus={(e) => { setEditing(true); e.target.select(); }} onBlur={() => setEditing(false)} onChange={(e) => setAddress(e.target.value)} />
        </form>
        {native && <>
          <button className="icon-btn sm" disabled={state.sleeping} onClick={() => void run('sleep-tab')} title={t('browser.sleepTab')} aria-label={t('browser.sleepTab')}><Moon size={13} /></button>
          <Popover open={menu} onClose={() => setMenu(false)} side="bottom" align="right" width={250} trigger={() => <button className="icon-btn sm" title={t('browser.options')} aria-label={t('browser.options')} onClick={() => setMenu(!menu)}><MoreHorizontal size={14} /></button>}>
            <MenuItem icon={<Pin size={13} />} label={t(state.pinned ? 'browser.unpin' : 'browser.pin')} checked={state.pinned} onClick={() => { setMenu(false); void run('pin-tab', state.activeTabId, { pinned: !state.pinned }); }} />
            <MenuItem icon={<Moon size={13} />} label={t('browser.sleepInactive')} onClick={() => { setMenu(false); void run('sleep-inactive'); }} />
            <label className="browser-idle-setting">{t('browser.autoSleep')}<select value={idle} onChange={(e) => useStore.getState().setSettings({ browserIdleMinutes: Number(e.target.value) })}>
              {[0, 1, 5, 10, 30].map((n) => <option key={n} value={n}>{n ? t('browser.minutes', { n }) : t('browser.off')}</option>)}
            </select></label>
            <p className="browser-menu-help">{t('browser.sleepProtection')}</p>
          </Popover>
        </>}
        <button className="icon-btn sm" onClick={() => void run('external')} title={t('browser.openExternal')}><ExternalLink size={13} /></button>
        <button className="icon-btn sm" onClick={() => void run('devtools')} title={t('browser.devtools')}><Bug size={13} /></button>
      </div>
      {(error || notice) && <div className={`browser-notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button className="icon-btn sm" aria-label={t('common.close')} onClick={() => { setError(''); setNotice(''); }}><X size={12} /></button></div>}
      {state.loading && <div className="browser-progress" />}
      <div className={`browser-host ${state.sleeping ? 'is-sleeping' : ''}`} ref={hostRef}>
        {state.sleeping && <div className="browser-sleep-card"><Moon size={26} /><strong>{t('browser.sleeping')}</strong><span>{state.title || state.url}</span><p>{t('browser.sleepExplanation')}</p><button className="btn" onClick={() => void run('wake-tab')}>{t('browser.wake')}</button></div>}
      </div>
    </div>
  );
}
