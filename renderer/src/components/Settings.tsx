import { providerEntries } from '../lib/providers';
import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BarChart3, CalendarClock, Info, ScrollText, SquareSlash, Wand2, Keyboard, Monitor, Moon, Plug, SlidersHorizontal, Sparkles, Sun, User, X, Send } from 'lucide-react';
import { InstructionsSection } from '../features/instructions/InstructionsSection';
import { CommandsSection } from '../features/commands/CommandsSection';
import { SchedulesSection, TelegramSection } from '../features/schedule/SchedulesSection';
import { useStore } from '../store';
import { ALL_EFFORTS, EFFORT_LABEL, PERM_MODES, modelLabel, resetTime } from '../lib/format';
import type { Effort, LimitWindow, PermMode, ThemePref, ProviderId } from '../types';
import type { ProviderProbe } from '../desk';
import { AgentMark } from './AgentMark';
import { spring } from './Popover';
import { LANGS, t, type Lang } from '../i18n';
import { AboutSection, McpManager, SkillsList, StatsView } from './SettingsExtra';

type Section = 'general' | 'defaults' | 'claude' | 'instr' | 'commands' | 'mcp' | 'skills' | 'schedule' | 'telegram' | 'stats' | 'keys' | 'about';

const fmtLimit = (w: LimitWindow) => {
  const rst = resetTime(w.resetsAt);
  return rst ? `${Math.round(w.pct)}% (${t('sidebar.resets', { time: rst })})` : `${Math.round(w.pct)}%`;
};

const SECTIONS: { id: Section; label: string; icon: typeof User }[] = [
  { id: 'general', get label() { return t('settings.nav_general'); }, icon: SlidersHorizontal },
  { id: 'defaults', get label() { return t('settings.nav_defaults'); }, icon: Sparkles },
  { id: 'claude', get label() { return t('settings.nav_claude'); }, icon: User },
  { id: 'instr', get label() { return t('settings.nav_instr'); }, icon: ScrollText },
  { id: 'commands', get label() { return t('settings.nav_commands'); }, icon: SquareSlash },
  { id: 'mcp', get label() { return t('settings.nav_mcp'); }, icon: Plug },
  { id: 'skills', get label() { return t('settings.nav_skills'); }, icon: Wand2 },
  { id: 'schedule', get label() { return t('settings.nav_schedule'); }, icon: CalendarClock },
  { id: 'telegram', get label() { return 'Telegram'; }, icon: Send },
  { id: 'stats', get label() { return t('settings.nav_stats'); }, icon: BarChart3 },
  { id: 'keys', get label() { return t('settings.nav_keys'); }, icon: Keyboard },
  { id: 'about', get label() { return t('settings.nav_about'); }, icon: Info },
];

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div>{title}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <motion.span className="toggle-knob" layout transition={spring} />
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.v} className={`seg ${value === o.v ? 'is-on' : ''}`} onClick={() => onChange(o.v)}>
          {value === o.v && <motion.span layoutId={`seg-${options.map((x) => x.v).join()}`} className="seg-bg" transition={spring} />}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function Select<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <select className="input select" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** [key, description key] — keys with a mouse action are translated too. */
const KEYS: [string, string][] = [
  ['Enter', 'send'],
  ['Shift + Enter', 'newline'],
  ['Esc', 'stop'],
  ['/', 'slash'],
  ['Ctrl + N', 'newChat'],
  ['Ctrl + .', 'switchAgent'],
  ['Ctrl + K', 'palette'],
  ['Ctrl + Shift + F', 'search'],
  ['Shift + click', 'multiSelect'],
  ['Ctrl + M', 'voice'],
  ['Ctrl + click', 'split'],
  ['Ctrl + B', 'sidebar'],
  ['Ctrl + ,', 'settings'],
  ['Ctrl + E', 'files'],
  ['Ctrl + `', 'terminal'],
  ['Ctrl + S', 'save'],
  ['Ctrl + Enter', 'commit'],
  ['Ctrl + Shift + I', 'devtools'],
];

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const requestedSection = useStore((s) => s.settingsSection);
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const account = useStore((s) => s.account);
  const usage = useStore((s) => s.usage);
  const providers = useStore((s) => s.providers);
  const usageBy = useStore((s) => s.usageBy);
  const mcp = useStore((s) => s.mcp);
  const setSettings = useStore((s) => s.setSettings);
  const [section, setSection] = useState<Section>('general');
  const close = () => useStore.setState({ settingsOpen: false, settingsSection: undefined });

  useEffect(() => {
    if (open && requestedSection) {
      setSection(requestedSection as Section);
      useStore.setState({ settingsSection: undefined });
    }
  }, [open, requestedSection]);

  useEffect(() => {
    if (open && section === 'claude') useStore.getState().refreshUsage();
  }, [open, section]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const model = models.find((m) => m.value === settings.model);
  const efforts = model ? model.supportedEffortLevels ?? [] : ALL_EFFORTS;

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={close}>
          <motion.div
            className="modal settings"
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 6 }}
            transition={spring}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <nav className="set-nav">
              <div className="set-nav-title">{t('settings.title')}</div>
              {SECTIONS.map((s) => (
                <button key={s.id} className={`side-item ${section === s.id ? 'is-active' : ''}`} onClick={() => setSection(s.id)}>
                  {section === s.id && <motion.span layoutId="set-nav-bg" className="active-bg" transition={spring} />}
                  <s.icon size={15} />
                  <span>{s.label}</span>
                </button>
              ))}
            </nav>
            <div className="set-body">
              <button className="icon-btn set-close" onClick={close} title={t('settings.closeEsc')}>
                <X size={16} />
              </button>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={section} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.16 }}>
                  {section === 'general' && (
                    <>
                      <h2>{t('settings.nav_general')}</h2>
                      <Row title={t('settings.language')}>
                        <Select<Lang> value={settings.language} onChange={(language) => setSettings({ language })} options={LANGS.map((l) => ({ v: l.value, label: l.label }))} />
                      </Row>
                      <Row title={t('settings.theme')} hint={t('settings.themeHint')}>
                        <Segmented<ThemePref>
                          value={settings.theme}
                          onChange={(theme) => setSettings({ theme })}
                          options={[
                            { v: 'system', label: <><Monitor size={13} /> {t('settings.themeSystem')}</> },
                            { v: 'dark', label: <><Moon size={13} /> {t('settings.themeDark')}</> },
                            { v: 'light', label: <><Sun size={13} /> {t('settings.themeLight')}</> },
                          ]}
                        />
                      </Row>
                      <Row title={t('settings.autoTitles')} hint={t('settings.autoTitlesHint')}>
                        <Toggle on={settings.autoTitles} onChange={(autoTitles) => setSettings({ autoTitles })} />
                      </Row>
                      <Row title={t('settings.notifications')} hint={t('settings.notificationsHint')}>
                        <Toggle on={settings.notifications} onChange={(notifications) => setSettings({ notifications })} />
                      </Row>
                      <Row title={t('settings.idleAgents')} hint={t('settings.idleAgentsHint')}>
                        <select className="input select" value={settings.idleAgentMinutes} onChange={(e) => setSettings({ idleAgentMinutes: Number(e.target.value) })}>
                          <option value={0}>{t('settings.idleNever')}</option>
                          {[1, 5, 15, 30].map((minutes) => <option key={minutes} value={minutes}>{t('settings.idleMinutes', { minutes })}</option>)}
                        </select>
                      </Row>
                      <Row
                        title={t('settings.followUp')}
                        hint={t('settings.followUpHint')}
                      >
                        <Segmented<'steer' | 'queue'>
                          value={settings.followUp}
                          onChange={(followUp) => setSettings({ followUp })}
                          options={[
                            { v: 'steer', label: t('settings.followUpSteer') },
                            { v: 'queue', label: t('settings.followUpQueue') },
                          ]}
                        />
                      </Row>
                      <Row title={t('settings.sidebar')} hint="Ctrl + B">
                        <Toggle on={settings.sidebarOpen} onChange={(sidebarOpen) => setSettings({ sidebarOpen })} />
                      </Row>
                    </>
                  )}
                  {section === 'defaults' && (
                    <>
                      <h2>{t('settings.nav_defaults')}</h2>
                      <p className="muted small">{t('settings.defaultsHint')}</p>
                      {Object.keys(providers).length > 1 && (
                        <Row title={t('settings.agent')} hint={t('settings.agentHint')}>
                          <Select<ProviderId>
                            value={settings.provider}
                            onChange={(provider) => setSettings({ provider })}
                            options={providerEntries(providers).filter(([, p]) => p.available).map(([v, p]) => ({ v, label: p.label }))}
                          />
                        </Row>
                      )}
                      <Row title={settings.provider === 'claude' || Object.keys(providers).length < 2 ? t('settings.model') : t('settings.claudeModel')}>
                        <Select
                          value={settings.model}
                          onChange={(model) => setSettings({ model })}
                          options={(models.length ? models : [{ value: 'default', displayName: t('common.default') } as any]).map((m) => ({
                            v: m.value,
                            label: m.value === 'default' ? t('common.default') : modelLabel(m.value, models),
                          }))}
                        />
                      </Row>
                      {efforts.length > 0 && (
                        <Row title={t('settings.effort')}>
                          <Select<Effort>
                            value={efforts.includes(settings.effort) ? settings.effort : efforts[0]}
                            onChange={(effort) => setSettings({ effort })}
                            options={efforts.map((e) => ({ v: e, label: EFFORT_LABEL[e] }))}
                          />
                        </Row>
                      )}
                      <Row title={t('settings.permissions')}>
                        <Select<PermMode>
                          value={settings.permissionMode}
                          onChange={(permissionMode) => setSettings({ permissionMode })}
                          options={PERM_MODES.map((m) => ({ v: m.mode, label: m.label }))}
                        />
                      </Row>
                      <Row title={t('settings.workMode')} hint={t('settings.workModeHint')}>
                        <Segmented<'local' | 'worktree'>
                          value={settings.workMode}
                          onChange={(workMode) => setSettings({ workMode })}
                          options={[
                            { v: 'local', label: t('settings.workLocal') },
                            { v: 'worktree', label: 'Worktree' },
                          ]}
                        />
                      </Row>
                    </>
                  )}
                  {section === 'claude' && (
                    <>
                      <h2 className="agent-h2">
                        <AgentMark provider="claude" size={18} /> Claude
                      </h2>
                      <Row title={t('settings.account')} hint={account.organization}>
                        <span className="muted">{account.email ?? '—'}</span>
                      </Row>
                      <Row title={t('settings.subscription')}>
                        <span className="muted">{account.subscriptionType ?? usage.plan ?? '—'}</span>
                      </Row>
                      {usage.session && (
                        <Row title={t('settings.sessionLimit')}>
                          <span className="muted">{fmtLimit(usage.session)}</span>
                        </Row>
                      )}
                      {usage.weekly && (
                        <Row title={t('settings.weeklyLimit')}>
                          <span className="muted">{fmtLimit(usage.weekly)}</span>
                        </Row>
                      )}
                      <h3>{t('settings.browser')}</h3>
                      <Row
                        title={t('settings.chrome')}
                        hint={t('settings.chromeHint')}
                      >
                        <Toggle on={settings.chrome} onChange={(chrome) => setSettings({ chrome })} />
                      </Row>
                      <Row title={t('settings.builtinBrowser')} hint={t('settings.builtinBrowserHint')}>
                        <span className="muted small">{t('settings.enabled')}</span>
                      </Row>
                      <p className="muted small">{t('settings.claudeFooter')}</p>
                      {providerEntries(providers)
                        .filter(([id]) => id !== 'claude')
                        .map(([id, p]) => (
                          <div key={id}>
                            <h2 className="agent-h2">
                              <AgentMark provider={id} size={18} /> {p.label}
                            </h2>
                            {p.available ? (
                              <>
                                <Row title={t('settings.account')}>
                                  <span className="muted">{p.account?.email ?? usageBy[id]?.email ?? '—'}</span>
                                </Row>
                                <Row title={t('settings.subscription')}>
                                  <span className="muted">{p.account?.subscriptionType ?? usageBy[id]?.plan ?? '—'}</span>
                                </Row>
                                {usageBy[id]?.groups?.length ? (
                                  usageBy[id]!.groups!.map((g) => (
                                    <Row key={g.name} title={g.name} hint={g.description}>
                                      <span className="muted">
                                        {[
                                          g.session ? `${t('sidebar.usageSessionShort')}: ${fmtLimit(g.session)}` : null,
                                          g.weekly ? `${t('sidebar.usageWeekShort')}: ${fmtLimit(g.weekly)}` : null,
                                        ]
                                          .filter(Boolean)
                                          .join(' · ')}
                                      </span>
                                    </Row>
                                  ))
                                ) : (
                                  <>
                                    {usageBy[id]?.session && (
                                      <Row title={t('settings.sessionLimit')}>
                                        <span className="muted">{fmtLimit(usageBy[id]!.session!)}</span>
                                      </Row>
                                    )}
                                    {usageBy[id]?.weekly && (
                                      <Row title={t('settings.weeklyLimit')}>
                                        <span className="muted">{fmtLimit(usageBy[id]!.weekly!)}</span>
                                      </Row>
                                    )}
                                  </>
                                )}
                                <Row title={t('settings.version')}>
                                  <span className="muted">{p.version ?? '—'}</span>
                                </Row>
                              </>
                            ) : (
                              <p className="muted small">{t('settings.agentMissing', { name: p.label, error: p.error ?? '' })}</p>
                            )}
                          </div>
                        ))}
                    </>
                  )}
                  {section === 'mcp' && <McpManager />}
                  {section === 'skills' && <SkillsList />}
                  {section === 'instr' && <InstructionsSection />}
                  {section === 'commands' && <CommandsSection />}
                  {section === 'schedule' && <SchedulesSection />}
                  {section === 'telegram' && <TelegramSection />}
                  {section === 'stats' && <StatsView />}
                  {section === 'about' && <AboutSection />}
                  {section === 'keys' && (
                    <>
                      <h2>{t('settings.nav_keys')}</h2>
                      <div className="keys">
                        {KEYS.map(([k, d]) => (
                          <div key={k} className="key-row">
                            <span>{t(`settings.key_${d}`)}</span>
                            <span className="spacer" />
                            <kbd className="key">{k.includes('click') ? k.replace('click', t('settings.keyClick')) : k}</kbd>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export const openSettings = (section?: Section) => useStore.setState({ settingsOpen: true, ...(section ? { settingsSection: section } : {}) });
