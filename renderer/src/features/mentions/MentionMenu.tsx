import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { File, FileCode, FileImage, FileJson, FileText, Folder, Loader2 } from 'lucide-react';
import { spring } from '../../components/Popover';
import { t } from '../../i18n';
import type { IndexEntry } from './fileIndex';
import './mentions.css';

const CODE = /\.(m?[jt]sx?|c[jt]s|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|swift|vue|svelte|sh|ps1|sql|html?|css|s[ac]ss|less)$/i;
const IMG = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;
const JSONLIKE = /\.(json|jsonc|ya?ml|toml|xml|ini|env)$/i;
const TEXT = /\.(md|mdx|txt|rst|log|csv)$/i;

function EntryIcon({ e }: { e: IndexEntry }) {
  const Icon = e.dir ? Folder : CODE.test(e.base) ? FileCode : IMG.test(e.base) ? FileImage : JSONLIKE.test(e.base) ? FileJson : TEXT.test(e.base) ? FileText : File;
  return <Icon size={14} className="mention-icon" />;
}

interface Props {
  items: IndexEntry[];
  idx: number;
  loading: boolean;
  onPick: (e: IndexEntry) => void;
  onHover: (i: number) => void;
}

export function MentionMenu({ items, idx, loading, onPick, onHover }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [idx, items]);

  return (
    <motion.div
      ref={listRef}
      className="slash-menu mention-menu"
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4 }}
      transition={spring}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.length === 0 ? (
        <div className="mention-empty">
          {loading ? (
            <>
              <Loader2 size={13} className="spin" /> {t('mentions.indexing')}
            </>
          ) : (
            t('mentions.noFiles')
          )}
        </div>
      ) : (
        items.map((e, i) => (
          <button
            key={e.path}
            className={`slash-item mention-item ${i === idx ? 'is-active' : ''}`}
            title={e.path}
            onMouseDown={(ev) => {
              ev.preventDefault();
              onPick(e);
            }}
            onMouseMove={() => i !== idx && onHover(i)}
          >
            <EntryIcon e={e} />
            <span className="mention-name">
              {e.base}
              {e.dir ? '/' : ''}
            </span>
            {e.parent && <span className="mention-dir">{e.parent.slice(0, -1)}</span>}
          </button>
        ))
      )}
    </motion.div>
  );
}
