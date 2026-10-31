import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Layers, Minimize2, Pin, RotateCcw } from 'lucide-react';
import type { Thread } from '../types';
import { useStore } from '../store';
import { Popover } from './Popover';
import { t } from '../i18n';

interface Block { id:string;seq:number;kind:string;bytes:number;sealed:boolean;pinned:boolean;protected:boolean;mode:string;preview:string }
interface Job { id:string;status:string;error?:string;result:any }
interface Snapshot { revision:number;managed:boolean;recordingError?:string;totals:{originalBytes:number;activeBytes:number;estimated:boolean};blocks:Block[];next:number|null;jobs:Job[];compressors:{provider:string;available:boolean;models:{value?:string;id?:string;displayName?:string}[]}[] }
const kb=(n:number)=>`${(n/1024).toFixed(1)} KB`;
export function ContextManager({thread}:{thread:Thread}) {
  const [open,setOpen]=useState(false),[data,setData]=useState<Snapshot|null>(null),[mode,setMode]=useState('active'),[selected,setSelected]=useState<string[]>([]);
  const [provider,setProvider]=useState('claude'),[model,setModel]=useState(''),[target,setTarget]=useState(800),[preserve,setPreserve]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<{id:string;text:string;next:number|null}|null>(null),[dryRun,setDryRun]=useState(false);
  const seq=useRef(0),close=useCallback(()=>setOpen(false),[]);
  const call=useCallback((action:string,extra:Record<string,unknown>={})=>{
    const current=useStore.getState().threads[thread.id]??thread;
    const contextHistory=[...Object.entries(current.sessions??{}).map(([provider,sessionId])=>({provider,sessionId,cwd:current.cwd})),...(current.chain??[]).map(p=>({...p,provider:p.provider??'claude',cwd:current.cwd}))];
    return window.desk.call<any>('desk:context',{action,threadId:current.id,provider:current.provider,resume:current.sessionId,cwd:current.cwd,contextHistory,...extra});
  },[thread.id]);
  const load=useCallback(async(more=false)=>{
    const token=++seq.current;try{
      const result:Snapshot=await call('inspect',{mode,...(more&&data?.next?{after:data.next}:{})});
      if(token!==seq.current)return;
      setData(old=>more&&old?{...result,blocks:[...old.blocks,...result.blocks]}:result);setError('');
      const available=result.compressors.find(p=>p.provider===provider&&p.available)??result.compressors.find(p=>p.available);
      if(available){setProvider(available.provider);setModel(current=>available.models.some(m=>(m.value??m.id)===current)?current:available.models[0]?.value??available.models[0]?.id??'');}
    }catch(e:any){if(token===seq.current)setError(String(e?.message??e));}
  },[call,mode,provider,data?.next]);
  const latestLoad=useRef(load);latestLoad.current=load;
  useEffect(()=>{if(!open)return;setSelected([]);setPreview(null);void latestLoad.current();let timer:ReturnType<typeof setTimeout>;const off=window.desk.subscribe<any>('desk:context-update',update=>{if(update.threadId===thread.id){clearTimeout(timer);timer=setTimeout(()=>void latestLoad.current(),100);}});return()=>{off();clearTimeout(timer);seq.current++;};},[open,thread.id,mode]);
  const edit=async(action:string,job?:string)=>{
    if(!data)return;setBusy(true);setError('');setDryRun(false);
    try{
      const result=job?await call('restore',{job_id:job}):await call('edit',{expected_revision:data.revision,dry_run:action==='preview',operations:[{action:action==='preview'?'compress':action,ids:selected,...(['compress','preview'].includes(action)?{compressor:{provider,model},target_tokens:target,preserve:preserve.split('\n').filter(Boolean)}:{})}]});
      if(result.dry_run)setDryRun(true);else setSelected([]);
      await latestLoad.current();
    }catch(e:any){setError(String(e?.message??e));}finally{setBusy(false);}
  };
  const read=async(id:string,offset=0)=>{setBusy(true);try{const result=await call('read',{id,offset,max_bytes:16000});setPreview(old=>({id,text:offset&&old?.id===id?old.text+result.text:result.text,next:result.next_offset}));}catch(e:any){setError(String(e?.message??e));}finally{setBusy(false);}};
  if(window.desk.nativeContext!==true)return null;
  const pending=data?.jobs.some(job=>['queued','preparing','ready','staged'].includes(job.status));
  const blocked=busy||pending||!selected.length;
  const protectedSelection=mode!=='archived'&&data?.blocks.some(block=>selected.includes(block.id)&&block.pinned);
  const models=data?.compressors.find(p=>p.provider===provider)?.models??[];
  return <Popover open={open} onClose={close} align="right" width={560} className="context-manager" trigger={()=><button className="icon-btn" data-context-manager-toggle title={t('context.manage')} aria-label={t('context.manage')} onClick={()=>setOpen(v=>!v)}><Layers size={15}/></button>}>
    <div className="menu-title">{t('context.manage')}<span className="spacer"/>{data&&<span>rev {data.revision}</span>}</div>
    <div className="context-manager-body" data-context-manager>
      {(error||data?.recordingError)&&<div className="small tone-danger" role="alert">{error||data?.recordingError}</div>}
      <p className="muted small">{t('context.hint')}</p>
      {data?.jobs.some(job=>['queued','preparing','ready'].includes(job.status))&&<button className="btn ghost" onClick={()=>void call('cancel',{job_id:data.jobs.find(job=>['queued','preparing','ready'].includes(job.status))?.id}).then(()=>latestLoad.current()).catch(e=>setError(String(e)))}>{t('context.cancel')}</button>}
      {data&&<div className="small">{t('context.size',{active:kb(data.totals.activeBytes),total:kb(data.totals.originalBytes)})}</div>}
      <div className="context-manager-bar"><select aria-label={t('context.filter')} value={mode} onChange={e=>setMode(e.target.value)}><option value="active">{t('context.active')}</option><option value="archived">{t('context.archived')}</option><option value="">{t('context.all')}</option></select><button className="icon-btn sm" title={t('context.refresh')} onClick={()=>void load()}><RotateCcw size={13}/></button><span className="spacer"/><span className="muted small">{t('context.selected',{count:selected.length})}</span></div>
      <div className="context-blocks">
        {data?.blocks.map(block=><div className="context-block" key={block.id} data-context-block={block.id}>
          <input type="checkbox" aria-label={block.id} disabled={!block.sealed||block.protected||busy||pending} checked={selected.includes(block.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,block.id]:ids.filter(id=>id!==block.id))}/>
          <button className="context-block-read" title={block.id} onClick={()=>void read(block.id)}><strong>{block.pinned&&<Pin size={11}/>} {block.kind} · {kb(block.bytes)} {!block.sealed&&`· ${t('context.inProgress')}`}</strong><span>{block.preview}</span></button>
        </div>)}
        {data&&!data.blocks.length&&<p className="muted small">{t('context.empty')}</p>}
      </div>
      {data?.next&&<button className="btn ghost" onClick={()=>void load(true)}>{t('context.more')}</button>}
      {preview&&<div className="context-preview"><div className="small truncate" title={preview.id}>{preview.id}</div><pre>{preview.text}</pre>{preview.next!==null&&<button className="btn ghost" disabled={busy} onClick={()=>void read(preview.id,preview.next!)}>{t('context.more')}</button>}</div>}
      <div className="context-manager-bar"><select aria-label={t('context.provider')} value={provider} onChange={e=>{setProvider(e.target.value);const models=data?.compressors.find(p=>p.provider===e.target.value)?.models??[];setModel(models[0]?.value??models[0]?.id??'');}}>{data?.compressors.filter(p=>p.available).map(p=><option key={p.provider} value={p.provider}>{p.provider}</option>)}</select><select aria-label={t('context.model')} value={model} onChange={e=>setModel(e.target.value)}>{models.map(m=><option key={m.value??m.id} value={m.value??m.id}>{m.displayName??m.value??m.id}</option>)}</select><input type="number" min={64} max={16000} aria-label={t('context.target')} value={target} onChange={e=>setTarget(Number(e.target.value))}/></div>
      <textarea rows={2} aria-label={t('context.preserve')} placeholder={t('context.preserve')} value={preserve} onChange={e=>setPreserve(e.target.value)}/>
      <div className="context-manager-bar"><button className="btn" disabled={blocked||protectedSelection} onClick={()=>void edit(mode==='archived'?'restore':'archive')}><Archive size={13}/>{t(mode==='archived'?'context.restore':'context.archive')}</button><button className="btn" disabled={blocked} onClick={()=>void edit(data?.blocks.filter(b=>selected.includes(b.id)).every(b=>b.pinned)?'unpin':'pin')}><Pin size={13}/>{t('context.pin')}</button><button className="btn" disabled={blocked||protectedSelection||!model||mode==='archived'} onClick={()=>void edit('preview')}>{t('context.preview')}</button><button className="btn primary" disabled={blocked||protectedSelection||!model||mode==='archived'} onClick={()=>void edit('compress')}><Minimize2 size={13}/>{t('context.compress')}</button></div>
      {dryRun&&<p className="small">{t('context.validated')}</p>}
      <div className="context-jobs">{data?.jobs.map((job,index)=><div className="context-job" key={job.id} data-context-job={job.id}><span>{t('context.job.'+job.status)}</span>{Object.values(job.result?.summaries??{}).map((summary:any,n)=><span className="small muted" key={n}>{summary.provider} / {summary.model}: {kb(summary.beforeBytes)} → {kb(summary.afterBytes)} · {Math.round((summary.durationMs??0)/1000)} s{summary.cacheHit?' · cache':''}</span>)}{job.error&&<span className="tone-danger small">{job.error}</span>}{index===0&&job.status==='applied'&&!pending&&<button className="btn ghost" disabled={busy} onClick={()=>void edit('restore',job.id)}>{t('context.undo')}</button>}</div>)}</div>
    </div>
  </Popover>;
}
