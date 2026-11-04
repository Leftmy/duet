// Desk event protocol: the one stream format every agent provider emits, live and when a saved
// session is loaded. Rust providers (src-tauri/src/core) translate their native messages into these;
// the renderer folds them into entries (lib/reduce.ts). Keep this contract and the native translator fixtures in sync.
import type { AgentRun, BgTask, ContextUsage, ImageAttachment, LimitWindow, PermMode } from './types';

export type ProviderId = 'claude' | 'codex' | 'antigravity' | 'kimi' | 'gemini';

/** Where a notice goes: 'open' starts a turn if none is open, 'feed' joins the open or the last turn, 'if-open' only an open turn. */
export type NoticeAt = 'open' | 'feed' | 'if-open';

export type DeskEvent = { timestamp?: number; agent?: string } & (
  | {type:'kimi.state';state:{goal?:any;settings?:Record<string,any>}}
  | {type:'role';role:'executor'|'reviewer'|'researcher'}
  | {type:'dispatch';phase:'queued'|'running'|'cancelled';reason:string}
  | {type:'message.receipt';id:string;status:'accepted'|'consumed'|'failed'|'cancelled';error?:string}
  | { type:'codex.state'; state:{goal?:CodexGoal|null;diff?:string;title?:string;settings?:Record<string,any>;questions?:{id:string;items:{title:string;options:string[]|null}[]}|null} }
  /** The provider's session id (first event of a run, and again after a resume). */
  | { type: 'session'; sessionId: string; model?: string; contextReplacement?: boolean; previousSessionId?: string }
  | { type: 'status'; activity: 'compacting' | 'retrying' | null; attempt?: number; max?: number; permissionMode?: PermMode }
  /** The agent started a model call: the chat is running and messages sent mid-turn have been picked up. */
  | { type: 'step' }
  /** Assistant text. 'delta' appends to a streaming item, 'final' sets the confirmed text. */
  | { type: 'text'; id: string; text: string; mode: 'delta' | 'final'; agent?: string }
  | { type: 'thinking'; id: string; text: string; mode: 'delta' | 'final' | 'end'; agent?: string }
  /** A tool call is created or its input updated; final = the input is complete. */
  | { type: 'tool'; id: string; name: string; input?: any; final?: boolean; agent?: string }
  /** Streaming fragment of a tool call's JSON input. */
  | { type: 'tool.delta'; id: string; json: string }
  /** Live output of a running tool (appended to its result until tool.result arrives). */
  | { type: 'tool.output'; id: string; chunk: string; agent?: string }
  | { type: 'tool.result'; id: string; status: 'done' | 'error'; result: string; images?: { mediaType: string; data: string }[]; agent?: string }
  /** A step inside the subagent that tool `id` spawned (shown as the tool row's progress). */
  | { type: 'tool.sub'; id: string; name: string; input: any }
  /** Transcript anchor of the open turn, used to rewind and fork. */
  | { type: 'mark'; uuid: string; assistant: boolean }
  /** A user message from a saved transcript (live ones are added by the UI when sent). */
  | { type: 'user'; uuid?: string; text: string; images?: ImageAttachment[]; summary?: boolean }
  /** code is a 'reduce.*' i18n key; text is shown as is. */
  | { type: 'notice'; code?: string; text?: string; params?: Record<string, unknown>; tone: 'info' | 'warn' | 'error'; at?: NoticeAt }
  | { type: 'task'; op: 'start'; id: string; description?: string; taskType?: string; background?: boolean; toolUseId?: string }
  | { type: 'task'; op: 'update'; id: string; status?: BgTask['status']; description?: string; background?: boolean; error?: string; endedAt?: number }
  | { type: 'task'; op: 'progress'; id: string; toolUses?: number; lastTool?: string }
  | { type: 'task'; op: 'end'; id: string; status: BgTask['status']; summary?: string; outputFile?: string; toolUses?: number; toolUseId?: string }
  | { type: 'task'; op: 'background'; tasks: { id: string; description: string; taskType?: string }[] }
  /** Creates or updates a subagent run; id is the tool call that spawned it. */
  | {
      type: 'agent';
      id: string;
      name?: string;
      prompt?: string;
      agentType?: string;
      model?: string;
      provider?: ProviderId;
      cwd?:string;
      role?:'executor'|'reviewer'|'researcher';
      background?: boolean;
      status?: AgentRun['status'];
      result?: string;
      progress?: string;
      toolUses?: number;
      /** Session of a subagent that is another agent's own run (desk-agents). */
      sessionId?: string;
      runId?: string;
      parentId?: string;
    }
  /** A message between the lead and a subagent; dedupe skips texts the agent already has. */
  | { type: 'agent.msg'; agent: string; id?: string; dir: 'to' | 'from'; text: string; label: 'assignment' | 'report' | 'message'; dedupe?: boolean }
  /** Feed marker "agent finished" (saved transcripts). */
  | { type: 'agent.mark'; id: string; status: AgentRun['status'] }
  /** The tool call never became an agent (rejected input). */
  | { type: 'agent.drop'; id: string }
  | { type: 'turn.end'; durationMs?: number; isError?: boolean; error?: string; text?: string; costUsd?: number; contextCheckpoint?: boolean; waitingAgents?:boolean }
  | { type: 'limits'; provider?: ProviderId; session?: LimitWindow; weekly?: LimitWindow; rejected?: boolean }
  /** Live context-window occupancy, for providers that report it with the stream. */
  | { type: 'context'; usage: ContextUsage });

export interface CodexGoal {objective:string;status:string;tokenBudget:number|null;tokensUsed:number;timeUsedSeconds:number}
