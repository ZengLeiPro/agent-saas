import type { ComponentType } from 'react';
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

/** 动作菜单条目（ActionSheet / showActionMenu 共用） */
export interface ActionMenuItem {
  label: string;
  /** lucide 图标组件，建议取自 `src/lib/icons.ts` */
  icon?: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  /** 危险动作：红字 */
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export interface ActionMenuOptions {
  title?: string;
  message?: string;
  actions: ActionMenuItem[];
  cancelText?: string;
  onCancel?: () => void;
}

type PromptHandler = (opts: TextPromptOptions) => void;
type ActionMenuHandler = (opts: ActionMenuOptions) => void;

let registeredHandler: PromptHandler | null = null;
let registeredActionMenuHandler: ActionMenuHandler | null = null;

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

export function registerActionMenuHandler(handler: ActionMenuHandler | null) {
  registeredActionMenuHandler = handler;
}

/**
 * 命令式动作菜单。复用 PromptHost 的宿主机制（`app/_layout.tsx` 挂载一次），
 * 由 `components/ui/ActionSheet.tsx` 的 ActionSheetHost 渲染为底部动作面板。
 */
export function showActionMenu(opts: ActionMenuOptions): void {
  if (registeredActionMenuHandler) {
    registeredActionMenuHandler(opts);
    return;
  }
  console.warn('[showActionMenu] no host registered — falling back to alert');
  Alert.alert(opts.title ?? '', opts.message ?? '');
}
