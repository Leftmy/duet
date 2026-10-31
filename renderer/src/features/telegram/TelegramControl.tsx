import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Bot, ChevronDown, Loader2, TriangleAlert } from 'lucide-react';
import { useStore } from '../../store';
import { spring } from '../../components/Popover';
import { t } from '../../i18n';
import './telegram.css';

// ---------- types (mirror src-tauri/src/core/telegram.rs) ----------

type TgMode = 'ask' | 'edits' | 'full';
type TgModel = 'default' | 'sonnet' | 'opus' | 'haiku';

export interface TgStatus {
  enabled: boolean;
  configured: boolean;
  /** The bot is polling Telegram for messages. */
  running: boolean;
  /** A Claude task started from Telegram is in progress. */
  busy: boolean;
  busySince: number | null;
  botName: string;
  lastError: string;
  current: { project: string | null; chat: string | null; mode: TgMode; model?: TgModel };
}

const modeLabel = (m: TgMode) => t(m === 'ask' ? 'telegram.modeAsk' : m === 'edits' ? 'telegram.modeEdits' : 'telegram.modeFull');
const modelLabel = (m: TgModel | undefined) => t(`telegram.model_${m ?? 'default'}`);

// The bot's main menu (a keyboard under the input field in Telegram), its in-message buttons and what they do.
const menuButtons = (): [string, string][] => [
  [t('telegram.btnProjects'), t('telegram.btnProjectsDesc')],
  [t('telegram.btnChats'), t('telegram.btnChatsDesc')],
  [t('telegram.btnNew'), t('telegram.btnNewDesc')],
  [t('telegram.btnSettings'), t('telegram.btnSettingsDesc')],
  [t('telegram.btnStatus'), t('telegram.btnStatusDesc')],
  [t('telegram.btnStop'), t('telegram.btnStopDesc')],
  [t('telegram.btnAllow'), t('telegram.btnAllowDesc')],
  [t('telegram.btnFiles'), t('telegram.btnFilesDesc')],
];

const errText = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function TelegramControl() {
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<TgStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      window.desk
        .call<TgStatus>('tg:status')
        .then((s) => alive && setSt(s))
        .catch(() => {});
    load();
    // tg:update carries only part of the state; bot settings live in the scheduler (sched:update).
    const offs = [window.desk.subscribe('tg:update', load), window.desk.subscribe('sched:update', load)];
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, []);

  if (!st) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      setSt(await window.desk.call<TgStatus>('tg:setEnabled', !st.enabled));
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  let line: ReactNode;
  if (!st.configured) line = <span className="muted">{t('telegram.notConfigured')}</span>;
  else if (!st.enabled) line = <span className="muted">{t('telegram.off')}</span>;
  else if (st.lastError) line = <span className="tg-err">{st.lastError}</span>;
  else if (!st.running || !st.botName)
    line = (
      <span className="muted">
        <Loader2 size={11} className="spin" /> {t('telegram.connecting')}
      </span>
    );
  else
    line = (
      <span>
        <span className="tg-dot" /> {t('telegram.online', { name: st.botName })}
        {st.busy ? t('telegram.busy') : ''}
      </span>
    );

  return (
    <div className="tg-ctl">
      <div className="tg-ctl-head">
        <Bot size={16} className="tg-ctl-icon" />
        <div className="tg-ctl-title">
          <div>{t('telegram.title')}</div>
          <div className="small tg-ctl-status">{line}</div>
        </div>
        <button
          className={`toggle ${st.enabled ? 'is-on' : ''}`}
          onClick={toggle}
          disabled={busy || (!st.configured && !st.enabled)}
          role="switch"
          aria-checked={st.enabled}
          title={st.enabled ? t('telegram.turnOff') : t('telegram.turnOn')}
        >
          <motion.span className="toggle-knob" layout transition={spring} />
        </button>
      </div>

      {st.enabled && st.configured && (
        <div className="muted small tg-ctl-current">
          {t('telegram.current', {
            project: st.current.project ?? t('telegram.projectNone'),
            chat: st.current.chat ? t('telegram.chatQuoted', { title: st.current.chat }) : t('telegram.chatNew'),
            mode: modeLabel(st.current.mode),
            model: modelLabel(st.current.model),
          })}
        </div>
      )}

      <div className="tg-ctl-warn small">
        <TriangleAlert size={13} />
        <span>{t('telegram.warning')}</span>
      </div>

      <button className="tg-ctl-more small" onClick={() => setHelp(!help)}>
        {t('telegram.howTo')} <ChevronDown size={12} className={`tg-chev ${help ? 'is-open' : ''}`} />
      </button>
      {help && (
        <div className="tg-ctl-help small">
          <p className="muted">{t('telegram.helpText')}</p>
          <div className="tg-cmds">
            {menuButtons().map(([label, desc]) => (
              <div key={label} className="tg-cmd">
                <span className="tg-btn-label">{label}</span>
                <span className="muted">{desc}</span>
              </div>
            ))}
          </div>
          <p className="muted">{t('telegram.helpCommands')}</p>
        </div>
      )}
    </div>
  );
}
