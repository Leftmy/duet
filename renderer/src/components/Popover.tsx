import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { AnimatePresence, motion } from 'motion/react';
import { useOutsideClick } from '../lib/hooks';

/** Native views (the built-in browser) draw above the DOM; they step aside while any overlay is open. */
export function useOverlay(open: boolean) {
  useEffect(() => {
    if (!open) return;
    useStore.setState((s) => ({ overlays: s.overlays + 1 }));
    return () => useStore.setState((s) => ({ overlays: Math.max(0, s.overlays - 1) }));
  }, [open]);
}

export const spring = { type: 'spring' as const, stiffness: 520, damping: 38, mass: 0.7 };

interface Props {
  open: boolean;
  onClose: () => void;
  trigger: (p: { open: boolean }) => ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'left' | 'right';
  width?: number;
  className?: string;
}

export function Popover({ open, onClose, trigger, children, side = 'top', align = 'left', width, className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [wrapRef], []);
  const close = useCallback(() => onClose(), [onClose]);
  useOutsideClick(refs, close, open);
  useOverlay(open);
  const dy = side === 'top' ? 6 : -6;
  return (
    <div className="pop-wrap" ref={wrapRef}>
      {trigger({ open })}
      <AnimatePresence>
        {open && (
          <motion.div
            className={`popover popover-${side} popover-${align} ${className ?? ''}`}
            style={{ width, transformOrigin: `${side === 'top' ? 'bottom' : 'top'} ${align}` }}
            initial={{ opacity: 0, scale: 0.96, y: dy }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: dy / 2, transition: { duration: 0.12 } }}
            transition={spring}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  hint,
  checked,
  tone,
  onClick,
  right,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  checked?: boolean;
  tone?: 'warn' | 'accent';
  onClick: () => void;
  right?: ReactNode;
}) {
  return (
    <button className={`menu-item ${tone ? 'tone-' + tone : ''} ${checked ? 'is-checked' : ''}`} onClick={onClick}>
      {icon && <span className="menu-icon">{icon}</span>}
      <span className="menu-text">
        <span className="menu-label">{label}</span>
        {hint && <span className="menu-hint">{hint}</span>}
      </span>
      {right}
      {checked && (
        <svg className="menu-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

export interface MenuAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 'right' lines the menu up with the anchor's right edge (buttons); 'left' opens at the point (context menu). */
  align?: 'left' | 'right';
}

export const anchorFrom = (el: Element, align: 'left' | 'right' = 'right'): MenuAnchor => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, align };
};

/** Menu rendered over everything (portal, fixed position), so scroll areas and collapsing lists can't clip it. */
export function FloatingMenu({ anchor, onClose, width = 230, children }: { anchor: MenuAnchor | null; onClose: () => void; width?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  useOverlay(Boolean(anchor));

  useLayoutEffect(() => {
    if (!anchor) return setPos(null);
    const h = ref.current?.offsetHeight ?? 0;
    const pad = 8;
    let left = anchor.align === 'left' ? anchor.left : anchor.right - width;
    left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
    const below = anchor.bottom + 4;
    const above = below + h > window.innerHeight - pad && anchor.top - 4 - h > pad;
    const top = above ? anchor.top - 4 - h : Math.min(below, Math.max(pad, window.innerHeight - h - pad));
    if (!pos || pos.left !== left || pos.top !== top || pos.above !== above) setPos({ left, top, above });
  });

  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <AnimatePresence>
      {anchor && (
        <motion.div
          ref={ref}
          className="popover floating-menu"
          style={{
            position: 'fixed',
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            width,
            transformOrigin: `${pos?.above ? 'bottom' : 'top'} ${anchor.align === 'left' ? 'left' : 'right'}`,
          }}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
          transition={spring}
          onContextMenu={(e) => e.preventDefault()}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
