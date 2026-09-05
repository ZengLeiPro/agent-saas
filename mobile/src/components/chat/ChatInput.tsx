import React, { useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
  Text,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { Square, CircleStop, ArrowUp, Mic, Plus } from 'lucide-react-native';
import type { ModelList, SandboxProfile, UploadedFile } from '@agent/shared';
import { useColors, spacing, typography, radius, fontScale, fontWeight } from '../../theme';
import { FileAttachmentList } from './FileAttachmentList';
import { ModelPicker, type PickerExtraSection } from './ModelPicker';
import { SandboxProfileToggle } from './SandboxProfileToggle';
import { hapticLight, hapticMedium } from '../../lib/haptics';
import { DropdownMenu, type DropdownSection, type DrillDownPage } from '../overlays/DropdownMenu';
import { useSandboxWarmup } from '../../hooks/useSandboxWarmup';

interface ChatInputProps {
  input: string;
  setInput: (value: string) => void;
  loading: boolean;
  onSend: () => void;
  onStop: () => void;
  stopping?: boolean;
  // File upload
  uploadedFiles: UploadedFile[];
  uploading: boolean;
  uploadError?: string | null;
  onDismissUploadError?: () => void;
  onPickFile: () => Promise<void>;
  onPickImage: () => Promise<void>;
  onTakePhoto: () => Promise<void>;
  onRemoveFile: (index: number) => void;
  // Voice
  isRecording: boolean;
  recordingDuration: number;
  onStartRecording: () => Promise<void>;
  onStopRecording: () => Promise<void>;
  onCancelRecording: () => void;
  sessionId?: string | null;
  tooShortTip?: boolean;
  /** Structured target-unavailable message; disables every send/composer action. */
  disabledReason?: string | null;
  // 工具条：模型选择器（与 Web 一样挂在输入框工具条上）
  modelList?: ModelList | null;
  selectedModel?: string | null;
  onModelChange?: (ref: string) => void;
  modelExtraSections?: PickerExtraSection[];
  onModelExtraAction?: (actionId: string) => void;
  modelDrillDowns?: Record<string, DrillDownPage>;
  onModelDrillDownSelect?: (parentId: string, childId: string) => void;
  /** 已落地会话的服务端沙箱档位，仅用于工具条只读展示。 */
  sessionSandboxProfile?: SandboxProfile;
}

const INPUT_MIN_HEIGHT = 40;
const INPUT_MAX_HEIGHT = 120;
const CIRCLE_SIZE = 32;

export function ChatInput({
  input, setInput, loading, onSend, onStop, stopping,
  uploadedFiles, uploading, uploadError, onDismissUploadError, onPickFile, onPickImage, onTakePhoto, onRemoveFile,
  isRecording, recordingDuration, onStartRecording, onStopRecording, onCancelRecording,
  sessionId, tooShortTip, disabledReason,
  modelList, selectedModel, onModelChange,
  modelExtraSections, onModelExtraAction, modelDrillDowns, onModelDrillDownSelect,
  sessionSandboxProfile,
}: ChatInputProps) {
  const colors = useColors();

  const inputRef = useRef<TextInput>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  // 首次有效输入预热沙箱（与 Web `warmupSessionOnce` 同语义）。
  useSandboxWarmup(sessionId, input);

  const hasContent = input.trim().length > 0 || uploadedFiles.length > 0;
  const showStop = loading && (!hasContent || stopping);

  const handleSend = () => {
    if (disabledReason) return;
    if (loading && !hasContent) {
      if (!stopping) onStop();
      return;
    }
    if (!input.trim() && uploadedFiles.length === 0) return;
    hapticLight();
    onSend();
  };

  const [attachMenuVisible, setAttachMenuVisible] = useState(false);
  const [attachAnchorTop, setAttachAnchorTop] = useState(0);
  const attachBtnRef = useRef<View>(null);

  const attachSections = useMemo<DropdownSection[]>(() => [{
    id: 'attach',
    actions: [
      { id: 'camera', label: '拍照' },
      { id: 'photo', label: '相册' },
      { id: 'file', label: '选择文件' },
    ],
  }], []);

  const showAttachOptions = useCallback(() => {
    hapticLight();
    attachBtnRef.current?.measureInWindow((_x, y) => {
      // Anchor above the button (dropdown appears upward from input area)
      setAttachAnchorTop(y - 4);
      setAttachMenuVisible(true);
    });
  }, []);

  const handleAttachSelect = useCallback((actionId: string) => {
    const action =
      actionId === 'camera' ? onTakePhoto
        : actionId === 'photo' ? onPickImage
          : actionId === 'file' ? onPickFile
            : null;
    setAttachMenuVisible(false);
    if (!action) return;
    // 等 DropdownMenu 的 Modal 完全卸载（iOS dismiss view controller）后，
    // 再触发系统 picker；否则同一时刻无法呈现第二个 presented view controller。
    setTimeout(() => { void action(); }, 200);
  }, [onTakePhoto, onPickImage, onPickFile]);

  const handleRecordPressIn = () => {
    Keyboard.dismiss();
    hapticMedium();
    void onStartRecording();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    pulseLoopRef.current = loop;
    loop.start();
  };

  const handleRecordPressOut = useCallback(() => {
    pulseLoopRef.current?.stop();
    pulseLoopRef.current = null;
    pulseAnim.setValue(1);
    if (isRecording) {
      void onStopRecording();
    }
  }, [isRecording, onStopRecording, pulseAnim]);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const styles = useMemo(() => StyleSheet.create({
    // Outer wrapper
    wrapper: {
      backgroundColor: colors.secondary,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    // Attachment list sits above the card, with its own background
    attachContainer: {
      marginHorizontal: spacing.md,
      marginBottom: spacing.xs,
      borderRadius: radius['2xl'],
      backgroundColor: colors.card,
      overflow: 'hidden',
    },
    // Web `rounded-[24px] border border-border bg-card` 的移动端等价物
    card: {
      marginHorizontal: spacing.md,
      marginTop: spacing.xs,
      marginBottom: spacing.xs,
      borderRadius: radius.xl,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    input: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm + 2,
      paddingBottom: spacing.xs,
      fontSize: typography.body.fontSize,
      fontWeight: typography.body.fontWeight,
      color: colors.foreground,
      minHeight: INPUT_MIN_HEIGHT,
      maxHeight: INPUT_MAX_HEIGHT,
    },
    // 底部工具栏：左（附件 / 运行环境）右（模型 / 发送）
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.sm,
      gap: spacing.sm,
    },
    toolbarSide: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      flexShrink: 1,
      minWidth: 0,
    },
    // Circle button base
    circleBtn: {
      width: CIRCLE_SIZE,
      height: CIRCLE_SIZE,
      borderRadius: CIRCLE_SIZE / 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachBtn: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    modelTrigger: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.md,
      maxWidth: 140,
    },
    modelTriggerText: {
      ...fontScale.xs,
      fontWeight: fontWeight.medium,
      color: colors.mutedForeground,
    },
    // Recording pill
    recordingPill: {
      flexDirection: 'row',
      alignItems: 'center',
      height: INPUT_MIN_HEIGHT,
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
    },
    recordingDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.destructive,
    },
    recordingTime: {
      ...typography.body,
      color: colors.foreground,
      fontVariant: ['tabular-nums'],
      flex: 1,
    },
    disabledReason: {
      ...typography.caption,
      color: colors.destructive,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
    },
    cancelText: {
      ...typography.caption,
      color: colors.destructive,
    },
    // Right button variants
    micBtn: {
      backgroundColor: colors.muted,
    },
    sendBtn: {
      backgroundColor: colors.primary,
    },
    stopBtn: {
      backgroundColor: colors.destructive,
    },
    stoppingBtn: {
      backgroundColor: colors.muted,
      opacity: 0.6,
    },
    disabledRight: {
      opacity: 0.4,
    },
    // Too short floating tip
    tipContainer: {
      position: 'absolute',
      top: -32,
      alignSelf: 'center',
      backgroundColor: colors.foreground,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.xl,
    },
    tipText: {
      ...typography.caption,
      color: colors.background,
    },
  }), [colors]);

  // Right button rendering
  const renderRightButton = () => {
    const btnBase = styles.circleBtn;

    if (loading && stopping) {
      return (
        <View style={[btnBase, styles.stoppingBtn]}>
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        </View>
      );
    }
    if (showStop) {
      return (
        <TouchableOpacity style={[btnBase, styles.stopBtn]} onPress={onStop} activeOpacity={0.7}>
          <Square size={16} color={colors.primaryForeground} strokeWidth={2} />
        </TouchableOpacity>
      );
    }
    if (isRecording) {
      return (
        <TouchableOpacity style={[btnBase, styles.sendBtn]} onPress={handleRecordPressOut} activeOpacity={0.7}>
          <CircleStop size={20} color={colors.primaryForeground} strokeWidth={2} />
        </TouchableOpacity>
      );
    }
    if (hasContent) {
      return (
        <TouchableOpacity testID="chat-send-button" accessibilityLabel="发送消息" style={[btnBase, styles.sendBtn]} onPress={handleSend} activeOpacity={0.7}>
          <ArrowUp size={18} color={colors.primaryForeground} strokeWidth={2} />
        </TouchableOpacity>
      );
    }
    return (
      <TouchableOpacity
        testID="chat-microphone-button"
        accessibilityLabel="按住录音"
        style={[btnBase, styles.micBtn]}
        onPressIn={handleRecordPressIn}
        onPressOut={handleRecordPressOut}
        activeOpacity={0.7}
      >
        <Mic size={20} color={colors.foreground} strokeWidth={2} />
      </TouchableOpacity>
    );
  };

  const hasAttachments = uploadedFiles.length > 0 || uploading || !!uploadError;

  return (
    <View style={styles.wrapper} testID="chat-composer">
      {disabledReason ? <Text style={styles.disabledReason}>{disabledReason}</Text> : null}
      {/* Attachments — independent floating card above the composer */}
      {hasAttachments && (
        <View style={styles.attachContainer}>
          <FileAttachmentList
            files={uploadedFiles}
            uploading={uploading}
            uploadError={uploadError ?? null}
            onRemove={onRemoveFile}
            onDismissError={onDismissUploadError}
          />
        </View>
      )}

      {/* Composer card — 文本区在上，工具条在下（与 Web ChatInput 同一结构） */}
      <View style={styles.card}>
        {isRecording ? (
          <View style={styles.recordingPill}>
            <Animated.View style={[styles.recordingDot, { transform: [{ scale: pulseAnim }] }]} />
            <Text style={styles.recordingTime}>
              {formatDuration(recordingDuration)}
            </Text>
            <TouchableOpacity onPress={onCancelRecording}>
              <Text style={styles.cancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TextInput
            ref={inputRef}
            testID="chat-composer-input"
            accessibilityLabel="消息输入框"
            style={styles.input}
            placeholder={disabledReason || '输入消息...'}
            placeholderTextColor={colors.mutedForeground}
            value={input}
            onChangeText={setInput}
            editable={!disabledReason}
            multiline
            submitBehavior="submit"
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={handleSend}
          />
        )}

        <View style={styles.toolbar}>
          <View style={styles.toolbarSide}>
            <TouchableOpacity
              ref={attachBtnRef}
              testID="chat-attachment-button"
              accessibilityLabel="添加附件"
              style={[styles.circleBtn, styles.attachBtn]}
              onPress={showAttachOptions}
              disabled={isRecording || !!disabledReason}
              activeOpacity={0.7}
            >
              <Plus size={20} color={colors.foreground} strokeWidth={2} />
            </TouchableOpacity>
            <SandboxProfileToggle
              sessionId={sessionId}
              sessionProfile={sessionSandboxProfile}
              loading={loading}
              disabled={!!disabledReason}
            />
          </View>

          <View style={styles.toolbarSide}>
            {modelList && onModelChange && !isRecording ? (
              <ModelPicker
                testID="chat-model-picker"
                accessibilityLabel="模型选择器"
                modelList={modelList}
                selectedModel={selectedModel ?? null}
                onModelChange={onModelChange}
                sessionId={sessionId}
                disabled={!!disabledReason}
                extraSections={modelExtraSections}
                onExtraAction={onModelExtraAction}
                drillDowns={modelDrillDowns}
                onDrillDownSelect={onModelDrillDownSelect}
              >
                {(modelLabel) => (
                  <View style={styles.modelTrigger}>
                    <Text style={styles.modelTriggerText} numberOfLines={1}>
                      {modelLabel ?? selectedModel ?? '模型'}
                    </Text>
                  </View>
                )}
              </ModelPicker>
            ) : null}
            <View
              pointerEvents={disabledReason ? 'none' : 'auto'}
              style={disabledReason ? styles.disabledRight : undefined}
            >
              {renderRightButton()}
            </View>
          </View>
        </View>
      </View>

      {/* Too short tip */}
      {tooShortTip && (
        <View style={styles.tipContainer}>
          <Text style={styles.tipText}>时间太短</Text>
        </View>
      )}
      <DropdownMenu
        visible={attachMenuVisible}
        onClose={() => setAttachMenuVisible(false)}
        sections={attachSections}
        onSelect={handleAttachSelect}
        anchorTop={attachAnchorTop}
        direction="up"
        align="left"
      />
    </View>
  );
}
