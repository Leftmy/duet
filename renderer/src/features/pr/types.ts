// Shapes returned by the pr: IPC channels (src-tauri/src/core/pr.rs).

export type CheckBucket = 'ok' | 'failed' | 'pending' | 'skipped';

export interface PrCheck {
  name: string;
  status: 'pending' | 'completed';
  conclusion: string | null;
  url: string | null;
  bucket: CheckBucket;
}

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  baseRefName: string | null;
  checks: PrCheck[];
}

export interface PrStatus {
  ghInstalled: boolean;
  authed: boolean;
  isRepo: boolean;
  isGitHub: boolean;
  root?: string;
  repo: string | null;
  branch: string | null;
  defaultBranch: string | null;
  upstream: string | null;
  /** Commits not yet pushed to the upstream. */
  ahead: number;
  /** Commits on HEAD that the default branch does not have. */
  commitsAhead: number;
  pr?: PrInfo;
  error?: string;
}

export interface PrDraft {
  title: string;
  body: string;
}

export interface FailedLog {
  runId: number;
  name: string;
  url: string | null;
  log: string;
  truncated: boolean;
}

/** Normalize host error messages, including errors saved by older versions. */
export function errText(e: unknown): string {
  const s = String((e as any)?.message ?? e);
  return s.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}
