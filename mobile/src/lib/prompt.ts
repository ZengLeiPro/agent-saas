import { Alert, Platform } from 'react-native';

export interface PromptExtraAction {
  label: string;
  onPress: () => void;
}

export interface TextPromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'numeric' | 'email-address' | 'url';
  maxLength?: number;
  multiline?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  extraAction?: PromptExtraAction;
  onConfirm: (value: string) => void;
  onCancel?: () => void;
}

type PromptHandler = (opts: TextPromptOptions) => void;

let registeredHandler: PromptHandler | null = null;

export function registerPromptHandler(handler: PromptHandler | null) {
  registeredHandler = handler;
}

export function showTextPrompt(opts: TextPromptOptions): void {
  if (Platform.OS === 'ios') {
    const buttons: Parameters<typeof Alert.prompt>[2] = [
      {
        text: opts.cancelText ?? '取消',
        style: 'cancel',
        onPress: () => opts.onCancel?.(),
      },
    ];
    if (opts.extraAction) {
      buttons.push({
        text: opts.extraAction.label,
        onPress: () => opts.extraAction!.onPress(),
      });
    }
    buttons.push({
      text: opts.confirmText ?? '确定',
      onPress: (value?: string) => opts.onConfirm(value ?? ''),
    });
    Alert.prompt(
      opts.title,
      opts.message,
      buttons,
      opts.secureTextEntry ? 'secure-text' : 'plain-text',
      opts.defaultValue,
      opts.keyboardType,
    );
    return;
  }

  if (registeredHandler) {
    registeredHandler(opts);
    return;
  }

  console.warn('[showTextPrompt] no host registered on Android — falling back to alert');
  Alert.alert(opts.title, opts.message ?? '');
}
