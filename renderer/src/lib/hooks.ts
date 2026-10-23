import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Reveals streamed text at a steady, frame-paced rate so bursts of tokens
 * read as a smooth flow instead of jumps. Catches up faster when far behind.
 */
export function useSmoothText(target: string, streaming: boolean) {
  const [shown, setShown] = useState(() => (streaming ? '' : target));
  const state = useRef({ len: streaming ? 0 : target.length, target, raf: 0, streaming });
  state.current.target = target;
  state.current.streaming = streaming;

  useEffect(() => {
    const s = state.current;
    if (s.len > target.length) s.len = target.length;
    if (!streaming && s.len >= target.length) {
      setShown(target);
      return;
    }
    if (s.raf) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const goal = s.target.length;
      if (s.len < goal) {
        const backlog = goal - s.len;
        const perFrame = Math.max(1, Math.ceil((backlog / 10) * (dt / 16.7)));
        s.len = Math.min(goal, s.len + perFrame);
        setShown(s.target.slice(0, s.len));
      }
      // A new target restarts the effect. Do not keep an idle 60 Hz loop per
      // streaming message while agents are waiting for tools or network I/O.
      if (s.len < s.target.length) s.raf = requestAnimationFrame(tick);
      else s.raf = 0;
    };
    s.raf = requestAnimationFrame(tick);
  }, [target, streaming]);

  useEffect(
    () => () => {
      cancelAnimationFrame(state.current.raf);
      state.current.raf = 0;
    },
    [],
  );

  return shown;
}

export function useOutsideClick(refs: RefObject<HTMLElement | null>[], onOutside: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (refs.some((r) => r.current?.contains(target))) return;
      onOutside();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onOutside();
      }
    };
    document.addEventListener('mousedown', handler, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', handler, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [enabled, onOutside, refs]);
}

/** Ticks every `ms` while enabled; returns Date.now(). */
export function useNow(enabled: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [enabled, ms]);
  return now;
}

/** Keeps a scroll container pinned to the bottom while content grows, unless the user scrolled up. */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      pinned.current = gap < 80;
      setAtBottom(gap < 8);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // The scroll element appears after the empty-chat/loading view is replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const scrollToBottom = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const pin = () => {
    pinned.current = true;
  };

  return { atBottom, scrollToBottom, pin };
}
