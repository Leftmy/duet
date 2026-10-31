import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { useStore } from '../store';
import { t } from '../i18n';
import { headingSlug, linkTarget, markdownUrl } from '../lib/links';

export const MarkdownContext = createContext<string | undefined>(undefined);

/** Opens a file link from Claude's answer (relative to the chat's project, absolute or file://) in the editor. */
async function openLocalLink(href: string, cwd: string) {
  const s = useStore.getState();
  const target = linkTarget(href, cwd, window.desk.platform);
  if (target.kind !== 'file') return;
  const full = target.path;
  if (!(await window.desk.pathExists(full))) {
    s.toast(t('turn.fileNotFound', { path: full }), 'error');
    return;
  }
  const r = await window.desk.filesRead(full).catch(() => null);
  if(r&&/\.(png|jpe?g|gif|webp)$/i.test(full)&&window.desk.nativeHistoryPaging===true){
    const image=await window.desk.call('fs:attachment',full);useStore.setState({zoomImage:`data:${image.mediaType};base64,${image.data}`});return;
  }
  if (r) s.openFile(full, target);
  else await window.desk.openPath(full);
}

function MarkdownLink({href, children}: {href?: string; children?: ReactNode}) {
  const context = useContext(MarkdownContext);
  return <a href={href} title={href} onClick={e=>{
    e.preventDefault();if(!href)return;
    const cwd=context??useStore.getState().threads[useStore.getState().activeId]?.cwd??'';
    const target=linkTarget(href,cwd,window.desk.platform);
    const action=target.kind==='external'?window.desk.openExternal(target.url):target.kind==='file'?openLocalLink(href,cwd):Promise.resolve();
    if(target.kind==='anchor'){
      const root=e.currentTarget.closest('.md');
      const heading=[...(root?.querySelectorAll<HTMLElement>('[data-md-heading]')??[])].find(el=>el.dataset.mdHeading===target.id||el.dataset.mdHeading===headingSlug(target.id));
      heading?.scrollIntoView({block:'start',behavior:'smooth'});
    }
    action.catch(error=>useStore.getState().toast(String(error?.message??error),'error'));
  }} onAuxClick={e=>e.preventDefault()}>{children}</a>;
}

function MarkdownImage({src,alt}:{src?:string;alt?:string}){
  const context=useContext(MarkdownContext),ref=useRef<HTMLSpanElement>(null),[local,setLocal]=useState(''),[error,setError]=useState('');
  const direct=/^(https?:|data:image\/)/i.test(src??'');
  const cwd=context??useStore.getState().threads[useStore.getState().activeId]?.cwd??'';
  useEffect(()=>{
    setLocal('');setError('');if(direct||!src||window.desk.nativeHistoryPaging!==true)return;
    const target=linkTarget(src,cwd,window.desk.platform);if(target.kind!=='file'||!ref.current)return;
    let active=true,started=false;
    const load=()=>{if(started)return;started=true;window.desk.call('fs:attachment',target.path).then(image=>{if(active)setLocal(`data:${image.mediaType};base64,${image.data}`)}).catch(e=>{if(active)setError(String(e?.message??e));});};
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();load();}},{rootMargin:'150px'});observer.observe(ref.current);
    return()=>{active=false;observer.disconnect();};
  },[src,cwd,direct]);
  const url=direct?src:local;
  return <span ref={ref}>{url?<img className="md-img" src={url} alt={alt??''} loading="lazy" onClick={()=>useStore.setState({zoomImage:url})}/>:<span className="muted" title={error}>[{alt||t('turn.image')}]</span>}</span>;
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
  a: MarkdownLink,
  img:MarkdownImage,
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

const rehypeHeadings=()=> (tree:any)=>{
  const seen=new Map<string,number>(),pending=[tree];
  while(pending.length){const node=pending.pop();
    if(/^h[1-6]$/.test(node.tagName??'')){const slug=headingSlug(hastText(node)),n=seen.get(slug)??0;seen.set(slug,n+1);node.properties??={};node.properties['data-md-heading']=slug+(n?`-${n}`:'');}
    pending.push(...(node.children??[]).toReversed());
  }
};
const rehypePlugins: any[] = [[rehypeHighlight, { detect: false, ignoreMissing: true }],rehypeHeadings];
const remarkPlugins = [remarkGfm];
// Keep file: links (opened in the built-in editor by our click handler); everything else as default.
const urlTransform = (url: string, key: string) => key==='src'&&/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(url)?url:markdownUrl(url);

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
