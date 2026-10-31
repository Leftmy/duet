import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { CircleHelp, ListChecks, ShieldQuestion } from 'lucide-react';
import type { Approval, ToolItem } from '../types';
import { useStore } from '../store';
import { toolDiff, toolKind } from '../lib/tools';
import { basename } from '../lib/format';
import { DiffView } from './ToolRow';
import { Markdown } from './Markdown';
import { spring } from './Popover';
import { t } from '../i18n';
import { McpFormApproval, PermissionApproval } from './CodexApproval';

const cardMotion = {
  initial: { opacity: 0, y: 14, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.14 } },
  transition: spring,
};

function askTitle(a: Approval) {
  const i = a.input ?? {};
  const file = basename(i.file_path ?? i.notebook_path ?? i.path ?? '');
  switch (toolKind(a.toolName)) {
    case 'shell':
      return t('approval.askCommand');
    case 'write':
      return t('approval.askWrite', { file });
    case 'edit':
      return t('approval.askEdit', { file });
    case 'read':
      return t('approval.askRead', { file });
    case 'web': {
      if (a.toolName !== 'WebFetch') return t('approval.askWebSearch');
      let host = String(i.url ?? '');
      try {
        host = new URL(host).host;
      } catch {}
      return t('approval.askFetch', { host });
    }
    case 'agent':
      return t('approval.askAgent');
    case 'mcp': {
      const [, server, ...rest] = a.toolName.split('__');
      return t('approval.askMcp', { server, tool: rest.join('__') });
    }
    default:
      return t('approval.askTool', { name: a.displayName ?? a.toolName });
  }
}

function asItem(a: Approval): ToolItem {
  return { kind: 'tool', id: a.toolUseID ?? a.reqId, name: a.toolName, input: a.input, inputJson: '', status: 'running', startedAt: 0, subSteps: 0 };
}

function Questions({ threadId, approval }: { threadId: string; approval: Approval }) {
  const respond = useStore((s) => s.respond);
  const questions: any[] = approval.input?.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const toggle = (q: any, label: string) =>
    setPicked((p) => {
      const key=q.id??q.question,cur = p[key] ?? [];
      if (q.multiSelect) return { ...p, [key]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      return { ...p, [key]: [label] };
    });

  const answers = Object.fromEntries(
    questions.map((q) => {
      const key=q.id??q.question,vals = [...(picked[key] ?? [])];
      if (other[key]?.trim()) vals.push(other[key].trim());
      return [key, vals];
    }),
  );
  const complete = questions.every((q) => answers[q.id??q.question]?.length);

  return (
    <motion.div className="approval" {...cardMotion}>
      <div className="approval-head">
        <CircleHelp size={15} />
        <span>{t('approval.question')}</span>
      </div>
      {questions.map((q) => (
        <div className="question" key={q.id??q.question}>
          {q.header && <span className="chip">{q.header}</span>}
          <div className="question-text">{q.question}</div>
          <div className="options">
            {(q.options ?? []).map((o: any) => {
              const on = (picked[q.id??q.question] ?? []).includes(o.label);
              return (
                <button key={o.label} className={`option ${on ? 'is-on' : ''}`} onClick={() => toggle(q, o.label)}>
                  <span className="option-label">{o.label}</span>
                  {o.description && <span className="option-hint">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            className="input"
            placeholder={t('approval.otherAnswer')}
            type={q.isSecret?'password':'text'} autoComplete="off"
            value={other[q.id??q.question] ?? ''}
            onChange={(e) => setOther((o) => ({ ...o, [q.id??q.question]: e.target.value }))}
          />
        </div>
      ))}
      <div className="approval-actions">
        <button className="btn ghost" onClick={() => respond(threadId, approval, 'deny', { message: 'The user skipped the question.' })}>
          {t('approval.skip')}
        </button>
        <button
          className="btn primary"
          disabled={!complete}
          onClick={() => respond(threadId, approval, 'allow', { updatedInput: { ...approval.input, answers:Object.fromEntries(questions.map(q=>[q.question,answers[q.id??q.question].join(', ')])),...(questions.some(q=>q.id)?{answerValues:answers}:{}) } })}
        >
          {t('approval.answer')}
        </button>
      </div>
    </motion.div>
  );
}

function PlanApproval({ threadId, approval }: { threadId: string; approval: Approval }) {
  const respond = useStore((s) => s.respond);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const [feedback, setFeedback] = useState('');
  return (
    <motion.div className="approval" {...cardMotion}>
      <div className="approval-head">
        <ListChecks size={15} />
        <span>{t('approval.planReady')}</span>
      </div>
      <div className="approval-scroll">
        <Markdown text={approval.input?.plan ?? ''} />
      </div>
      <textarea
        className="input"
        rows={2}
        placeholder={t('approval.planFeedback')}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className="approval-actions">
        <button
          className="btn ghost"
          onClick={() =>
            respond(threadId, approval, 'deny', {
              message: feedback.trim() ? `Revise the plan: ${feedback.trim()}` : 'Keep planning; the user wants changes.',
            })
          }
        >
          {t('approval.revisePlan')}
        </button>
        <button
          className="btn"
          onClick={() => {
            setPermissionMode(threadId, 'default');
            respond(threadId, approval, 'allow');
          }}
        >
          {t('approval.runWithApprovals')}
        </button>
        <button
          className="btn primary"
          autoFocus
          onClick={() => {
            setPermissionMode(threadId, 'acceptEdits');
            respond(threadId, approval, 'allow');
          }}
        >
          {t('approval.run')}
        </button>
      </div>
    </motion.div>
  );
}

function ToolApproval({ threadId, approval, cwd }: { threadId: string; approval: Approval; cwd: string }) {
  const respond = useStore((s) => s.respond);
  const item = useMemo(() => asItem(approval), [approval]);
  const kind = toolKind(approval.toolName);
  const diff = kind === 'edit' || kind === 'write' ? toolDiff(item) : null;
  const i = approval.input ?? {};
  const title = askTitle(approval);
  const showDescription = approval.description && (kind === 'other' || kind === 'mcp' || kind === 'agent');

  return (
    <motion.div
      className="approval"
      {...cardMotion}
      onKeyDown={(e) => {
        if (e.key === 'Escape') respond(threadId, approval, 'deny');
      }}
    >
      <div className="approval-head">
        <ShieldQuestion size={15} />
        <span>{title}</span>
      </div>
      {showDescription && <div className="muted small">{approval.description}</div>}
      {kind === 'shell' && (
        <div className="detail-card terminal">
          <pre className="detail-out">
            <span className="prompt">$ </span>
            {i.command}
          </pre>
        </div>
      )}
      {kind === 'shell' && i.description && <div className="muted small">{i.description}</div>}
      {diff && (
        <div className="detail-card">
          <div className="detail-path">{String(i.file_path ?? '').replace(cwd, '').replace(/^[\\/]/, '')}</div>
          <div className="approval-scroll">
            <DiffView lines={diff} max={250} />
          </div>
        </div>
      )}
      {kind !== 'shell' && !diff && (
        <div className="detail-card">
          <pre className="detail-out">{JSON.stringify(i, null, 2).slice(0, 4000)}</pre>
        </div>
      )}
      {approval.decisionReason && <div className="muted small">{approval.decisionReason}</div>}
      {approval.blockedPath && <div className="muted small">{t('approval.outsidePath', { path: approval.blockedPath })}</div>}
      <div className="approval-actions">
        <button className="btn ghost" onClick={() => respond(threadId, approval, 'deny')}>
          {t('approval.deny')} <kbd>Esc</kbd>
        </button>
        {approval.canAlways && (
          <button className="btn" onClick={() => respond(threadId, approval, 'always')}>
            {t('approval.always')}
          </button>
        )}
        <button className="btn primary" autoFocus onClick={() => respond(threadId, approval, 'allow')}>
          {t('approval.allow')} <kbd>⏎</kbd>
        </button>
      </div>
    </motion.div>
  );
}

export function ApprovalCard({ threadId, approval, cwd }: { threadId: string; approval: Approval; cwd: string }) {
  if(approval.toolName==='CodexMcpForm')return <McpFormApproval threadId={threadId} approval={approval}/>;
  if(approval.toolName==='CodexPermissions')return <PermissionApproval threadId={threadId} approval={approval}/>;
  if (approval.toolName === 'AskUserQuestion') return <Questions threadId={threadId} approval={approval} />;
  if (approval.toolName === 'ExitPlanMode') return <PlanApproval threadId={threadId} approval={approval} />;
  return <ToolApproval threadId={threadId} approval={approval} cwd={cwd} />;
}
