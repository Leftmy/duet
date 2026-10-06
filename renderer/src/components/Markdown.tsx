import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { useStore } from '../store';
import { t } from '../i18n';

/** Opens a file link from Claude's answer (relative to the chat's project, absolute or file://) in the editor. */
async function openLocalLink(href: string) {
  const s = useStore.getState();
  const cwd = s.threads[s.activeId]?.cwd ?? '';
  let p = href.replace(/^file:\/+/i, '');
  try {
    p = decodeURIComponent(p);
  } catch {}
  // Drop line anchors such as #L12, :12 or :12:3.
  p = p.replace(/#L?\d+(-L?\d+)?$/i, '').replace(/:(\d+)(:\d+)?$/, '');
  const absolute = /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\');
  const full = (absolute ? p : `${cwd.replace(/[\\/]+$/, '')}\\${p.replace(/^\.?[\\/]/, '')}`).replace(/\//g, '\\');
  if (!(await window.desk.pathExists(full))) {
    s.toast(t('turn.fileNotFound', { path: full }), 'error');
    return;
  }
  const r = await window.desk.filesRead(full).catch(() => null);
  if (r) s.openFile(full);
  else window.desk.openPath(full); // a folder: show it in Explorer
}

function hastText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

function CodeBlock({ lang, raw, children }: { lang: string; raw: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang || 'text'}</span>
        <button
          className="icon-btn sm"
          title={t('common.copy')}
          onClick={() => {
            navigator.clipboard.writeText(raw);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre({ node, children }) {
    const code: any = node?.children?.[0];
    const cls: string[] = code?.properties?.className ?? [];
    const lang = (cls.find((c) => String(c).startsWith('language-')) ?? '').toString().replace('language-', '');
    return (
      <CodeBlock lang={lang} raw={hastText(code).replace(/\n$/, '')}>
        {children}
      </CodeBlock>
    );
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (!href) return;
          if (/^https?:/i.test(href)) window.desk.openExternal(href);
          else if (!/^(mailto|javascript|data):/i.test(href) && !href.startsWith('#')) openLocalLink(href);
        }}
        title={href}
      >
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    const url = typeof src === 'string' ? src : '';
    if (!/^(https?:|data:image\/)/i.test(url)) return <span className="muted">[{alt || t('turn.image')}]</span>;
    return <img className="md-img" src={url} alt={alt ?? ''} loading="lazy" onClick={() => useStore.setState({ zoomImage: url })} />;
  },
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

const rehypePlugins: any[] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];
const remarkPlugins = [remarkGfm];
// Keep file: links (opened in the built-in editor by our click handler); everything else as default.
const urlTransform = (url: string) => (/^file:/i.test(url) ? url : defaultUrlTransform(url));

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
