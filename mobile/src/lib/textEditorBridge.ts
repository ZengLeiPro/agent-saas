/**
 * Lightweight bridge for passing text data between a form and
 * the full-screen text-editor page (replaces the broken TextEditorModal).
 *
 * Usage:
 *   // Caller (e.g. CronJobForm)
 *   textEditorBridge.open(currentText, 'Title', (saved) => setText(saved));
 *   router.push('/text-editor');
 *
 *   // Editor page reads initial state, then calls save/cancel.
 */

type Callback = (text: string) => void;

let _callback: Callback | null = null;
let _initialValue = '';
let _title = '';
let _placeholder = '';

export const textEditorBridge = {
  open(value: string, title: string, placeholder: string, onSave: Callback) {
    _initialValue = value;
    _title = title;
    _placeholder = placeholder;
    _callback = onSave;
  },
  getInitial() {
    return { value: _initialValue, title: _title, placeholder: _placeholder };
  },
  save(text: string) {
    _callback?.(text);
    _callback = null;
  },
  cancel() {
    _callback = null;
  },
};
