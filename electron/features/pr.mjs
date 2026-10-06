// Pull Requests + CI status for the Git tab. Uses the `gh` CLI and git without a shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../i18n.mjs';

const MAX_BUFFER = 32 * 1024 * 1024;
const TIMEOUT = 60000;
const PUSH_TIMEOUT = 120000;
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: '', NO_COLOR: '1', CLICOLOR: '0', GIT_TERMINAL_PROMPT: '0' };

function run(file, args, { cwd, timeout = TIMEOUT, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, windowsHide: true, maxBuffer: MAX_BUFFER, timeout, env: { ...process.env, ...GH_ENV, ...env } },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        const e = new Error((stderr || stdout || err.message).toString().trim());
        e.code = err.code;
        e.timedOut = Boolean(err.killed && err.signal);
        reject(e);
      },
    );
  });
}

const git = (cwd, args, timeout) => run('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout });

// ---------- gh discovery ----------
let ghPath = null;

function ghCandidates() {
  const env = process.env;
  const list = ['gh'];
  if (process.platform === 'win32') {
    if (env.ProgramFiles) list.push(path.join(env.ProgramFiles, 'GitHub CLI', 'gh.exe'));
    if (env['ProgramFiles(x86)']) list.push(path.join(env['ProgramFiles(x86)'], 'GitHub CLI', 'gh.exe'));
    if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'));
    if (env.USERPROFILE) list.push(path.join(env.USERPROFILE, 'scoop', 'shims', 'gh.exe'));
  } else {
    list.push('/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh');
  }
  return list;
}

/** Resolves the gh executable (PATH first, then common install dirs). Only positive results are cached. */
async function findGh() {
  if (ghPath) return ghPath;
  for (const c of ghCandidates()) {
    if (c !== 'gh' && !fs.existsSync(c)) continue;
    try {
      await run(c, ['--version'], { timeout: 10000 });
      ghPath = c;
      return c;
    } catch {}
  }
  return null;
}

/** Turns raw gh/git stderr into a short, localized message. */
function friendly(e, what = 'gh') {
  const msg = String(e?.message ?? e);
  if (e?.code === 'ENOENT') return what === 'git' ? t('pr.gitNotFound') : t('pr.ghNotFound');
  if (e?.timedOut) return t('pr.timeout', { what });
  if (/gh auth login|not logged in|authentication required|HTTP 401|Bad credentials/i.test(msg)) return t('pr.ghNotAuthed');
  if (/already exists/i.test(msg) && /pull request/i.test(msg)) return t('pr.prExists');
  if (/No commits between/i.test(msg)) return t('pr.noCommitsBetween');
  if (/must first push|has no upstream|not on any branch/i.test(msg)) return t('pr.pushFirst');
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(msg)) return t('pr.pushRejected');
  if (/Authentication failed|Permission denied|could not read Username|\b403\b/i.test(msg)) return t('pr.noAccess');
  if (/error connecting|Could not resolve host|timed out|ECONNRESET|network/i.test(msg)) return t('pr.noConnection');
  if (/not a git repository/i.test(msg)) return t('pr.notRepo');
  const tail = msg.split('\n').filter(Boolean).slice(-4).join('\n');
  return tail || t('pr.unknownError');
}

function fail(e, what) {
  throw new Error(friendly(e, what));
}

async function gh(cwd, args, timeout) {
  const bin = await findGh();
  if (!bin) throw new Error(t('pr.ghNotFound'));
  return run(bin, args, { cwd, timeout });
}

// ---------- git helpers ----------
async function repoRoot(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
}

const safeRef = (s) => typeof s === 'string' && /^[\w./-]+$/.test(s) && !s.startsWith('-') && !s.includes('..');

async function currentBranch(root) {
  const b = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!b || b === 'HEAD') throw new Error(t('pr.detachedHead'));
  return b;
}

async function originUrl(root) {
  try {
    return (await git(root, ['remote', 'get-url', 'origin'])).trim();
  } catch {
    return '';
  }
}

/** Remote branch to diff against: origin/<base> when it exists locally, else <base>. */
async function baseRef(root, base) {
  for (const ref of [`origin/${base}`, base]) {
    try {
      await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {}
  }
  throw new Error(t('pr.branchNotFound', { branch: base }));
}

async function defaultFromGit(root) {
  try {
    const s = (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    return s.replace(/^origin\//, '') || null;
  } catch {
    return null;
  }
}

async function remoteBranches(root) {
  const out = await git(root, ['branch', '-r', '--format=%(refname:short)']).catch(() => '');
  const names = out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('origin/') && s !== 'origin/HEAD' && s !== 'origin')
    .map((s) => s.slice('origin/'.length));
  return [...new Set(names)];
}

// ---------- checks ----------
function normCheck(c) {
  if (c?.__typename === 'StatusContext' || (c?.context && !c?.name)) {
    const st = String(c.state || '').toUpperCase();
    const pending = st === 'PENDING' || st === 'EXPECTED';
    return {
      name: c.context || 'status',
      status: pending ? 'pending' : 'completed',
      conclusion: pending ? null : st.toLowerCase(),
      url: c.targetUrl || null,
      bucket: pending ? 'pending' : st === 'SUCCESS' ? 'ok' : 'failed',
    };
  }
  const status = String(c?.status || '').toUpperCase();
  const concl = String(c?.conclusion || '').toUpperCase();
  let bucket;
  if (status && status !== 'COMPLETED') bucket = 'pending';
  else if (concl === 'SUCCESS') bucket = 'ok';
  else if (['NEUTRAL', 'SKIPPED', 'STALE'].includes(concl)) bucket = 'skipped';
  else if (!concl) bucket = 'pending';
  else bucket = 'failed';
  const name = c?.workflowName && c?.name && c.workflowName !== c.name ? `${c.workflowName} / ${c.name}` : c?.name || c?.workflowName || 'check';
  return {
    name,
    status: bucket === 'pending' ? 'pending' : 'completed',
    conclusion: concl ? concl.toLowerCase() : null,
    url: c?.detailsUrl || null,
    bucket,
  };
}

// ---------- AI-mention filter ----------
const BANNED = [/\bAI\b/, /\b(claude|anthropic|chatgpt|openai|copilot)\b/i, /generated with/i, /co-authored-by/i, /🤖/u];
const banned = (line) => BANNED.some((re) => re.test(line));

function cleanText(text) {
  return String(text ?? '')
    .split('\n')
    .filter((l) => !banned(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseDraft(raw, fallbackTitle) {
  let text = String(raw ?? '').trim();
  // Drop a wrapping code fence if the model added one.
  const fence = text.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  const lines = text.split('\n');
  let i = lines.findIndex((l) => l.trim());
  let title = i >= 0 ? lines[i] : '';
  title = title
    .replace(/^#+\s*/, '')
    .replace(/^[*_]*\s*title\s*[*_]*\s*:\s*[*_]*\s*/i, '')
    .replace(/^["'`*_]+|["'`*_]+$/g, '')
    .trim();
  let body = i >= 0 ? lines.slice(i + 1).join('\n') : '';
  body = body.replace(/^\s*[*_]*\s*(body|description)\s*[*_]*\s*:[*_]*\s*/i, '');
  if (!title || banned(title)) title = fallbackTitle;
  if (title.length > 70) title = title.slice(0, 69).replace(/\s+\S*$/, '') + '…';
  return { title, body: cleanText(body) };
}

function stripLog(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.replace(/^([^\t]*)\t([^\t]*)\t\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '$1 | $2 | '))
    .join('\n');
}

export function createPr(bridge) {
  /** Collects everything the PR section needs in one go. */
  async function status(cwd) {
    const base = { ghInstalled: false, authed: false, isRepo: false, isGitHub: false, branch: null, defaultBranch: null, upstream: null, ahead: 0, commitsAhead: 0, repo: null };
    const root = await repoRoot(cwd);
    const ghBin = await findGh();
    base.ghInstalled = Boolean(ghBin);
    if (!root) return base;
    base.isRepo = true;
    base.root = root;

    const [branch, url, upstream] = await Promise.all([
      git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()).catch(() => null),
      originUrl(root),
      git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).then((s) => s.trim()).catch(() => null),
    ]);
    base.branch = branch && branch !== 'HEAD' ? branch : null;
    base.upstream = upstream || null;
    if (upstream) base.ahead = Number((await git(root, ['rev-list', '--count', '@{u}..HEAD']).catch(() => '0')).trim()) || 0;
    base.isGitHub = /github/i.test(url);
    base.defaultBranch = await defaultFromGit(root);

    if (!ghBin) return base;
    try {
      await run(ghBin, ['auth', 'token'], { cwd: root, timeout: 15000 });
      base.authed = true;
    } catch (e) {
      // Older gh has no `auth token`; fall back to `auth status`.
      if (/unknown command/i.test(e.message)) {
        base.authed = await run(ghBin, ['auth', 'status'], { cwd: root, timeout: 20000 }).then(() => true, () => false);
      }
    }
    if (!base.authed || !url) return base;

    try {
      const repo = JSON.parse(await run(ghBin, ['repo', 'view', '--json', 'defaultBranchRef,nameWithOwner'], { cwd: root }));
      base.isGitHub = true;
      base.repo = repo.nameWithOwner ?? null;
      base.defaultBranch = repo.defaultBranchRef?.name || base.defaultBranch;
    } catch (e) {
      const m = friendly(e);
      if (m === t('pr.ghNotAuthed')) base.authed = false;
      else if (/none of the git remotes|not a GitHub|no git remotes|Could not resolve to a Repository/i.test(e.message)) base.isGitHub = false;
      else base.error = m;
      return base;
    }

    if (base.branch && base.defaultBranch) {
      const ref = await baseRef(root, base.defaultBranch).catch(() => null);
      if (ref) base.commitsAhead = Number((await git(root, ['rev-list', '--count', `${ref}..HEAD`]).catch(() => '0')).trim()) || 0;
    }

    if (base.branch && base.branch !== base.defaultBranch) {
      try {
        const out = await run(ghBin, ['pr', 'view', base.branch, '--json', 'number,title,url,state,isDraft,statusCheckRollup,reviewDecision,mergeable,baseRefName'], { cwd: root });
        const p = JSON.parse(out);
        base.pr = {
          number: p.number,
          title: p.title,
          url: p.url,
          state: p.state,
          isDraft: Boolean(p.isDraft),
          reviewDecision: p.reviewDecision || null,
          mergeable: p.mergeable || null,
          baseRefName: p.baseRefName || null,
          checks: (p.statusCheckRollup ?? []).map(normCheck),
        };
      } catch (e) {
        if (!/no pull requests found|no open pull requests/i.test(e.message)) base.error = friendly(e);
      }
    }
    return base;
  }

  async function branches(cwd) {
    const root = await repoRoot(cwd);
    if (!root) throw new Error(t('pr.notRepo'));
    return remoteBranches(root);
  }

  async function draft(cwd, baseBranch) {
    const root = await repoRoot(cwd);
    if (!root) throw new Error(t('pr.notRepo'));
    if (!safeRef(baseBranch)) throw new Error(t('pr.badBaseBranch'));
    const ref = await baseRef(root, baseBranch);
    const [log, stat, diff, branch] = await Promise.all([
      git(root, ['log', `${ref}..HEAD`, '--oneline', '--no-decorate', '-n', '60']).catch((e) => fail(e, 'git')),
      git(root, ['diff', `${ref}...HEAD`, '--stat']).catch(() => ''),
      git(root, ['diff', `${ref}...HEAD`]).catch(() => ''),
      currentBranch(root),
    ]);
    if (!log.trim()) throw new Error(t('pr.noCommitsVs', { branch: baseBranch }));
    const firstSubject = cleanText(log.trim().split('\n').pop().replace(/^\w+\s+/, '')) || branch;
    const prompt =
      'Write a GitHub pull request title and description for the changes below.\n' +
      'Rules:\n' +
      '- First line: the title only, in English, imperative mood, at most 70 characters, no prefix like "Title:", no quotes.\n' +
      '- Then an empty line, then a concise Markdown body in English with two sections:\n' +
      '  "## Summary" with 2-6 short bullets describing what changed and why,\n' +
      '  "## Testing" with 1-3 short bullets on how it was or can be verified.\n' +
      '- Do not invent details that are not supported by the commits or diff.\n' +
      '- Never mention AI, assistants, tools used to write the text, or co-authors. No signatures.\n' +
      '- Output only the title and body, no code fences around the whole answer.\n\n' +
      `Branch: ${branch} -> ${baseBranch}\n\n` +
      `Commits:\n${log.trim().slice(0, 4000)}\n\n` +
      `Diff stat:\n${stat.trim().slice(0, 3000)}\n\n` +
      `Diff (truncated):\n${diff.slice(0, 12000)}`;
    let raw;
    try {
      raw = await bridge.quickText({ prompt, system: 'You write clear, concise GitHub pull request descriptions.' });
    } catch (e) {
      throw new Error(t('pr.draftFailed', { error: String(e?.message ?? e).split('\n')[0] }));
    }
    if (!raw) throw new Error(t('pr.emptyReply'));
    return parseDraft(raw, firstSubject.slice(0, 70));
  }

  async function push(cwd) {
    const root = await repoRoot(cwd);
    if (!root) throw new Error(t('pr.notRepo'));
    await currentBranch(root);
    try {
      await git(root, ['push', '-u', 'origin', 'HEAD'], PUSH_TIMEOUT);
    } catch (e) {
      fail(e, 'git push');
    }
    return true;
  }

  async function create(cwd, opts = {}) {
    const root = await repoRoot(cwd);
    if (!root) throw new Error(t('pr.notRepo'));
    const { base: baseBranch, title, body = '', draft: isDraft = false } = opts;
    if (!safeRef(baseBranch)) throw new Error(t('pr.badBaseBranch'));
    if (!String(title ?? '').trim()) throw new Error(t('pr.titleRequired'));
    const branch = await currentBranch(root);
    if (branch === baseBranch) throw new Error(t('pr.sameBranch'));
    const tmp = path.join(os.tmpdir(), `pr-body-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(tmp, String(body), 'utf8');
    try {
      const args = ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', String(title).trim(), '--body-file', tmp];
      if (isDraft) args.push('--draft');
      const out = await gh(root, args).catch((e) => fail(e));
      const url = out.match(/https?:\/\/\S+\/pull\/\d+/)?.[0] ?? out.trim().split('\n').pop();
      return { url };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  async function failedLogs(cwd) {
    const root = await repoRoot(cwd);
    if (!root) throw new Error(t('pr.notRepo'));
    const branch = await currentBranch(root);
    let runs;
    try {
      runs = JSON.parse(await gh(root, ['run', 'list', '--branch', branch, '--json', 'databaseId,conclusion,name,status,url,headSha', '--limit', '5']));
    } catch (e) {
      fail(e);
    }
    const failed = runs.find((r) => ['failure', 'timed_out', 'startup_failure'].includes(String(r.conclusion).toLowerCase()));
    if (!failed) throw new Error(t('pr.noFailedRuns'));
    let log;
    try {
      log = await gh(root, ['run', 'view', String(failed.databaseId), '--log-failed'], TIMEOUT);
    } catch (e) {
      fail(e);
    }
    log = stripLog(log).trim();
    const LIMIT = 8000;
    const truncated = log.length > LIMIT;
    // The tail usually holds the actual error.
    if (truncated) log = log.slice(-LIMIT).replace(/^[^\n]*\n/, '');
    return { runId: failed.databaseId, name: failed.name, url: failed.url ?? null, log: log || t('pr.emptyLog'), truncated };
  }

  return { status, branches, draft, push, create, failedLogs };
}

export function register(ctx) {
  const pr = createPr(ctx.bridge);
  ctx.handle('pr:status', (cwd) => pr.status(cwd));
  ctx.handle('pr:branches', (cwd) => pr.branches(cwd));
  ctx.handle('pr:draft', (cwd, base) => pr.draft(cwd, base));
  ctx.handle('pr:push', (cwd) => pr.push(cwd));
  ctx.handle('pr:create', (cwd, opts) => pr.create(cwd, opts));
  ctx.handle('pr:failedLogs', (cwd) => pr.failedLogs(cwd));
}
