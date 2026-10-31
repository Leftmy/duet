// The host publishes actual OS window state, including changes made outside these buttons.
(() => {
  const invoke = (action) => window.__TAURI_INTERNALS__.invoke('window_control', { action });
  const icons = {
    minimize: '<path d="M1 6h10"/>',
    maximize: '<rect x="1.5" y="1.5" width="9" height="9"/>',
    restore: '<path d="M4 3V1.5h6.5V8H9"/><rect x="1.5" y="4" width="6.5" height="6.5"/>',
    close: '<path d="m2 2 8 8M10 2l-8 8"/>',
  };
  const icon = (name) => `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">${icons[name]}</svg>`;
  let state = { maximized: false, fullscreen: false, minimized: false };
  const render = () => {
    const button = document.querySelector('[data-window-action="maximize"]');
    if (!button) return;
    const restored = state.maximized || state.fullscreen;
    button.dataset.windowState = state.fullscreen ? 'fullscreen' : state.maximized ? 'maximized' : 'normal';
    button.title = state.fullscreen ? 'Exit full screen' : restored ? 'Restore' : 'Maximize';
    button.setAttribute('aria-label', button.title);
    const name = restored ? 'restore' : 'maximize';
    if (button.dataset.icon !== name) {
      button.dataset.icon = name;
      button.innerHTML = icon(name);
    }
  };
  window.__duetSetWindowState = (next) => {
    state = { ...state, ...next };
    window.__duetNativeWindowState = state;
    render();
  };
  const sync = () => invoke('state').then(window.__duetSetWindowState).catch(console.error);
  const act = async (action) => {
    window.__duetSetWindowState(await invoke(action));
  };
  const decorate = () => {
    const bar = document.querySelector('.titlebar');
    if (!bar || bar.querySelector('[data-native-controls]')) return;
    const controls = document.createElement('div');
    controls.dataset.nativeControls = '';
    for (const [action, title] of [['minimize', 'Minimize'], ['maximize', 'Maximize'], ['close', 'Close']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.windowAction = action;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.innerHTML = icon(action);
      button.addEventListener('pointerenter', () => button.classList.add('is-hovered'));
      button.addEventListener('pointermove', () => button.classList.add('is-hovered'));
      button.addEventListener('pointerleave', () => button.classList.remove('is-hovered'));
      button.addEventListener('click', async (event) => {
        if (button.dataset.pending) return;
        button.classList.remove('is-hovered');
        if (event.detail > 0) button.blur(); // Retain keyboard focus for keyboard activation.
        button.dataset.pending = 'true';
        button.setAttribute('aria-disabled', 'true');
        try { await act(action); } catch (error) { console.error(error); }
        finally { delete button.dataset.pending; button.removeAttribute('aria-disabled'); }
      });
      controls.append(button);
    }
    bar.append(controls);
    render();
    sync();
  };
  document.addEventListener('DOMContentLoaded', () => {
    decorate();
    new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true });
  });
  const draggable = (event) => event.target instanceof Element && event.target.closest('.titlebar') &&
    !event.target.closest('button,input,select,textarea,a,[contenteditable],[data-native-controls]');
  document.addEventListener('mousedown', (event) => {
    if (event.button === 0 && event.detail < 2 && draggable(event)) invoke('drag').catch(console.error);
  });
  document.addEventListener('dblclick', (event) => {
    if (event.button === 0 && draggable(event)) act('maximize').catch(console.error);
  });
  window.addEventListener('focus', sync);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'F11') { event.preventDefault(); act('fullscreen').catch(console.error); }
    else if (event.key === 'F12' || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'i')) {
      event.preventDefault(); invoke('devtools').catch(console.error);
    }
  });
})();
