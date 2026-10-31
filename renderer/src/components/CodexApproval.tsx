import { useState } from 'react';
import type { Approval } from '../types';
import { useStore } from '../store';
import { t } from '../i18n';
import { Markdown } from './Markdown';

export function PermissionApproval({threadId,approval}:{threadId:string;approval:Approval}) {
  const respond=useStore(s=>s.respond),p=approval.input?.permissions??{},fs=p.fileSystem??{};
  return <div className="approval"><div className="approval-head">{t('codex.permissions')}</div>
    {approval.description&&<Markdown text={approval.description}/>}
    {p.network?.enabled&&<p>{t('codex.network')}</p>}
    {['read','write'].map(mode=>fs[mode]?.length?<div key={mode}><strong>{t('codex.'+mode)}</strong><pre className="detail-out">{fs[mode].join('\n')}</pre></div>:null)}
    {fs.entries?.length>0&&<pre className="detail-out">{fs.entries.map((e:any)=>`${e.access??''} ${typeof e.path==='string'?e.path:JSON.stringify(e.path)}`).join('\n')}</pre>}
    <div className="approval-actions"><button className="btn ghost" onClick={()=>respond(threadId,approval,'deny')}>{t('approval.deny')}</button><button className="btn" onClick={()=>respond(threadId,approval,'always')}>{t('codex.allowSession')}</button><button className="btn primary" onClick={()=>respond(threadId,approval,'allow')}>{t('codex.allowTurn')}</button></div>
  </div>;
}
function choices(schema:any):{value:any;label:string}[]{
  return Array.isArray(schema.enum)?schema.enum.map((value:any,i:number)=>({value,label:schema.enumNames?.[i]??String(value)})):Array.isArray(schema.oneOf)?schema.oneOf.filter((v:any)=>'const'in v).map((v:any)=>({value:v.const,label:v.title??String(v.const)})):[];
}
function Field({name,schema,value,onChange,required}:{name:string;schema:any;value:any;onChange:(v:any)=>void;required:boolean}) {
  const options=choices(schema.type==='array'?schema.items??{}:schema);
  const label=<span>{schema.title??name}{required?' *':''}</span>;
  if(schema.type==='boolean')return <label className="question"><span><input type="checkbox" checked={value===true} onChange={e=>onChange(e.target.checked)}/>{label}</span>{schema.description&&<small>{schema.description}</small>}</label>;
  return <label className="question">{label}{schema.description&&<small className="muted">{schema.description}</small>}
    {schema.type==='array'&&options.length?<div className="options">{options.map((o,i)=><label key={i}><input type="checkbox" checked={Array.isArray(value)&&value.includes(o.value)} onChange={e=>onChange(e.target.checked?[...(value??[]),o.value]:(value??[]).filter((v:any)=>v!==o.value))}/>{o.label}</label>)}</div>
    :options.length?<select className="input" required={required} value={value===undefined?'':String(options.findIndex(o=>o.value===value))} onChange={e=>onChange(e.target.value===''?undefined:options[Number(e.target.value)].value)}><option value="">{t('codex.choose')}</option>{options.map((o,i)=><option key={i} value={String(i)}>{o.label}</option>)}</select>
    :schema.type==='object'||schema.type==='array'?<textarea className="input" required={required} value={typeof value==='string'?value:JSON.stringify(value??(schema.type==='array'?[]:{}),null,2)} onChange={e=>onChange(e.target.value)} rows={4}/>
    :<input className="input" required={required} type={schema.type==='integer'||schema.type==='number'?'number':schema.format==='email'?'email':schema.format==='uri'?'url':'text'} step={schema.type==='integer'?1:'any'} min={schema.minimum} max={schema.maximum} minLength={schema.minLength} maxLength={schema.maxLength} value={value??''} onChange={e=>onChange(e.target.value===''?undefined:schema.type==='number'||schema.type==='integer'?Number(e.target.value):e.target.value)}/>}
  </label>;
}
export function McpFormApproval({threadId,approval}:{threadId:string;approval:Approval}) {
  const respond=useStore(s=>s.respond),input=approval.input??{},schema=input.requestedSchema??{},fields=schema.properties??{};
  const [values,setValues]=useState<Record<string,any>>(()=>Object.fromEntries(Object.entries<any>(fields).filter(([,v])=>v.default!==undefined).map(([k,v])=>[k,v.default]))),[error,setError]=useState(''),[validating,setValidating]=useState(false);
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();setError('');
    const content:Record<string,any>={};
    try{for(const [name,field]of Object.entries<any>(fields)){
      let value=values[name];if(field.type==='boolean'&&value===undefined&&(schema.required??[]).includes(name))value=false;
      if((field.type==='array'||field.type==='object')&&typeof value==='string')value=JSON.parse(value);
      if(value!==undefined)content[name]=value;
    }}catch{setError(t('codex.invalidJson'));return;}
    setValidating(true);
    try{if(input.mode!=='url')await window.desk.call('desk:codex',{action:'validate-form',schema,content});respond(threadId,approval,'allow',{updatedInput:{content}});}catch(e:any){setError(String(e?.message??e));}finally{setValidating(false);}
  };
  return <form className="approval" onSubmit={submit}><div className="approval-head">{input.serverName??'MCP'}</div><Markdown text={input.message??''}/>
    {input.mode==='url'?<button type="button" className="btn" onClick={()=>window.desk.openExternal(input.url).catch(e=>setError(String(e)))}>{t('codex.openAuth')}</button>:Object.entries(fields).map(([name,field])=><Field key={name} name={name} schema={field} required={(schema.required??[]).includes(name)} value={values[name]} onChange={value=>setValues(v=>({...v,[name]:value}))}/>)}
    {error&&<p role="alert">{error}</p>}
    <div className="approval-actions"><button type="button" className="btn ghost" onClick={()=>respond(threadId,approval,'deny',{updatedInput:{cancel:true}})}>{t('common.cancel')}</button><button type="button" className="btn" onClick={()=>respond(threadId,approval,'deny')}>{t('approval.deny')}</button><button className="btn primary" type="submit" disabled={validating}>{input.mode==='url'?t('codex.authDone'):t('approval.answer')}</button></div>
  </form>;
}
