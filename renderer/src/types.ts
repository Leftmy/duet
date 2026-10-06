export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';
export type ThemePref = 'system' | 'dark' | 'light';

export interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportedEffortLevels?: Effort[];
  supportsAutoMode?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** User-defined project: a named group of chats with the folders Claude may use. */
export interface Project {
  id: string;
  name: string;
  /** First folder is the working directory of new chats; the rest are added as extra directories. */
  folders: string[];
  createdAt: number;
  /** Defaults for new chats in this project (unset = global defaults). */
  defaults?: { model?: string; effort?: Effort; permissionMode?: PermMode; workMode?: 'local' | 'worktree' };
}

export interface SessionInfo {
  sessionId: string;
  title: string;
  cwd: string;
  gitBranch?: string;
  lastModified: number;
  createdAt?: number;
  /** Earlier segment of the session file (before an in-file context compaction). */
  segment?: number;
}

export interface ImageAttachment {
  id: string;
  mediaType: string;
  data: string;
  name?: string;
}

export interface TextItem {
  kind: 'text';
  id: string;
  msgId?: string;
  text: string;
  confirmed: boolean;
}

export interface ThinkingItem {
  kind: 'thinking';
  id: string;
  msgId?: string;
  text: string;
  confirmed: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  input: any;
  inputJson: string;
  status: 'running' | 'done' | 'error';
  result?: string;
  startedAt: number;
  endedAt?: number;
  subSteps: number;
  lastSub?: string;
  subs?: string[];
  images?: { mediaType: string; data: string }[];
}

export interface NoticeItem {
  kind: 'notice';
  id: string;
  text: string;
  tone: 'info' | 'warn' | 'error';
}

/** A message between the lead Claude and a subagent (task prompt, SendMessage, final report). */
export interface AgentMessageItem {
  kind: 'agentmsg';
  id: string;
  agentId: string;
  dir: 'to' | 'from';
  text: string;
  label?: string;
}

/** Feed marker for an agent finishing (Codex: "X finished"). */
export interface AgentEventItem {
  kind: 'agentevent';
  id: string;
  agentId: string;
  status: AgentRun['status'];
}

/** A message the user sent while Claude was working, folded into the running turn. */
export interface SteerItem {
  kind: 'steer';
  id: string;
  text: string;
  images?: ImageAttachment[];
  delivered: boolean;
}

export type Item = TextItem | ThinkingItem | ToolItem | NoticeItem | AgentMessageItem | AgentEventItem | SteerItem;

export interface AgentRun {
  id: string;
  name: string;
  type?: string;
  model?: string;
  prompt: string;
  color: number;
  status: 'running' | 'done' | 'error' | 'stopped';
  background: boolean;
  startedAt: number;
  endedAt?: number;
  items: Item[];
  result?: string;
  progress?: string;
  toolUses: number;
  historical?: boolean;
  transcriptLoaded?: boolean;
}

export interface Turn {
  kind: 'turn';
  id: string;
  items: Item[];
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  done: boolean;
  error?: string;
  interrupted?: boolean;
  historical?: boolean;
  /** uuid of the last transcript message in this turn (fork point). */
  lastUuid?: string;
  /** uuids of assistant messages in this turn (search reveal). */
  uuids?: string[];
}

export interface UserEntry {
  kind: 'user';
  id: string;
  uuid?: string;
  /** Context summary that starts a continued session (rendered collapsed). */
  summary?: boolean;
  text: string;
  images?: ImageAttachment[];
  ts: number;
}

export type Entry = Turn | UserEntry;

export interface Approval {
  reqId: string;
  toolName: string;
  input: any;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  canAlways: boolean;
  toolUseID?: string;
  agentID?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  images: ImageAttachment[];
}

export interface BgTask {
  id: string;
  description: string;
  type?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'stopped' | 'paused';
  background: boolean;
  startedAt: number;
  endedAt?: number;
  toolUseId?: string;
  toolUses?: number;
  lastTool?: string;
  summary?: string;
  outputFile?: string;
  error?: string;
  dismissed?: boolean;
}

export interface GitFile {
  path: string;
  abs: string;
  status: 'new' | 'added' | 'modified' | 'deleted' | 'renamed';
  untracked: boolean;
  add: number;
  del: number;
  binary?: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  root?: string;
  branch?: string | null;
  files: GitFile[];
  hasHead?: boolean;
  upstream?: boolean;
  ahead?: number;
  behind?: number;
}

export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: { name: string; tokens: number; color: string }[];
}

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface WorktreeInfo {
  path: string;
  base: string;
  branch: string;
  baseCommit: string;
  baseBranch?: string | null;
  createdAt: number;
  removed?: boolean;
}

export interface Thread {
  /** Earlier parts of a conversation continued after context ran out (newest first) and how many are loaded. */
  chain?: SessionInfo[];
  chainLoaded?: number;
  chainExpanded?: boolean;
  /** 'worktree' chats run in an isolated checkout; worktree is set once it exists. */
  workMode?: 'local' | 'worktree';
  worktree?: WorktreeInfo;
  context?: ContextUsage;
  tasks: Record<string, BgTask>;
  agents: Record<string, AgentRun>;
  id: string;
  sessionId?: string;
  title: string;
  cwd: string;
  model: string;
  effort: Effort;
  permissionMode: PermMode;
  entries: Entry[];
  status: 'idle' | 'running';
  loaded: boolean;
  loading?: boolean;
  approvals: Approval[];
  activity?: string;
  queue: QueuedMessage[];
  draft: string;
  draftImages: ImageAttachment[];
  stopRequested?: boolean;
  autoTitled?: boolean;
  /** Project a new chat was created in (persisted per session once it has an id). */
  projectId?: string;
}

export interface LimitWindow {
  pct: number;
  resetsAt?: string | number | null;
}

export interface UsageSummary {
  session?: LimitWindow;
  weekly?: LimitWindow;
  plan?: string | null;
}

export interface Account {
  email?: string;
  organization?: string;
  subscriptionType?: string;
}
