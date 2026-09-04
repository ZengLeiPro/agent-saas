/**
 * 呈现块（display）渲染注册表 —— 与 `web/src/components/presentation/PresentationBlocks.tsx`
 * 一一对应的 RN 实现：callout / records / gate 三种 kind。
 *
 * 注册表是静态同步 map（与 Web 同理由）：会话流里一条消息挂 3 个块就是 3 个
 * 挂起边界，异步块会让列表滚动锚定跳动。未注册的 kind 静默跳过（安全降级）。
 */
import React, { useState } from 'react';
import { View, Text, Pressable, Linking, StyleSheet } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { ChevronRight } from 'lucide-react-native';
import type { BlockAction, CalloutBlock, GateBlock, PresentationBlock } from '@agent/shared';
import {
  useColors,
  spacing,
  radius,
  fontScale,
  fontWeight,
  monoFamily,
  useChatTypography,
} from '../../../theme';
import { Button } from '../../ui';
import { useBlockActionContext } from './BlockActionContext';
import { DetailLines } from './DetailLines';
import { RecordsBlockView } from './RecordsBlockView';
import { resolvePresentationToneTokens } from './tone';

/** 渲染上下文。回写通道缺省时按钮 disabled——不允许出现「点了没反应」的按钮。 */
export interface BlockContext {
  readOnly?: boolean;
  onAction?: (action: { interactionId: string; label: string }) => void;
}

function ActionButton({ action, ctx }: { action: BlockAction; ctx: BlockContext }) {
  const [copied, setCopied] = useState(false);

  if (action.kind === 'link') {
    if (!action.href) return null;
    const href = action.href;
    return (
      <Button
        variant="outline"
        size="sm"
        label={action.label}
        onPress={() => {
          void Linking.openURL(href);
        }}
      />
    );
  }

  if (action.kind === 'copy') {
    const text = action.copyText;
    if (!text) return null;
    return (
      <Button
        variant="outline"
        size="sm"
        label={copied ? '已复制' : action.label}
        onPress={() => {
          void Clipboard.setStringAsync(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      />
    );
  }

  // 无回写通道 = 无法真正生效，渲染为 disabled 而不是假装可点
  const usable = !!action.interactionId && !!ctx.onAction && !ctx.readOnly;
  const interactionId = action.interactionId;
  return (
    <Button
      variant={
        action.kind === 'primary' ? 'primary' : action.kind === 'ghost' ? 'ghost' : 'outline'
      }
      size="sm"
      label={action.label}
      disabled={!usable}
      onPress={
        usable && interactionId
          ? () => ctx.onAction?.({ interactionId, label: action.label })
          : undefined
      }
    />
  );
}

function BlockActions({ actions, ctx }: { actions?: BlockAction[]; ctx: BlockContext }) {
  if (!actions?.length) return null;
  return (
    <View style={styles.actions}>
      {actions.map((action, index) => (
        <ActionButton key={index} action={action} ctx={ctx} />
      ))}
    </View>
  );
}

function CalloutView({ block, ctx }: { block: CalloutBlock; ctx: BlockContext }) {
  const colors = useColors();
  const typo = useChatTypography();
  const [open, setOpen] = useState(block.defaultOpen !== false);
  const tone = resolvePresentationToneTokens(block.tone, colors);
  const semantic = block.tone === 'danger' || block.tone === 'warn' || block.tone === 'success';
  const collapsed = block.collapsible && !open;

  return (
    <View
      style={[
        styles.callout,
        {
          borderColor: semantic ? tone.tint : colors.border,
          backgroundColor: semantic ? tone.subtle : colors.muted,
        },
      ]}
    >
      {block.title ? (
        <Pressable
          onPress={block.collapsible ? () => setOpen((value) => !value) : undefined}
          disabled={!block.collapsible}
          accessibilityRole={block.collapsible ? 'button' : undefined}
          accessibilityState={block.collapsible ? { expanded: open } : undefined}
          accessibilityLabel={block.title}
          style={[styles.calloutHeader, block.collapsible ? styles.tappable : null]}
        >
          <Text
            style={[
              typo.bodySmall,
              styles.flexText,
              { color: semantic ? tone.ink : colors.foreground, fontWeight: fontWeight.medium },
            ]}
          >
            {block.title}
          </Text>
          {block.collapsible ? (
            <ChevronRight
              size={14}
              color={colors.mutedForeground}
              style={open ? styles.rotated : undefined}
            />
          ) : null}
        </Pressable>
      ) : null}
      {collapsed ? null : (
        <>
          {block.body.map((line, index) => (
            <Text key={index} style={[typo.bodySmall, { color: colors.foreground }]}>
              {line}
            </Text>
          ))}
          <DetailLines lines={block.detail} />
          <BlockActions actions={block.actions} ctx={ctx} />
        </>
      )}
    </View>
  );
}

function GateView({ block, ctx }: { block: GateBlock; ctx: BlockContext }) {
  const colors = useColors();
  const typo = useChatTypography();
  const tone = resolvePresentationToneTokens('warn', colors);
  return (
    <View style={[styles.callout, { borderColor: tone.tint, backgroundColor: tone.subtle }]}>
      <Text style={[typo.bodySmall, { color: tone.ink, fontWeight: fontWeight.medium }]}>
        {block.title}
      </Text>
      {block.body?.map((line, index) => (
        <Text key={index} style={[typo.bodySmall, { color: colors.foreground }]}>
          {line}
        </Text>
      ))}
      {block.meta?.length ? (
        <View style={styles.meta}>
          {block.meta.map((entry, index) => (
            <View key={index} style={styles.metaRow}>
              <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{entry.k}</Text>
              <Text style={[styles.metaText, styles.flexText, { color: colors.foreground }]}>
                {entry.v}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <BlockActions actions={block.actions} ctx={ctx} />
    </View>
  );
}

/**
 * 声明式分发。`default` 分支的 never 断言保证联合里新增 kind 时这里编译报错，
 * 不会静默漏渲染；运行时仍安全降级为不渲染，不抛错。
 */
function BlockView({ block, ctx }: { block: PresentationBlock; ctx: BlockContext }) {
  switch (block.kind) {
    case 'callout':
      return <CalloutView block={block} ctx={ctx} />;
    case 'records':
      return <RecordsBlockView block={block} />;
    case 'gate':
      return <GateView block={block} ctx={ctx} />;
    default: {
      const exhaustive: never = block;
      void exhaustive;
      return null;
    }
  }
}

export function PresentationBlocks({
  blocks,
  ctx,
}: {
  blocks: readonly PresentationBlock[];
  ctx?: BlockContext;
}) {
  // 显式 ctx 优先；缺省时取会话页挂的回写通道（无 Provider 则为只读）。
  const inherited = useBlockActionContext();
  const context = ctx ?? inherited;
  if (!blocks.length) return null;
  return (
    <View style={styles.stack}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} ctx={context} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  callout: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  calloutHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  tappable: { minHeight: 44 },
  flexText: { flex: 1, minWidth: 0 },
  rotated: { transform: [{ rotate: '90deg' }] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  meta: { gap: 2, marginTop: spacing.xs },
  metaRow: { flexDirection: 'row', gap: spacing.md },
  metaText: { ...fontScale.xs, fontFamily: monoFamily },
});
