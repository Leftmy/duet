import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, Folder, FolderOpen, FolderPlus, Star, X } from 'lucide-react';
import { useStore } from '../store';
import { ALL_EFFORTS, EFFORT_LABEL, PERM_MODES, basename } from '../lib/format';
import type { Effort, PermMode, Project } from '../types';
import { spring, useOverlay } from './Popover';
import { t } from '../i18n';

const backdrop = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
const card = {
  initial: { opacity: 0, scale: 0.96, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98, y: 6 },
  transition: spring,
};

/** Create or edit a project: a name plus the folders its chats may use. */
export function ProjectModal() {
  const modal = useStore((s) => s.projectModal);
  const projects = useStore((s) => s.settings.projects);
  const editing = modal?.id ? projects.find((p) => p.id === modal.id) : undefined;
  const [name, setName] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [defaults, setDefaults] = useState<NonNullable<Project['defaults']>>({});
  const [showDefaults, setShowDefaults] = useState(false);
  const models = useStore((s) => s.models);
  const nameRef = useRef<HTMLInputElement>(null);
  useOverlay(Boolean(modal));

  useEffect(() => {
    if (!modal) return;
    setName(editing?.name ?? '');
    setFolders(editing?.folders ?? []);
    setDefaults(editing?.defaults ?? {});
    setShowDefaults(Boolean(editing?.defaults && Object.values(editing.defaults).some((v) => v != null)));
    setTimeout(() => nameRef.current?.focus(), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  const close = () => useStore.setState({ projectModal: null });

  const add = async () => {
    const dir = await window.desk.pickFolder();
    if (!dir) return;
    setFolders((f) => (f.some((x) => x.toLowerCase() === dir.toLowerCase()) ? f : [...f, dir]));
    if (!name.trim()) setName(basename(dir));
  };

  const submit = () => {
    if (!name.trim() && !folders.length) return;
    const s = useStore.getState();
    const clean = Object.fromEntries(Object.entries(defaults).filter(([, v]) => v != null && v !== '')) as Project['defaults'];
    const id = s.saveProject({ id: editing?.id, name, folders, defaults: clean });
    close();
    if (!editing) {
      s.newThreadInProject(id);
      s.toast(t('project.created', { name: name.trim() || basename(folders[0] ?? '') }));
    }
  };

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modal]);

  return (
    <AnimatePresence>
      {modal && (
        <motion.div className="modal-backdrop" {...backdrop} onMouseDown={close}>
          <motion.div className="modal project-modal" {...card} onMouseDown={(e) => e.stopPropagation()}>
            <div className="pm-head">
              <h3>{editing ? t('project.settingsTitle') : t('project.createTitle')}</h3>
              <button className="icon-btn sm" onClick={close} title={t('common.close')}>
                <X size={15} />
              </button>
            </div>

            <label className="pm-name">
              <span className="pm-name-icon">
                <Folder size={16} />
              </span>
              <input
                ref={nameRef}
                placeholder={t('project.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </label>

            <div className="pm-label">{t('project.sourceFolders')}</div>
            <div className={`pm-folders ${folders.length ? '' : 'is-empty'}`}>
              <AnimatePresence initial={false}>
                {folders.map((f, i) => (
                  <motion.div
                    key={f}
                    className="pm-folder"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.18 }}
                  >
                    <FolderOpen size={15} className="muted" />
                    <div className="pm-folder-text">
                      <span className="truncate">{basename(f) || f}</span>
                      <span className="muted small truncate">{f}</span>
                    </div>
                    {i === 0 ? (
                      <span className="chip" title={t('project.primaryHint')}>
                        {t('project.primary')}
                      </span>
                    ) : (
                      <button
                        className="icon-btn sm hover-only"
                        title={t('project.makePrimary')}
                        onClick={() => setFolders((x) => [f, ...x.filter((y) => y !== f)])}
                      >
                        <Star size={13} />
                      </button>
                    )}
                    <button className="icon-btn sm" title={t('project.removeFolder')} onClick={() => setFolders((x) => x.filter((y) => y !== f))}>
                      <X size={13} />
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
              <div className="pm-add">
                {!folders.length && <span className="muted">{t('project.addFolderHint')}</span>}
                <button className="pm-add-btn" onClick={add}>
                  <FolderPlus size={14} />
                  {folders.length ? t('project.addAnotherFolder') : t('common.add')}
                </button>
              </div>
            </div>
            {folders.length > 1 && (
              <div className="muted small pm-hint">{t('project.multiFolderHint')}</div>
            )}

            <button className={`pm-defaults-toggle ${showDefaults ? 'is-open' : ''}`} onClick={() => setShowDefaults((v) => !v)}>
              <ChevronRight size={13} />
              {t('project.newChatDefaults')}
              {!showDefaults && Object.values(defaults).some((v) => v != null) && <span className="muted small">· {t('project.defaultsSet')}</span>}
            </button>
            <AnimatePresence initial={false}>
              {showDefaults && (
                <motion.div
                  className="pm-defaults"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  <label>
                    <span className="muted small">{t('project.model')}</span>
                    <select
                      className="select"
                      value={defaults.model ?? ''}
                      onChange={(e) => setDefaults((d) => ({ ...d, model: e.target.value || undefined }))}
                    >
                      <option value="">{t('project.asInSettings')}</option>
                      {models.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.value === 'default' ? t('common.default') : m.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="muted small">{t('project.effort')}</span>
                    <select
                      className="select"
                      value={defaults.effort ?? ''}
                      onChange={(e) => setDefaults((d) => ({ ...d, effort: (e.target.value || undefined) as Effort | undefined }))}
                    >
                      <option value="">{t('project.asInSettings')}</option>
                      {ALL_EFFORTS.map((x) => (
                        <option key={x} value={x}>
                          {EFFORT_LABEL[x]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="muted small">{t('project.permissions')}</span>
                    <select
                      className="select"
                      value={defaults.permissionMode ?? ''}
                      onChange={(e) => setDefaults((d) => ({ ...d, permissionMode: (e.target.value || undefined) as PermMode | undefined }))}
                    >
                      <option value="">{t('project.asInSettings')}</option>
                      {PERM_MODES.map((m) => (
                        <option key={m.mode} value={m.mode}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="muted small">{t('project.workMode')}</span>
                    <select
                      className="select"
                      value={defaults.workMode ?? ''}
                      onChange={(e) => setDefaults((d) => ({ ...d, workMode: (e.target.value || undefined) as 'local' | 'worktree' | undefined }))}
                    >
                      <option value="">{t('project.asInSettings')}</option>
                      <option value="local">{t('project.local')}</option>
                      <option value="worktree">{t('project.worktree')}</option>
                    </select>
                  </label>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="pm-actions">
              <button className="btn ghost" onClick={close}>
                {t('common.cancel')}
              </button>
              <button className="btn primary" disabled={!name.trim() && !folders.length} onClick={submit}>
                {editing ? t('common.save') : t('project.createTitle')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
