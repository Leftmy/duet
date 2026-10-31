import { useCallback, useEffect, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import type { Thread } from '../types';
import { useStore } from '../store';
import { Popover } from './Popover';
import { t } from '../i18n';
import {ModelPicker,PermissionPicker} from './Pickers';
const EMPTY_MODELS:any[]=[];

export function CodexControls({thread}:{thread:Thread}) {
  const [open,setOpen]=useState(false),[tab,setTab]=useState('review'),[target,setTarget]=useState('uncommittedChanges'),[argument,setArgument]=useState('');
  const [objective,setObjective]=useState(''),[budget,setBudget]=useState(''),[data,setData]=useState<any>(null),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const close=useCallback(()=>setOpen(false),[]),action=useStore(s=>s.codexAction),insert=useStore(s=>s.insertToComposer),setTier=useStore(s=>s.setServiceTier);
  const panel=useStore(s=>s.codexPanel);
  const request=useRef(0);
  const models=useStore(s=>s.providers.codex?.models??EMPTY_MODELS),selected=models.find(m=>m.value===(thread.codex?.settings?.model??thread.model));
  const tiers=selected?.serviceTiers??[],goal=thread.codex?.goal;
  const perform=async(name:string,params:Record<string,any>={})=>{
    setBusy(true);setError('');try{return await action(thread.id,name,params)}catch(e:any){setError(String(e?.message??e));return null}finally{setBusy(false)}
  };
  const load=async(more=false)=>{
    const token=++request.current;
    if(tab==='goal'){const result=await perform('goal/get');if(request.current===token&&result?.goal){setObjective(result.goal.objective);setBudget(result.goal.tokenBudget?.toString()??'');}return;}
    if(['mcp','skills','apps','hooks'].includes(tab)){
      const result=await perform(tab,{...(more?{cursor}:{}),force:true});
      if(request.current!==token||!result)return;
      const items=tab==='skills'?(result?.data??[]).flatMap((root:any)=>root.skills??[]):tab==='hooks'?(result?.data??[]).flatMap((root:any)=>root.hooks??[]):result?.data??[];
      setData((old:any)=>more?[...(old??[]),...items]:items);setCursor(result?.nextCursor??null);
    }
  };
  useEffect(()=>{if(open){setData(null);setError('');void load();}return()=>{request.current++;};},[open,tab,thread.id]);
  useEffect(()=>{setOpen(false);setArgument('');setObjective(thread.codex?.goal?.objective??'');setBudget(thread.codex?.goal?.tokenBudget?.toString()??'');},[thread.id]);
  useEffect(()=>{if(panel?.threadId===thread.id){setTab(panel.tab);setOpen(true);}},[panel?.seq,thread.id]);
  useEffect(()=>{if(!open)return;let timer:ReturnType<typeof setTimeout>;const off=window.desk.subscribe('desk:codex-updated',(update:any)=>{if(update.error)setError(String(update.error));else if(update.kind==='windowsSandbox/setupCompleted')setError(t('codex.sandboxReady'));if(tab==='mcp'||tab==='skills'){clearTimeout(timer);timer=setTimeout(()=>load(),150);}});return()=>{off();clearTimeout(timer);};},[open,tab,thread.id]);
  if(thread.provider!=='codex'||window.desk.nativeHistoryPaging!==true)return null;
  const review=async()=>{
    const spec=target==='baseBranch'?{type:target,branch:argument}:target==='commit'?{type:target,sha:argument,title:null}:target==='custom'?{type:target,instructions:argument}:{type:target};
    const result=await perform('review',{target:spec});if(result)setOpen(false);
  };
  return <Popover open={open} onClose={close} side="bottom" align="right" width={370} trigger={()=><button className="icon-btn" title={t('codex.tools')} aria-label={t('codex.tools')} onClick={()=>setOpen(v=>!v)}><Settings2 size={16}/></button>}>
    <div className="codex-controls" data-codex-controls>
      <div className="menu-title">{t('codex.tools')}</div>
      <div className="codex-tabs">{['status','review','goal','skills','mcp','apps','hooks'].map(name=><button key={name} className={`pill ${tab===name?'is-active':''}`} onClick={()=>setTab(name)}>{t('codex.'+name)}</button>)}</div>
      {tab==='status'&&<><div className="codex-tabs"><ModelPicker thread={thread}/><PermissionPicker thread={thread}/></div><code className="small">{thread.sessionId??t('codex.sessionRequired')}</code>{thread.context&&<span className="muted small">{thread.context.totalTokens.toLocaleString()} / {thread.context.maxTokens.toLocaleString()} tokens · {thread.context.percentage}%</span>}<span className="muted small">/compact · /review · /mcp · /skills · /goal · /model · /permissions · /diff · /fork · /new</span></>}
      {tab==='review'&&<>
        <button className="btn" disabled={busy||thread.status==='running'||!thread.sessionId} onClick={async()=>{if(await perform('compact'))close();}}>{t('codex.compact')}</button>
        <select className="input" value={target} onChange={e=>setTarget(e.target.value)} aria-label={t('codex.review')}>
          {['uncommittedChanges','baseBranch','commit','custom'].map((type,i)=><option key={type} value={type}>{t('codex.'+['uncommitted','branch','commit','custom'][i])}</option>)}
        </select>
        {target!=='uncommittedChanges'&&<textarea className="input" value={argument} onChange={e=>setArgument(e.target.value)} rows={2} placeholder={t('codex.'+(target==='baseBranch'?'branch':target==='commit'?'commit':'custom'))}/>}
        <button className="btn primary" disabled={busy||thread.status==='running'||(target!=='uncommittedChanges'&&!argument.trim())} onClick={review}>{t('codex.startReview')}</button>
        {window.desk.platform==='win32'&&<button className="btn ghost" disabled={busy} onClick={()=>perform('windowsSandbox/setup')}>{t('codex.setupSandbox')}</button>}
        {tiers.length>0&&<label className="question">{t('codex.serviceTier')}<select className="input" value={thread.serviceTier??thread.codex?.settings?.serviceTier??selected?.defaultServiceTier??'default'} onChange={e=>setTier(thread.id,e.target.value)}>{!tiers.some((v:any)=>v.id==='default')&&<option value="default">{t('codex.standard')}</option>}{tiers.map((v:any)=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
      </>}
      {tab==='goal'&&<>
        {goal&&<div className="muted small">{goal.status} · {t('codex.used')}: {goal.tokensUsed.toLocaleString()}{goal.tokenBudget?` / ${goal.tokenBudget.toLocaleString()}`:''}</div>}
        <textarea className="input" rows={3} value={objective} onChange={e=>setObjective(e.target.value)} placeholder={t('codex.objective')}/>
        <input className="input" type="number" min={1} max={100000000} value={budget} onChange={e=>setBudget(e.target.value)} placeholder={t('codex.tokenBudget')}/>
        <button className="btn primary" disabled={busy||!objective.trim()||(budget!==''&&(!Number.isInteger(Number(budget))||Number(budget)<1))} onClick={()=>perform('goal/set',{objective:objective.trim(),status:'active',...(budget?{tokenBudget:Number(budget)}:{})})}>{t('codex.setGoal')}</button>
        {goal&&<div className="approval-actions"><button className="btn" disabled={busy} onClick={()=>perform('goal/set',{status:goal.status==='active'?'paused':'active'})}>{t(goal.status==='active'?'codex.pause':'codex.resume')}</button><button className="btn ghost" disabled={busy} onClick={async()=>{if(await perform('goal/clear')){setObjective('');setBudget('');}}}>{t('codex.clearGoal')}</button></div>}
      </>}
      {['mcp','skills','apps','hooks'].includes(tab)&&<>
        <div className="approval-actions"><button className="btn" disabled={busy} onClick={()=>load()}>{t('codex.refresh')}</button>{tab==='mcp'&&<button className="btn" disabled={busy} onClick={async()=>{await perform('mcp/reload');await load();}}>{t('codex.reloadMcp')}</button>}</div>
        {(data??[]).map((item:any,i:number)=><div className="codex-catalog-item" key={item.path??item.name??item.key??i}><strong>{item.displayName??item.name??item.eventName}</strong><span className="muted small">{item.description??item.authStatus}</span>
          {tab==='skills'?<><button className="btn" onClick={()=>{insert(`$${item.name} `);close();}} disabled={item.enabled===false}>{'$'+item.name}</button><label><input type="checkbox" checked={item.enabled!==false} disabled={busy} onChange={async e=>{await perform('skill/config',{path:item.path,enabled:e.target.checked});await load();}}/>{t('codex.enabled')}</label></>:tab==='apps'?<><span className="small">{item.isEnabled?t('codex.enabled'):t('codex.disabled')}</span>{item.installUrl&&<button className="btn" onClick={()=>window.desk.openExternal(item.installUrl).catch(e=>setError(String(e)))}>{t('codex.openApp')}</button>}</>:tab==='hooks'?<><span className="small muted">{item.eventName??item.event} · {item.sourcePath??item.path}</span></>:<>
            <details><summary>{Object.keys(item.tools??{}).length} tools</summary>{Object.entries<any>(item.tools??{}).map(([name,tool])=><p className="small" key={name}><strong>{name}</strong><br/>{tool.description}</p>)}</details>
            {item.toolsError&&<span role="alert">{item.toolsError}</span>}
            {item.authStatus==='notLoggedIn'&&<button className="btn" disabled={busy} onClick={async()=>{const result=await perform('mcp/login',{name:item.name});if(result?.authorizationUrl)window.desk.openExternal(result.authorizationUrl).catch(e=>setError(String(e)));}}>{t('codex.openAuth')}</button>}
          </>}
        </div>)}
        {!busy&&data?.length===0&&<span className="muted small">{t('codex.noItems')}</span>}
        {cursor&&<button className="btn" disabled={busy} onClick={()=>load(true)}>{t('codex.more')}</button>}
      </>}
      {busy&&<span className="muted small">{t('codex.loading')}</span>}{error&&<div className="codex-error" role="alert">{error}</div>}
    </div>
  </Popover>;
}
