import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useStore } from '../store';
import { t } from '../i18n';
import { isDetachedWindow } from '../features/detach/mode';

export class UIBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    window.desk.call('desk:ui-error', { message: error.message, stack: error.stack + '\n' + info.componentStack }).catch(() => {});
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="ui-failure" role="alert">
      <h2>{t('app.uiFailed')}</h2>
      <p>{t('app.uiWorkContinues')}</p>
      <button className="btn primary" data-ui-recover onClick={() => {
        if (isDetachedWindow()) useStore.setState({ panelTab: 'chat' });
        else useStore.getState().newThread();
        this.setState({ error: null });
      }}>{t(isDetachedWindow() ? 'app.uiRetry' : 'app.uiRecover')}</button>
      <details><summary>{t('app.uiDetails')}</summary><pre>{String(this.state.error.message).slice(0, 2000)}</pre></details>
    </main>;
  }
}
