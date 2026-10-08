import type { BrowserState, WorktreeInfo, ContextUsage, Effort, GitStatus, ImageAttachment, PermMode, ProviderId, SessionInfo } from './types';
import type { DeskEvent } from './events';

type Unsubscribe = () => void;

interface SendPayload {
  threadId: string;
  provider?: ProviderId;
  cwd: string;
  model: string;
  effort?: Effort;
  permissionMode: PermMode;
  resume?: string;
  text: string;
  images?: ImageAttachment[];
  uuid?: string;
  chrome?: boolean;
  /** Extra folders Claude may read and edit (project folders besides cwd). */
  dirs?: string[];
  priority?: 'now' | 'next' | 'later';
  /** Extra system instructions for a run that starts with this message (context handed over from another agent). */
  instructions?: string;
}

/** What a provider reports about itself (agent:probe → providers[id]). */
export interface ProviderProbe {
  available: boolean;
  error?: string;
  label: string;
  /** Colour and letter that mark the agent's chats. */
  brand?: { color: string; mark: string };
  version?: string;
  models: any[];
  account?: any;
  commands?: any[];
  usage?: any;
  caps: Record<string, any>;
}

declare global {
  interface Window {
    desk: {
      platform: string;
      getPathForFile?(file: File): string;
      /** Feature modules: invoke a namespaced channel (pr:, search:, sched:, voice:, instr:). */
      call<T = any>(channel: string, ...args: any[]): Promise<T>;
      subscribe<T = any>(channel: string, cb: (payload: T) => void): Unsubscribe;
      probe(force?: boolean): Promise<{ models: any[]; account: any; commands: any[]; usage: any; providers: Record<string, ProviderProbe> }>;
      usage(provider?: ProviderId): Promise<any>;
      listSessions(): Promise<SessionInfo[]>;
      loadSession(sessionId: string, cwd?: string, segment?: number, provider?: ProviderId): Promise<DeskEvent[]>;
      /** Earlier parts of a session file (before in-file compactions), newest first. */
      segments(sessionId: string, cwd?: string, provider?: ProviderId): Promise<{ segment: number; count: number; ts: string }[]>;
      renameSession(sessionId: string, title: string, cwd?: string, provider?: ProviderId): Promise<void>;
      deleteSession(sessionId: string, cwd?: string, provider?: ProviderId): Promise<void>;
      send(payload: SendPayload): Promise<boolean>;
      configure(payload: { threadId: string; model?: string; effort?: Effort; permissionMode?: PermMode }): Promise<boolean>;
      interrupt(threadId: string): Promise<boolean>;
      respondPermission(payload: {
        threadId: string;
        reqId: string;
        decision: 'allow' | 'always' | 'deny';
        updatedInput?: any;
        message?: string;
      }): Promise<boolean>;
      closeThread(threadId: string): Promise<void>;
      autoTitle(payload: { sessionId: string; cwd: string; text: string; provider?: ProviderId }): Promise<string | null>;
      openTargets(): Promise<{ id: string; label: string }[]>;
      stopTask(threadId: string, taskId: string): Promise<boolean>;
      loadSubagents(sessionId: string, cwd?: string, provider?: ProviderId): Promise<DeskEvent[]>;
      contextUsage(threadId: string): Promise<ContextUsage | null>;
      browserSetBounds(b: { x: number; y: number; width: number; height: number }): Promise<void>;
      browserSetVisible(v: boolean, key?: string): Promise<void>;
      browserNavigate(url: string, key: string): Promise<BrowserState>;
      browserControl(action: 'back' | 'forward' | 'reload' | 'stop' | 'external' | 'devtools', key: string): Promise<BrowserState>;
      browserState(key: string): Promise<BrowserState>;
      onBrowserState(cb: (s: BrowserState & { key: string }) => void): Unsubscribe;
      onBrowserShow(cb: (e: { key: string }) => void): Unsubscribe;
      filesList(dir: string): Promise<{ name: string; path: string; dir: boolean; dim: boolean }[]>;
      filesRead(p: string): Promise<{ text?: string; mtime?: number; size: number; binary?: boolean; tooLarge?: boolean }>;
      filesWrite(p: string, text: string): Promise<{ mtime: number }>;
      filesWatch(p: string): Promise<void>;
      filesUnwatch(p: string): Promise<void>;
      onFileChanged(cb: (e: { path: string }) => void): Unsubscribe;
      termCreate(opts: { id: string; cwd: string; cols: number; rows: number }): Promise<{ id: string; shell: string }>;
      termWrite(id: string, data: string): Promise<void>;
      termResize(id: string, cols: number, rows: number): Promise<void>;
      termKill(id: string): Promise<void>;
      onTermData(cb: (e: { id: string; data: string }) => void): Unsubscribe;
      onTermExit(cb: (e: { id: string; exitCode: number }) => void): Unsubscribe;
      statsSummary(days: number): Promise<{ turns: any[]; limits: any[] }>;
      mcpStatus(provider?: ProviderId): Promise<{ name: string; status: string; scope?: string; tools: number; error?: string }[]>;
      mcpReconnect(name: string, provider?: ProviderId): Promise<void>;
      mcpAdd(p: { name: string; transport: 'stdio' | 'http' | 'sse'; target: string; args?: string[]; scope?: 'user' | 'project' | 'local'; env?: Record<string, string>; provider?: ProviderId }): Promise<string>;
      mcpRemove(name: string, scope?: string, provider?: ProviderId): Promise<string>;
      buildInfo(): Promise<{ canRebuild: boolean; newer: boolean }>;
      rebuild(): Promise<boolean>;
      relaunch(): Promise<void>;
      onUpdateAvailable(cb: () => void): Unsubscribe;
      wtIsRepo(cwd: string): Promise<boolean>;
      wtCreate(cwd: string): Promise<WorktreeInfo>;
      wtApply(dir: string): Promise<{ applied: boolean; files: number; list?: string[] }>;
      wtRemove(dir: string): Promise<boolean>;
      wtAll(): Promise<Record<string, WorktreeInfo>>;
      rewind(payload: {
        threadId: string;
        uuid: string;
        dryRun?: boolean;
        config: { provider?: ProviderId; cwd: string; model: string; effort?: Effort; permissionMode: PermMode; resume?: string };
      }): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }>;
      fork(payload: { sessionId: string; cwd?: string; uuid?: string; provider?: ProviderId }): Promise<string>;
      rewindConversation(payload: { threadId: string; resumeAt: string | null; dropTurns?: number; sessionId?: string; provider?: ProviderId }): Promise<boolean>;
      backgroundTask(threadId: string, toolUseId: string): Promise<boolean>;
      taskOutput(file: string): Promise<{ text: string; truncated: boolean } | null>;
      gitStatus(cwd: string): Promise<GitStatus>;
      gitCommit(root: string, files: string[], message: string): Promise<string>;
      gitPush(root: string): Promise<boolean>;
      gitPull(root: string): Promise<boolean>;
      gitDiscard(root: string, file: string, untracked: boolean): Promise<boolean>;
      gitBranches(root: string): Promise<string[]>;
      gitCheckout(root: string, branch: string, create: boolean): Promise<boolean>;
      commitMessage(root: string, files: string[]): Promise<string>;
      gitFileDiff(root: string, file: string, untracked: boolean): Promise<{ kind: 'diff' | 'new' | 'binary' | 'too-large' | 'dir'; text?: string }>;
      openIn(id: string, cwd: string): Promise<boolean>;
      getSettings(): Promise<Record<string, any>>;
      setSettings(ui: Record<string, any>): Promise<Record<string, any>>;
      setTheme(resolved: 'dark' | 'light'): Promise<void>;
      pickFolder(): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      openPath(p: string): Promise<string>;
      showInFolder(p: string): Promise<void>;
      gitBranch(cwd: string): Promise<string | null>;
      pathExists(p: string): Promise<boolean>;
      onEvent(cb: (p: { threadId: string; ev: DeskEvent }) => void): Unsubscribe;
      onPermission(cb: (p: any) => void): Unsubscribe;
      onPermissionCancel(cb: (p: { threadId: string; reqId: string }) => void): Unsubscribe;
      onClosed(cb: (p: { threadId: string; error: string | null; stderr?: string }) => void): Unsubscribe;
    };
  }
}

export {};
