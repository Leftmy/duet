import { Copy, FileText, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type { PastedTextFile } from '../types';
import { useStore } from '../store';
import { splitPastedText } from '../lib/pasted-text';
import { t } from '../i18n';

export function PastedTextFiles({ files, onRemove, onRetry }: { files: PastedTextFile[]; onRemove?: (id: string) => void; onRetry?: (file: PastedTextFile) => void }) {
  if (!files.length) return null;
  return <div className="pasted-text-files">
    {files.map(file => <div key={file.id} className={`pasted-text-file ${file.error ? 'has-error' : ''}`} data-pasted-file={file.id}>
      <button className="pasted-text-open" title={file.error || file.path || t('composer.savingPaste')} disabled={!file.path || file.pending} onClick={() => useStore.getState().openFile(file.path)}>
        {file.pending ? <LoaderCircle size={15} className="spin" /> : <FileText size={15} />}
        <span><strong>{t(file.error ? 'composer.pasteError' : file.pending ? 'composer.savingPaste' : 'composer.pastedText')}</strong><small>{t('composer.pastedLines', { count: file.lines })}{file.bytes > 0 ? ` · ${Math.max(1, Math.ceil(file.bytes / 1024))} KB` : ''}</small></span>
      </button>
      {file.error && file.source && <button className="icon-btn sm" title={t('common.copy')} onClick={() => navigator.clipboard.writeText(file.source!).catch(error => useStore.getState().toast(String(error), 'error'))}><Copy size={13} /></button>}
      {file.error && onRetry && <button className="icon-btn sm" title={t('composer.retryPaste')} onClick={() => onRetry(file)}><RotateCcw size={13} /></button>}
      {onRemove && <button className="icon-btn sm" title={t('composer.removePaste')} onClick={() => onRemove(file.id)}><X size={13} /></button>}
    </div>)}
  </div>;
}

export function UserText({ text }: { text: string }) {
  const message = splitPastedText(text);
  return <>{message.text && <div className="bubble-text">{message.text}</div>}<PastedTextFiles files={message.files} /></>;
}
