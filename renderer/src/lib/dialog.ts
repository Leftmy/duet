// In-app confirmation dialogs (replaces window.confirm): `await askConfirm({...})` resolves true/false.
import { create } from 'zustand';

export interface ConfirmOptions {
  title: string;
  message?: string;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface DialogState {
  current: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
}

export const useDialog = create<DialogState>()(() => ({ current: null }));

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialog.getState().current?.resolve(false);
    useDialog.setState({ current: { ...opts, resolve } });
  });
}

export function closeDialog(ok: boolean) {
  const cur = useDialog.getState().current;
  useDialog.setState({ current: null });
  cur?.resolve(ok);
}
