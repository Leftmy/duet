// Built-in browser: a WebContentsView docked into the right panel, plus an in-process MCP server
// ("desk-browser") that lets Claude drive it — navigate, screenshot, read, click, type.
import { WebContentsView, shell } from 'electron';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const HOME_URL = 'https://www.google.com/';

export function createBrowser({ getWindow, emit }) {
  // One page per chat (key = thread id); cookies/logins are shared through the partition.
  const views = new Map();
  let activeKey = null;
  let visible = false;
  let bounds = { x: 0, y: 0, width: 0, height: 0 };

  const stateOf = (key) => {
    const wc = views.get(key)?.webContents;
    if (!wc || wc.isDestroyed()) return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  };
  const push = (key) => emit('browser:state', { key, ...stateOf(key) });

  function ensure(key) {
    let view = views.get(key);
    if (view) return view;
    view = new WebContentsView({
      webPreferences: { partition: 'persist:desk-browser', sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    view.setBackgroundColor('#ffffff');
    const wc = view.webContents;
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(ev, () => push(key));
    // Links that open new windows stay in the panel.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) wc.loadURL(url);
      return { action: 'deny' };
    });
    wc.loadURL(HOME_URL);
    views.set(key, view);
    return view;
  }

  function attach() {
    const win = getWindow();
    if (!win) return;
    for (const [key, view] of views) {
      const show = visible && key === activeKey && bounds.width > 0 && bounds.height > 0;
      const attached = win.contentView.children.includes(view);
      if (show) {
        if (!attached) win.contentView.addChildView(view);
        view.setBounds(bounds);
      } else if (attached) win.contentView.removeChildView(view);
    }
  }

  const normalize = (url) => {
    const u = String(url).trim();
    if (/^(https?|file|about):/i.test(u)) return u;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(u) || /^localhost(:\d+)?/.test(u)) return (u.startsWith('localhost') ? 'http://' : 'https://') + u;
    return `https://www.google.com/search?q=${encodeURIComponent(u)}`;
  };

  async function navigate(key, url) {
    const view = ensure(key);
    emit('browser:show', { key });
    await view.webContents.loadURL(normalize(url)).catch(() => {});
    return stateOf(key);
  }

  async function screenshot(key) {
    const view = ensure(key);
    const img = await view.webContents.capturePage();
    const size = img.getSize();
    const scaled = size.width > 1280 ? img.resize({ width: 1280 }) : img;
    return scaled.toPNG().toString('base64');
  }
  const READ_JS = `(() => {
    const t = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    const links = [...document.querySelectorAll('a[href]')].slice(0, 60).map(a => (a.innerText || '').trim().slice(0, 60) + ' -> ' + a.href).filter(s => !s.startsWith(' ->'));
    return { title: document.title, url: location.href, text: t.slice(0, 20000), links };
  })()`;

  const clickJs = (selector, text) => `(() => {
    let el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'null'};
    if (!el && ${JSON.stringify(text ?? '')}) {
      const want = ${JSON.stringify((text ?? '').toLowerCase())};
      el = [...document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button],[onclick],summary,label')]
        .find(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(want));
    }
    if (!el) return 'not found';
    el.scrollIntoView({ block: 'center' });
    el.click();
    return 'clicked: ' + (el.innerText || el.value || el.tagName).toString().trim().slice(0, 80);
  })()`;

  const typeJs = (selector, text, submit) => `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'not found';
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (set) set.call(el, ${JSON.stringify(text)}); else el.textContent = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    ${submit ? "if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));" : ''}
    return 'typed';
  })()`;

  const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
  const settle = () => new Promise((r) => setTimeout(r, 700));

  /** A fresh MCP server per Claude session, bound to that chat's own page. */
  function mcpServer(key) {
    const exec = (js) => ensure(key).webContents.executeJavaScript(js, true);
    const view = () => ensure(key);
    return createSdkMcpServer({
      name: 'desk-browser',
      version: '1.0.0',
      instructions:
        'Built-in browser panel of the Claude Desk app, visible to the user next to the chat. ' +
        'Use it to open web pages, check local dev servers (http://localhost:...), read docs and verify UI changes. ' +
        'Typical loop: navigate → screenshot or read → click/type → screenshot.',
      tools: [
        tool('navigate', 'Open a URL (or a search query) in the built-in browser panel.', { url: z.string() }, async ({ url }) => {
          const s = await navigate(key, url);
          await settle();
          return text({ url: view().webContents.getURL(), title: view().webContents.getTitle(), loading: s.loading });
        }),
        tool('screenshot', 'Take a screenshot of the current page in the built-in browser.', {}, async () => {
          emit('browser:show', { key });
          return { content: [{ type: 'image', data: await screenshot(key), mimeType: 'image/png' }] };
        }),
        tool('read_page', 'Get the visible text, title, URL and links of the current page.', {}, async () => text(await exec(READ_JS))),
        tool(
          'click',
          'Click an element by CSS selector, or by its visible text when no selector is given.',
          { selector: z.string().optional(), text: z.string().optional() },
          async ({ selector, text: t }) => {
            const r = await exec(clickJs(selector, t));
            await settle();
            return text(r);
          },
        ),
        tool(
          'type',
          'Type text into an input or textarea (CSS selector); optionally submit its form.',
          { selector: z.string(), text: z.string(), submit: z.boolean().optional() },
          async ({ selector, text: t, submit }) => {
            const r = await exec(typeJs(selector, t, submit));
            await settle();
            return text(r);
          },
        ),
        tool('scroll', 'Scroll the page vertically by a number of pixels (negative = up).', { dy: z.number() }, async ({ dy }) => {
          await exec(`window.scrollBy(0, ${Number(dy) || 0}); 'ok'`);
          return text('scrolled');
        }),
        tool('back', 'Go back in the built-in browser history.', {}, async () => {
          if (view().webContents.navigationHistory.canGoBack()) view().webContents.navigationHistory.goBack();
          await settle();
          return text(stateOf(key));
        }),
        tool('run_js', 'Run JavaScript in the current page and return the result (JSON-serialisable).', { code: z.string() }, async ({ code }) => {
          try {
            return text(await exec(code));
          } catch (e) {
            return text(`error: ${e?.message ?? e}`);
          }
        }),
      ],
    });
  }

  return {
    mcpServer,
    state: (key) => stateOf(key),
    navigate,
    setBounds(b) {
      bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) };
      attach();
    },
    /** Shows the active chat's page (or hides all pages). */
    setVisible(v, key) {
      visible = Boolean(v);
      if (key) activeKey = key;
      if (visible && activeKey) ensure(activeKey);
      attach();
      if (activeKey) push(activeKey);
    },
    control(key, action) {
      const wc = ensure(key).webContents;
      if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      else if (action === 'reload') wc.reload();
      else if (action === 'stop') wc.stop();
      else if (action === 'external') shell.openExternal(wc.getURL());
      else if (action === 'devtools') wc.toggleDevTools();
      return stateOf(key);
    },
    /** Frees a chat's page when the chat is closed or deleted. */
    dispose(key) {
      const view = views.get(key);
      if (!view) return;
      const win = getWindow();
      if (win && win.contentView.children.includes(view)) win.contentView.removeChildView(view);
      view.webContents.close();
      views.delete(key);
    },
  };
}