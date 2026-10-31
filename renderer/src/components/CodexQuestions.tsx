import {useState} from 'react';
import type {Thread} from '../types';
import {useStore} from '../store';
import {t} from '../i18n';

export function CodexQuestions({thread}:{thread:Thread}){
  const questions=thread.codex?.questions;
  if(!questions||thread.provider!=='codex')return null;
  return <QuestionForm key={questions.id} thread={thread}/>;
}
function QuestionForm({thread}:{thread:Thread}){
  const questions=thread.codex!.questions!,send=useStore(s=>s.send),[values,setValues]=useState<Record<number,string>>({});
  const dismiss=()=>useStore.setState(s=>({threads:{...s.threads,[thread.id]:{...s.threads[thread.id],codex:{...s.threads[thread.id].codex,questions:null}}}}));
  return <form className="approval" onSubmit={e=>{e.preventDefault();const answer=questions.items.map((q,i)=>`${q.title}\n${values[i].trim()}`).join('\n\n');dismiss();send(thread.id,answer,[]);}}>
    <div className="approval-head">{t('approval.question')}</div>
    {questions.items.map((question,i)=><label className="question" key={i}>{question.title}
      <div className="options">{question.options?.map(option=><button type="button" key={option} className={`option ${values[i]===option?'is-on':''}`} onClick={()=>setValues(v=>({...v,[i]:option}))}>{option}</button>)}</div>
      <input className="input" required value={values[i]??''} onChange={e=>setValues(v=>({...v,[i]:e.target.value}))} placeholder={t('approval.otherAnswer')}/>
    </label>)}
    <div className="approval-actions"><button type="button" className="btn ghost" onClick={dismiss}>{t('approval.skip')}</button><button className="btn primary" type="submit" disabled={!questions.items.every((_,i)=>values[i]?.trim())}>{t('approval.answer')}</button></div>
  </form>;
}
