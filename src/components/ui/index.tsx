import ConfirmDialog from './ConfirmDialog';
import ToastStack from './Toast';

export { confirmDialog, toast, dismissToast } from './store';
export type { ConfirmOptions, ToastOptions, ToastKind, ToastItem, UiLang } from './store';

/**
 * Mount once per React root (see main.tsx). Renders the confirm dialog and the
 * toast stack; both read from the module-level stores, so nothing needs to be
 * passed in and both React roots get their own host without sharing state that
 * only one of them would see.
 */
export function UiHost() {
  return (
    <>
      <ConfirmDialog />
      <ToastStack />
    </>
  );
}
