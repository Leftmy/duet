import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { cachedIndex, loadIndex, rankEntries, type IndexEntry } from './fileIndex';

export interface MentionToken {
  /** Index of the '@'. */
  start: number;
  /** End of the token (first whitespace after the caret). */
  end: number;
  query: string;
}

/** `@query` right before the caret, where '@' is at the start or follows whitespace. */
export function findMentionToken(value: string, caret: number): MentionToken | null {
  const m = value.slice(0, caret).match(/(?:^|\s)@("?)([^\s"]*)$/);
  if (!m) return null;
  const start = caret - m[1].length - m[2].length - 1;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end])) end++;
  return { start, end, query: m[2] };
}

/** `@path`, quoted when the path has whitespace (Claude Code accepts `@"a b/c.txt"`). */
export function mentionFor(rel: string) {
  return /\s/.test(rel) ? `@"${rel}"` : `@${rel}`;
}

interface Opts {
  cwd: string;
  text: string;
  setText: (value: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  /** Another popup (slash menu) owns the keyboard. */
  blocked: boolean;
}

export function useMentions({ cwd, text, setText, taRef, blocked }: Opts) {
  const [token, setToken] = useState<MentionToken | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [idx, setIdx] = useState(0);
  const [entries, setEntries] = useState<IndexEntry[] | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const open = !!token && !!cwd && !blocked && token.start !== dismissed;

  const sync = useCallback(() => {
    const ta = taRef.current;
    if (!ta || document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) {
      setToken(null);
      return;
    }
    const t = findMentionToken(ta.value, ta.selectionStart);
    setToken((prev) => (prev && t && prev.start === t.start && prev.end === t.end && prev.query === t.query ? prev : t));
  }, [taRef]);

  // After every text change: restore the caret we asked for, then re-detect the token.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (ta && pendingCaret.current != null) {
      ta.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    sync();
  }, [text, sync, taRef]);

  useEffect(() => {
    if (!token) setDismissed(null);
  }, [token]);

  useEffect(() => setIdx(0), [token?.start, token?.query]);

  // Each time the popup opens: show the cached index right away, refresh it if older than 30s.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setEntries(cachedIndex(cwd));
    loadIndex(cwd).then((e) => alive && setEntries(e));
    return () => {
      alive = false;
    };
  }, [open, cwd]);

  const items = useMemo(() => (open && entries && token ? rankEntries(entries, token.query, 50) : []), [open, entries, token]);
  const loading = open && entries === null;

  const pick = useCallback(
    (entry: IndexEntry) => {
      const ta = taRef.current;
      if (!ta || !token) return;
      const value = ta.value;
      const quoted = /\s/.test(entry.path);
      // Picking a folder keeps the popup open so the user can drill into it.
      const drill = entry.dir && !quoted;
      const rest = value.slice(token.end);
      const ins = mentionFor(entry.path);
      const sep = drill || /^\s/.test(rest) ? '' : ' ';
      pendingCaret.current = token.start + ins.length + (drill ? 0 : 1);
      setText(value.slice(0, token.start) + ins + sep + rest);
      ta.focus();
    },
    [taRef, token, setText],
  );

  /** Returns true when the key was consumed by the popup. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !token) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return false;
      e.preventDefault();
      setIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
      if (!items.length) {
        if (e.key === 'Tab') e.preventDefault();
        return e.key === 'Tab';
      }
      e.preventDefault();
      pick(items[idx % items.length]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(token.start);
      return true;
    }
    return false;
  };

  /** Puts the caret at `pos` after the next text update (for programmatic inserts). */
  const placeCaret = useCallback((pos: number) => {
    pendingCaret.current = pos;
  }, []);

  return { open, items, idx: items.length ? idx % items.length : 0, setIdx, loading, query: token?.query ?? '', pick, sync, onKeyDown, placeCaret };
}
