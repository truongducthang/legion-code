// Dialog — wraps Electron dialog IPC calls.

import { IPC } from '../../electron/ipc/channels';

interface ConfirmOptions {
  title?: string;
  kind?: string;
  okLabel?: string;
  cancelLabel?: string;
}

export async function confirm(message: string, options?: ConfirmOptions): Promise<boolean> {
  return window.electron.ipcRenderer.invoke(IPC.DialogConfirm, {
    message,
    ...options,
  }) as Promise<boolean>;
}

interface ChoiceOptions {
  title?: string;
  kind?: string;
  buttons: string[];
  /** Button index selected by Enter. */
  defaultId?: number;
  /** Button index returned for Escape / window-close. */
  cancelId?: number;
}

/** Multi-button dialog. Resolves to the index of the chosen button. */
export async function choice(message: string, options: ChoiceOptions): Promise<number> {
  return window.electron.ipcRenderer.invoke(IPC.DialogChoice, {
    message,
    ...options,
  }) as Promise<number>;
}

interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
}

export async function openDialog(options?: OpenDialogOptions): Promise<string | string[] | null> {
  return window.electron.ipcRenderer.invoke(IPC.DialogOpen, options) as Promise<
    string | string[] | null
  >;
}
