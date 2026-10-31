import { memo, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Check, ChevronRight, CornerDownLeft, MessageSquare, Sparkles, Square, X, ChevronUp } from 'lucide-react';
import type { AgentEventItem, AgentMessageItem, AgentRun, Thread, ToolItem } from '../types';
import { useStore } from '../store';
import { duration } from '../lib/format';
import { useNow, useStickToBottom } from '../lib/hooks';
import { Markdown } from './Markdown';
import { ItemView } from './TurnView';
import { collapse } from './ToolRow';
import { spring } from './Popover';
import { t } from '../i18n';

export const AGENT_COLORS = ['#e07a52', '#4d8ef7', '#c678dd', '#4fbf7f', '#e5b567', '#56b6c2', '#f472b6', '#9ccc65'];
export const agentColor = (a?: AgentRun) => AGENT_COLORS[(a?.color ?? 0) % AGENT_COLORS.length];

const useAgent = (id: string) => useStore((s) => s.threads[s.activeId]?.agents?.[id]);

function AgentName({ agent }: { agent?: AgentRun }) {
  return (
    <span className="agent-name" style={{ color: agentColor(agent) }}>
      {agent?.name ?? t('agents.agent')}
    </span>
  );
}

function statusText(a: AgentRun) {
  if (a.status === 'running') return t('agents.running');
  if (a.status === 'error') return t('agents.failed');
  if (a.status === 'stopped') return t('agents.stopped');
  return t('agents.done');
}

/** Feed row for an Agent/Task call (Codex style: coloured spark + name + status). */
export const AgentRow = memo(function AgentRow({ item }: { item: ToolItem }) {
  const agent = useAgent(item.id);
  const openAgent = useStore((s) => s.openAgent);
  // Another agent working for this one (run_agent) is labelled with its own name.
  const provider = useStore((s) => (agent?.provider ? s.providers[agent.provider]?.label ?? agent.provider : null));
  const running = agent ? agent.status === 'running' : item.status === 'running';
  const now = useNow(running);
  const steps = agent?.toolUses || item.subSteps;
  if (!agent && item.status === 'error') {
    return (
      <div className="step">
        <div className="step-row" title={item.result}>
          <Sparkles size={14} className="step-icon" />
          <span className="step-text muted">{t('agents.startFailed', { name: item.input?.name || item.input?.description })}</span>
          <X size={13} className="err-icon" />
        </div>
      </div>
    );
  }
  const meta = [
    steps ? t('agents.steps', { count: steps }) : null,
    agent && (agent.endedAt || running) ? duration((agent.endedAt ?? now) - agent.startedAt) : null,
    running ? agent?.progress ?? item.lastSub : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="step">
      <button className="step-row agent-row" onClick={() => openAgent(item.id)} title={t('agents.openConversation')}>
        <Sparkles size={14} className="step-icon" style={{ color: agentColor(agent), opacity: 1 }} />
        <span className="step-text">
          <span className="muted">{provider ?? t('agents.agentPrefix')} </span>
          <AgentName agent={agent ?? ({ name: item.input?.name || item.input?.description, color: 0 } as AgentRun)} />
          <span className={running ? 'shimmer' : 'muted'}> {agent ? statusText(agent) : running ? t('agents.running') : t('agents.done')}</span>
        </span>
        {meta && <span className="step-meta">{meta}</span>}
        {agent?.background && <span className="chip">{t('agents.background')}</span>}
        <ChevronRight size={13} className="step-chevron" style={{ opacity: 0.7 }} />
      </button>
    </div>
  );
});

/** Feed row for the lead's SendMessage to a running agent. */
export const AgentSendRow = memo(function AgentSendRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const agents = useStore((s) => s.threads[s.activeId]?.agents);
  const to = String(item.input?.to ?? '');
  const agent = agents && Object.values(agents).find((a) => a.name === to || a.id === to);
  const text = String(item.input?.message ?? item.input?.content ?? '');
  return (
    <div className={`step ${open ? 'is-open' : ''}`}>
      <button className="step-row" onClick={() => setOpen((v) => !v)}>
        <MessageSquare size={14} className="step-icon" />
        <span className="step-text">
          {t('agents.messageSentTo')} <AgentName agent={agent ?? ({ name: to || t('agents.messageSentFallback'), color: 0 } as AgentRun)} />
        </span>
        <ChevronRight size={13} className="step-chevron" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="step-details" {...collapse}>
            <div className="agent-bubble to" style={{ borderLeftColor: agentColor(agent) }}>
              <Markdown text={text} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/** Feed marker: "<agent> finished". */
export function AgentEventRow({ item }: { item: AgentEventItem }) {
  const agent = useAgent(item.agentId);
  const openAgent = useStore((s) => s.openAgent);
  const ok = item.status === 'done';
  return (
    <div className="step">
      <button className="step-row" onClick={() => openAgent(item.agentId)}>
        <Sparkles size={14} className="step-icon" style={{ color: agentColor(agent), opacity: 1 }} />
        <span className="step-text">
          <AgentName agent={agent} />
          <span className="muted"> {agent ? statusText({ ...agent, status: item.status }) : t('agents.done')}</span>
        </span>
        {ok ? <Check size={13} className="ok-icon" /> : <X size={13} className="err-icon" />}
      </button>
    </div>
  );
}

/** Message card between lead Claude and an agent (task, follow-up, report). */
export function AgentMessageCard({ item }: { item: AgentMessageItem }) {
  const agent = useAgent(item.agentId);
  const lead = useStore((s) => s.providers[s.threads[s.activeId]?.provider ?? 'claude']?.label ?? 'Claude');
  const [full, setFull] = useState(item.dir === 'from' || item.text.length < 900);
  return (
    <div className={`agent-bubble ${item.dir}`} style={{ borderLeftColor: agentColor(agent) }}>
      <div className="agent-bubble-head">
        {item.dir === 'to' ? (
          <>
            <span>{lead}</span>
            <ArrowRight size={12} />
            <AgentName agent={agent} />
          </>
        ) : (
          <>
            <AgentName agent={agent} />
            <CornerDownLeft size={12} />
            <span>{lead}</span>
          </>
        )}
        {item.label && <span className="chip">{item.label}</span>}
      </div>
      <div className={full ? '' : 'agent-bubble-clip'}>
        <Markdown text={item.text} />
      </div>
      {!full && (
        <button className="side-more" onClick={() => setFull(true)}>
          {t('agents.showFull')}
        </button>
      )}
    </div>
  );
}

function AgentChip({ agent, active, onClick }: { agent: AgentRun; active: boolean; onClick: () => void }) {
  const running = agent.status === 'running';
  return (
    <button className={`agent-chip ${active ? 'is-on' : ''}`} onClick={onClick} title={agent.name}>
      {active && <motion.span layoutId="agent-chip-bg" className="tab-bg" transition={spring} />}
      <span className="agent-dot" style={{ background: agentColor(agent) }}>
        {running && <span className="agent-dot-pulse" style={{ background: agentColor(agent) }} />}
      </span>
      <span className="truncate">{agent.name}</span>
      {!running && (agent.status === 'done' ? <Check size={12} className="ok-icon" /> : <X size={12} className="err-icon" />)}
    </button>
  );
}

function AgentDetail({ thread, agent, onCollapse }: { thread: Thread; agent: AgentRun; onCollapse: () => void }) {
  const [shown, setShown] = useState(100);
  const [message,setMessage]=useState(''),[sending,setSending]=useState(false),[messageError,setMessageError]=useState('');
  const messageAgent=useStore(s=>s.messageAgent);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stopTask = useStore((s) => s.stopTask);
  const loadTranscript = useStore((s) => s.loadAgentTranscripts);
  const running = agent.status === 'running';
  const now = useNow(running);
  const { pin } = useStickToBottom(scrollRef, [agent.id, agent.items.length]);
  useEffect(() => {
    pin();
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  const task = Object.values(thread.tasks).find((x) => x.toolUseId === agent.id && (x.status === 'running' || x.status === 'pending'));
  const head = (agent.result ?? '').trim().slice(0, 60);
  const reported =
    agent.items.some((x) => x.kind === 'agentmsg' && x.dir === 'from') ||
    (head.length > 0 && agent.items.some((x) => x.kind === 'text' && x.text.includes(head)));

  return (
    <div className="agent-detail">
      <div className="agent-head">
        <Sparkles size={15} style={{ color: agentColor(agent) }} />
        <AgentName agent={agent} />
        {agent.type && <span className="chip">{agent.type}</span>}
        {agent.model && <span className="chip">{agent.model}</span>}
        <span className={`muted small ${running ? 'shimmer' : ''}`}>
          {statusText(agent)}
          {agent.startedAt > 0 && ` · ${duration((agent.endedAt ?? now) - agent.startedAt)}`}
          {agent.toolUses ? ` · ${t('agents.steps', { count: agent.toolUses })}` : ''}
        </span>
        <div className="spacer" />
        {running && (task||(agent.runId&&window.desk.nativeHistoryPaging===true)) && (
          <button className="pill sm tone-danger" onClick={() => stopTask(thread.id, agent.runId??task!.id)}>
            <Square size={10} fill="currentColor" /> {t('agents.stop')}
          </button>
        )}
        <button className="icon-btn sm" title={t('agents.collapse')} onClick={onCollapse}>
          <ChevronUp size={14} />
        </button>
      </div>
      <div className="agent-scroll" ref={scrollRef}>
        <div className="items">
          {agent.transcriptCursor!==undefined&&<button className="side-more" onClick={()=>loadTranscript(thread.id,agent.id,agent.transcriptCursor)}>{t('agents.showEarlier',{count:40})}</button>}
          {agent.items.length > shown && <button className="side-more" onClick={() => setShown((n) => n + 100)}>{t('agents.showEarlier', { count: agent.items.length - shown })}</button>}
          {agent.items.slice(-shown).map((it) => (
            <motion.div key={it.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
              <ItemView item={it} live={running} cwd={thread.cwd} />
            </motion.div>
          ))}
          {agent.historical && !agent.transcriptLoaded && <div className="muted small">{t('agents.loadingTranscript')}</div>}
          {running && <div className="step busy"><span className="step-text shimmer">{agent.progress ?? t('agents.working')}</span></div>}
          {!running && agent.result && !reported && (
            <AgentMessageCard item={{ kind: 'agentmsg', id: 'result', agentId: agent.id, dir: 'from', text: agent.result, label: t('agents.result') }} />
          )}
        </div>
      </div>
      {agent.runId&&window.desk.nativeHistoryPaging===true&&<form className="agent-message-form" onSubmit={async e=>{e.preventDefault();if(!message.trim()||sending)return;setSending(true);setMessageError('');try{await messageAgent(thread.id,agent.runId!,message.trim());setMessage('');}catch(error:any){setMessageError(String(error?.message??error));}finally{setSending(false);}}}>
        <input className="input" aria-label={t('agents.sendMessage')} placeholder={t('agents.messagePlaceholder')} value={message} maxLength={16000} onChange={e=>setMessage(e.target.value)}/>
        <button className="btn" type="submit" disabled={sending||!message.trim()}>{t('agents.sendMessage')}</button>
        {messageError&&<span className="small tone-danger" role="alert">{messageError}</span>}
      </form>}
    </div>
  );
}

/** All agents as rows (the view with the conversation hidden). */
function AgentList({ agents, onOpen }: { agents: AgentRun[]; onOpen: (id: string) => void }) {
  const now = useNow(agents.some((a) => a.status === 'running'));
  return (
    <div className="agent-list">
      {agents.map((a) => {
        const running = a.status === 'running';
        return (
          <button key={a.id} className="agent-list-row" onClick={() => onOpen(a.id)} title={t('agents.openConversation')}>
            <span className="agent-dot" style={{ background: agentColor(a) }}>
              {running && <span className="agent-dot-pulse" style={{ background: agentColor(a) }} />}
            </span>
            <span className="agent-list-text">
              <span className="agent-list-name">
                <span className="truncate">{a.name}</span>
                {a.type && <span className="chip">{a.type}</span>}
              </span>
              <span className={`muted small truncate ${running ? 'shimmer' : ''}`}>
                {statusText(a)}
                {a.startedAt > 0 && ` · ${duration((a.endedAt ?? now) - a.startedAt)}`}
                {a.toolUses ? ` · ${t('agents.steps', { count: a.toolUses })}` : ''}
                {running && a.progress ? ` · ${a.progress}` : ''}
              </span>
            </span>
            {!running && (a.status === 'done' ? <Check size={13} className="ok-icon" /> : <X size={13} className="err-icon" />)}
          </button>
        );
      })}
    </div>
  );
}

export function AgentsTab({ thread }: { thread: Thread }) {
  const focus = useStore((s) => s.focusAgent);
  const openAgent = useStore((s) => s.openAgent);
  // The conversation view can be hidden to see every agent at once; remembered across chats.
  const collapsed = useStore((s) => s.settings.agentsCollapsed);
  const setCollapsed = (v: boolean) => useStore.getState().setSettings({ agentsCollapsed: v });
  // Newest first: by start time, then by creation index (color) when timestamps tie or are missing.
  const agents = Object.values(thread.agents).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || b.color - a.color);
  const selected = (focus && thread.agents[focus]) || agents.find((a) => a.status === 'running') || agents[0];
  if (!agents.length) return <div className="changes-empty muted">{t('agents.empty')}</div>;
  if (collapsed) {
    return (
      <div className="agents-tab">
        <AgentList
          agents={agents}
          onOpen={(id) => {
            setCollapsed(false);
            openAgent(id);
          }}
        />
      </div>
    );
  }
  return (
    <div className="agents-tab">
      <div className="agent-chips">
        {agents.map((a) => (
          <AgentChip
            key={a.id}
            agent={a}
            active={a.id === selected?.id}
            // Clicking the open agent again hides its conversation.
            onClick={() => (a.id === selected?.id ? setCollapsed(true) : openAgent(a.id))}
          />
        ))}
      </div>
      {selected && <AgentDetail key={selected.id} thread={thread} agent={selected} onCollapse={() => setCollapsed(true)} />}
    </div>
  );
}
