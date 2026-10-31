import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useStore } from '../store';
import { t } from '../i18n';

interface Props {
  id: string;
  label: string;
  target: RefObject<HTMLElement | null>;
  variable: string;
  defaultSize: number;
  bounds: (available: number) => [number, number];
  axis?: 'x' | 'y';
  direction?: 1 | -1;
  percent?: boolean;
}

/** Drag updates only the pane's CSS. Persist once on release, without rerendering chat history. */
export function ResizeHandle({ id, label, target, variable, defaultSize, bounds, axis = 'x', direction = 1, percent = false }: Props) {
  const saved = useStore(s => s.settings.layoutSizes?.[id]);
  const handle = useRef<HTMLDivElement>(null);
  const cancel = useRef<(() => void) | null>(null);
  const size = Number.isFinite(saved) ? saved! : defaultSize;
  const dimension = axis === 'x' ? 'width' : 'height';
  const extent = () => target.current?.parentElement?.getBoundingClientRect()[dimension] || 1;
  const limits = () => bounds(extent());
  const clamp = (value: number) => { const [min,max] = limits(); return Math.min(max,Math.max(min,value)); };
  const current = () => {
    const pixels = target.current?.getBoundingClientRect()[dimension] || 0;
    return percent ? pixels / extent() * 100 : pixels;
  };
  const apply = (value: number) => {
    target.current?.style.setProperty(variable, `${value}${percent ? '%' : 'px'}`);
    const [min,max] = limits();
    handle.current?.setAttribute('aria-valuemin', String(Math.round(min)));
    handle.current?.setAttribute('aria-valuemax', String(Math.round(max)));
    handle.current?.setAttribute('aria-valuenow', String(Math.round(clamp(value))));
  };
  const save = (value: number) => {
    const s = useStore.getState();
    s.setSettings({ layoutSizes: { ...s.settings.layoutSizes, [id]: value } });
  };
  useLayoutEffect(() => { apply(Math.max(0, size)); }, [size, id, variable]);
  useEffect(() => () => cancel.current?.(), []);
  const reset = () => { const value = clamp(defaultSize); apply(value); save(value); };

  return <div ref={handle} className={`resize-handle resize-${axis}`} data-resize={id}
    role="separator" aria-label={label} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    tabIndex={0}
    title={`${label}. ${t('layout.help')}`}
    onDoubleClick={reset}
    onKeyDown={event => {
      if (event.key === 'Escape' && cancel.current) { event.preventDefault(); cancel.current(); return; }
      if (event.key === 'Enter' || event.key === 'Home') { event.preventDefault(); reset(); return; }
      const minus = axis === 'x' ? 'ArrowLeft' : 'ArrowUp', plus = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (event.key !== minus && event.key !== plus) return;
      event.preventDefault();
      const step = (percent ? 2 : 16) * (event.shiftKey ? 3 : 1);
      const value = clamp(current() + (event.key === plus ? 1 : -1) * direction * step);
      apply(value); save(value);
    }}
    onPointerDown={event => {
      if (event.button !== 0 || cancel.current || !target.current) return;
      event.preventDefault(); event.stopPropagation();
      const element = event.currentTarget, pointer = event.pointerId;
      const start = axis === 'x' ? event.clientX : event.clientY, original = current();
      let value = original, frame = 0, finished = false;
      const flush = () => { frame = 0; apply(value); };
      const move = (e: PointerEvent) => {
        if (e.pointerId !== pointer) return;
        const delta = ((axis === 'x' ? e.clientX : e.clientY) - start) * direction;
        value = clamp(original + (percent ? delta / extent() * 100 : delta));
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const finish = (commit: boolean) => {
        if (finished) return; finished = true;
        cancelAnimationFrame(frame); apply(commit ? value : original);
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', abort, true);
        window.removeEventListener('blur', abort);
        window.removeEventListener('keydown', escape, true);
        element.removeEventListener('lostpointercapture', abort);
        if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer);
        delete document.body.dataset.resizing; cancel.current = null;
        window.dispatchEvent(new CustomEvent('desk:layout-resizing', { detail: false }));
        if (commit) save(value);
      };
      const up = (e: PointerEvent) => { if(e.pointerId === pointer) finish(true); };
      const abort = () => finish(false);
      const escape = (e: KeyboardEvent) => { if(e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); abort(); } };
      cancel.current = abort;
      document.body.dataset.resizing = axis;
      window.dispatchEvent(new CustomEvent('desk:layout-resizing', { detail: true }));
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', abort, true);
      window.addEventListener('blur', abort);
      window.addEventListener('keydown', escape, true);
      element.addEventListener('lostpointercapture', abort);
      element.setPointerCapture(pointer);
    }} />;
}
