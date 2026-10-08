import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  Bot,
  ChevronDown,
  GitFork,
  Laptop,
  Trash2,
  ChevronRight,
  ClipboardList,
  FilePen,
  Boxes,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { Effort, PermMode, ProviderId, Thread } from '../types';
import { modelsOf, projectName, useStore } from '../store';
import { ALL_EFFORTS, EFFORT_LABEL, PERM_MODES, modelLabel } from '../lib/format';
import { MenuItem, Popover, spring } from './Popover';
import { t } from '../i18n';

const PERM_ICONS: Record<PermMode, typeof ShieldCheck> = {
  default: ShieldCheck,
  acceptEdits: FilePen,
  auto: Sparkles,
  plan: ClipboardList,
  bypassPermissions: ShieldAlert,
};

/** Which agent the chat talks to; switching mid-chat carries the conversation over. */
export function ProviderPicker({ thread }: { thread: Thread }) {
  const [open, setOpen] = useState(false);
  const providers = useStore((s) => s.providers);
  const switchProvider = useStore((s) => s.switchProvider);
  const close = useCallback(() => setOpen(false), []);
  const list = Object.entries(providers) as [ProviderId, (typeof providers)[string]][];
  if (list.length < 2) return null;
  const started = thread.entries.length > 0;
  const label = providers[thread.provider]?.label ?? thread.provider;
  return (
    <Popover
      open={open}
      onClose={close}
      width={300}
      trigger={() => (
        <button className="pill" title={t('pickers.agentTitle')} onClick={() => setOpen((v) => !v)}>
          <Bot size={14} />
          <span>{label}</span>
        </button>
      )}
    >
      <div className="menu-title">
        <span>{started ? t('pickers.switchAgent') : t('pickers.agentTitle')}</span>
      </div>
      {list.map(([id, p]) => (
        <MenuItem
          key={id}
          icon={id === thread.provider ? <Bot size={15} /> : <ArrowLeftRight size={15} />}
          label={p.label}
          hint={
            !p.available
              ? t('pickers.agentUnavailable', { error: p.error ?? '' })
              : id === thread.provider
                ? p.account?.email ?? p.version
                : started
                  ? t('pickers.switchHint')
                  : p.account?.email ?? p.version
          }
          checked={id === thread.provider}
          onClick={() => {
            setOpen(false);
            if (id !== thread.provider && p.available) switchProvider(thread.id, id);
          }}
        />
      ))}
    </Popover>
  );
}

export function PermissionPicker({ thread }: { thread: Thread }) {
  const [open, setOpen] = useState(false);
  const setMode = useStore((s) => s.setPermissionMode);
  const models = useStore((s) => modelsOf(s, thread.provider));
  const caps = useStore((s) => s.providers[thread.provider]?.caps);
  const agent = useStore((s) => s.providers[thread.provider]?.label ?? 'Claude');
  const close = useCallback(() => setOpen(false), []);
  const current = PERM_MODES.find((m) => m.mode === thread.permissionMode) ?? PERM_MODES[0];
  const Icon = PERM_ICONS[current.mode];
  const autoSupported = models.find((m) => m.value === thread.model)?.supportsAutoMode !== false;
  const allowed = (mode: PermMode) => (!caps?.modes || caps.modes.includes(mode)) && (mode !== 'auto' || autoSupported);
  return (
    <Popover
      open={open}
      onClose={close}
      width={400}
      trigger={() => (
        <button className={`pill ${current.tone ? 'tone-' + current.tone : ''}`} onClick={() => setOpen((v) => !v)}>
          <Icon size={14} />
          <span>{current.short}</span>
        </button>
      )}
    >
      <div className="menu-title">
        <span>{t('pickers.permTitle', { name: agent })}</span>
      </div>
      {PERM_MODES.filter((m) => allowed(m.mode)).map((m) => {
        const I = PERM_ICONS[m.mode];
        return (
          <MenuItem
            key={m.mode}
            icon={<I size={15} />}
            label={m.label}
            hint={m.hint}
            tone={m.tone}
            checked={m.mode === thread.permissionMode}
            onClick={() => {
              setMode(thread.id, m.mode);
              setOpen(false);
            }}
          />
        );
      })}
    </Popover>
  );
}

function EffortSlider({ levels, value, onChange }: { levels: Effort[]; value: Effort; onChange: (e: Effort) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, levels.indexOf(value));
  const pct = levels.length > 1 ? (idx / (levels.length - 1)) * 100 : 0;
  const pick = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return;
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const next = levels[Math.round(frac * (levels.length - 1))];
    if (next !== value) onChange(next);
  };
  return (
    <div
      className="slider"
      ref={trackRef}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        pick(e.clientX);
      }}
      onPointerMove={(e) => e.buttons === 1 && pick(e.clientX)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' && idx < levels.length - 1) onChange(levels[idx + 1]);
        if (e.key === 'ArrowLeft' && idx > 0) onChange(levels[idx - 1]);
      }}
      tabIndex={0}
    >
      <div className="slider-track" />
      <motion.div className="slider-fill" animate={{ width: `${pct}%` }} transition={spring} />
      {levels.map((l, i) => (
        <span key={l} className="slider-stop" style={{ left: `${(i / (levels.length - 1)) * 100}%` }} />
      ))}
      <motion.div className="slider-knob" animate={{ left: `${pct}%` }} transition={spring} />
    </div>
  );
}

export function ModelPicker({ thread }: { thread: Thread }) {
  const models = useStore((s) => modelsOf(s, thread.provider));
  const setModel = useStore((s) => s.setModel);
  const setEffort = useStore((s) => s.setEffort);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'models'>('effort');
  const close = useCallback(() => setOpen(false), []);

  const model = models.find((m) => m.value === thread.model);
  const levels = model ? model.supportedEffortLevels ?? [] : ALL_EFFORTS;
  const effortOk = levels.length > 0;
  const effort: Effort = levels.includes(thread.effort) ? thread.effort : (levels.includes('high') ? 'high' : levels[levels.length - 1]) ?? 'high';
  const resolvedDefault =
    thread.model === 'default' && model?.resolvedModel
      ? models.find((m) => m.value !== 'default' && m.resolvedModel === model.resolvedModel)?.displayName
      : undefined;
  const label = resolvedDefault ?? (models.length ? modelLabel(thread.model, models) : thread.model === 'default' ? t('common.default') : thread.model);
  const primary = models.filter((m) => !m.value.startsWith('claude-'));
  const legacy = models.filter((m) => m.value.startsWith('claude-'));
  const [showLegacy, setShowLegacy] = useState(false);

  const toggle = () => {
    setView(effortOk ? 'effort' : 'models');
    setOpen((v) => !v);
  };

  return (
    <Popover
      open={open}
      onClose={close}
      align="right"
      width={300}
      trigger={() => (
        <button className="pill" onClick={toggle}>
          <span className="pill-strong">{label}</span>
          {effortOk && <span className="muted">{EFFORT_LABEL[effort]}</span>}
          <ChevronDown size={13} className="muted" />
        </button>
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {view === 'effort' ? (
          <motion.div
            key="effort"
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={spring}
          >
            <div className="effort-head">
              <Gauge size={15} className="muted" />
              <div className="effort-center">
                <div className="effort-value">{EFFORT_LABEL[effort]}</div>
                <button className="effort-model" onClick={() => setView('models')}>
                  {label} <ChevronRight size={12} />
                </button>
              </div>
              <button className="icon-btn sm" title={t('pickers.reset')} onClick={() => setEffort(thread.id, levels.includes('high') ? 'high' : levels[0])}>
                <RotateCcw size={13} />
              </button>
            </div>
            <EffortSlider levels={levels} value={effort} onChange={(e) => setEffort(thread.id, e)} />
            <div className="slider-labels">
              <span>{EFFORT_LABEL[levels[0]]}</span>
              <span>{EFFORT_LABEL[levels[levels.length - 1]]}</span>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="models"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={spring}
          >
            <div className="menu-title">
              {effortOk && (
                <button className="icon-btn sm" onClick={() => setView('effort')}>
                  <ArrowLeft size={13} />
                </button>
              )}
              <span>{t('pickers.chooseModel')}</span>
            </div>
            <div className="menu-scroll">
              {(primary.length ? primary : [{ value: 'default', displayName: t('common.default'), description: '' }]).map((m) => (
                <MenuItem
                  key={m.value}
                  label={m.value === 'default' ? t('common.default') : m.displayName}
                  hint={m.description}
                  checked={m.value === thread.model}
                  onClick={() => {
                    setModel(thread.id, m.value);
                    const next = models.find((x) => x.value === m.value);
                    if (next?.supportedEffortLevels?.length) setView('effort');
                    else setOpen(false);
                  }}
                />
              ))}
              {legacy.length > 0 && (
                <button className="menu-more" onClick={() => setShowLegacy((v) => !v)}>
                  {showLegacy ? t('pickers.hideLegacy') : t('pickers.showLegacy', { n: legacy.length })}
                </button>
              )}
              <AnimatePresence initial={false}>
                {showLegacy && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                    {legacy.map((m) => (
                      <MenuItem
                        key={m.value}
                        label={m.displayName}
                        checked={m.value === thread.model}
                        onClick={() => {
                          setModel(thread.id, m.value);
                          setView('effort');
                        }}
                      />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Popover>
  );
}

/** "Local / Worktree" switch for a chat that hasn't started yet (shown for git projects only). */
export function WorkModePicker({ thread }: { thread: Thread }) {
  const setWorkMode = useStore((s) => s.setWorkMode);
  const [open, setOpen] = useState(false);
  const [isRepo, setIsRepo] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    let alive = true;
    setIsRepo(false);
    if (thread.cwd) window.desk.wtIsRepo(thread.cwd).then((r) => alive && setIsRepo(r));
    return () => {
      alive = false;
    };
  }, [thread.cwd]);
  if (!isRepo) return null;
  const wt = thread.workMode === 'worktree';
  return (
    <Popover
      open={open}
      onClose={close}
      side="bottom"
      width={320}
      trigger={() => (
        <button className="pill pill-big" onClick={() => setOpen((v) => !v)}>
          {wt ? <GitFork size={15} /> : <Laptop size={15} />}
          <span className="pill-strong">{wt ? t('pickers.worktree') : t('pickers.local')}</span>
          <ChevronDown size={13} className="muted" />
        </button>
      )}
    >
      <div className="menu-title">{t('pickers.workModeTitle')}</div>
      <MenuItem
        icon={<Laptop size={15} />}
        label={t('pickers.local')}
        hint={t('pickers.localHint')}
        checked={!wt}
        onClick={() => {
          setWorkMode(thread.id, 'local');
          setOpen(false);
        }}
      />
      <MenuItem
        icon={<GitFork size={15} />}
        label={t('pickers.worktree')}
        hint={t('pickers.worktreeHint')}
        checked={wt}
        onClick={() => {
          setWorkMode(thread.id, 'worktree');
          setOpen(false);
        }}
      />
    </Popover>
  );
}

/** Header chip for a chat running in its own worktree. */
export function WorktreeChip({ thread }: { thread: Thread }) {
  const apply = useStore((s) => s.worktreeApply);
  const remove = useStore((s) => s.worktreeRemove);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const wt = thread.worktree;
  if (!wt) return null;
  const removed = Boolean(wt.removed);
  return (
    <Popover
      open={open}
      onClose={close}
      side="bottom"
      align="right"
      width={300}
      trigger={() => (
        <button className={`pill sm wt-chip ${removed ? 'is-removed' : ''}`} onClick={() => setOpen((v) => !v)} title={wt.path || t('pickers.worktreeRemovedTitle')}>
          <GitFork size={12} />
          <span>{removed ? t('pickers.worktreeRemoved') : wt.branch}</span>
        </button>
      )}
    >
      <div className="menu-title">
        {t('pickers.worktreeFrom', { branch: wt.baseBranch ?? 'HEAD' })} · {projectName(wt.base)}
      </div>
      {!removed && (
        <>
          <MenuItem
            icon={<ArrowDownToLine size={15} />}
            label={t('pickers.applyToProject')}
            hint={t('pickers.applyToProjectHint')}
            onClick={() => {
              setOpen(false);
              apply(thread.id);
            }}
          />
          <MenuItem
            icon={<FolderOpen size={15} />}
            label={t('pickers.openWorktreeFolder')}
            onClick={() => {
              setOpen(false);
              window.desk.openPath(wt.path);
            }}
          />
          <MenuItem
            icon={<Trash2 size={15} />}
            label={t('pickers.deleteWorktree')}
            tone="warn"
            onClick={() => {
              setOpen(false);
              remove(thread.id);
            }}
          />
        </>
      )}
    </Popover>
  );
}

export function ProjectPicker({ thread, big }: { thread: Thread; big?: boolean }) {
  const [open, setOpen] = useState(false);
  const recent = useStore((s) => s.settings.recentProjects);
  const sessions = useStore((s) => s.sessions);
  const setCwd = useStore((s) => s.setCwd);
  const userProjects = useStore((s) => s.settings.projects);
  const project = userProjects.find((p) => p.id === thread.projectId);
  const close = useCallback(() => setOpen(false), []);
  const pickDir = (dir: string) => {
    useStore.getState().setThreadProject(thread.id, null);
    setCwd(thread.id, dir);
  };
  const projects = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...recent, ...sessions.map((s) => s.cwd)]) {
      if (!p || seen.has(p.toLowerCase())) continue;
      seen.add(p.toLowerCase());
      out.push(p);
    }
    return out.slice(0, 14);
  }, [recent, sessions]);

  const pick = async () => {
    setOpen(false);
    const dir = await window.desk.pickFolder();
    if (dir) pickDir(dir);
  };

  return (
    <Popover
      open={open}
      onClose={close}
      side="bottom"
      align={big ? 'left' : 'left'}
      width={340}
      trigger={() => (
        <button className={`pill ${big ? 'pill-big' : ''}`} onClick={() => setOpen((v) => !v)}>
          <Folder size={big ? 16 : 14} />
          <span className="pill-strong">{project ? project.name : thread.cwd ? projectName(thread.cwd) : t('pickers.chooseProject')}</span>
          <ChevronDown size={13} className="muted" />
        </button>
      )}
    >
      {userProjects.length > 0 && (
        <>
          <div className="menu-title">
            <span>{t('pickers.projects')}</span>
          </div>
          {userProjects.map((p) => (
            <MenuItem
              key={p.id}
              icon={<Boxes size={15} />}
              label={p.name}
              hint={p.folders.length > 1 ? t('pickers.folderCount', { count: p.folders.length }) : p.folders[0]}
              checked={p.id === thread.projectId}
              onClick={() => {
                useStore.getState().setThreadProject(thread.id, p.id);
                setOpen(false);
              }}
            />
          ))}
          <div className="menu-sep" />
        </>
      )}
      <div className="menu-title">
        <span>{t('pickers.folders')}</span>
      </div>
      <div className="menu-scroll">
        {projects.map((p) => (
          <MenuItem
            key={p}
            icon={<FolderOpen size={15} />}
            label={projectName(p)}
            hint={p}
            checked={!project && p.toLowerCase() === thread.cwd.toLowerCase()}
            onClick={() => {
              pickDir(p);
              setOpen(false);
            }}
          />
        ))}
      </div>
      <div className="menu-sep" />
      <MenuItem icon={<FolderPlus size={15} />} label={t('pickers.chooseFolder')} onClick={pick} />
      <MenuItem
        icon={<Boxes size={15} />}
        label={t('pickers.createProject')}
        hint={t('pickers.createProjectHint')}
        onClick={() => {
          setOpen(false);
          useStore.setState({ projectModal: {} });
        }}
      />
    </Popover>
  );
}
