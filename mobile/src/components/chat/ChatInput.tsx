import React, { useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
  Alert,
  Text,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { Square, CircleStop, ArrowUp, Mic, Plus } from 'lucide-react-native';
import type { UploadedFile } from '@agent/shared';
import { useColors, useTheme, spacing, typography, radius } from '../../theme';
import { FileAttachmentList } from './FileAttachmentList';
import { hapticLight, hapticMedium } from '../../lib/haptics';
import { DropdownMenu, type DropdownSection } from '../overlays/DropdownMenu';

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
}

const INPUT_MIN_HEIGHT = 40;
const INPUT_MAX_HEIGHT = 120;

export function ChatInput({
  input, setInput, loading, onSend, onStop, stopping,
  uploadedFiles, uploading, uploadError, onDismissUploadError, onPickFile, onPickImage, onTakePhoto, onRemoveFile,
  isRecording, recordingDuration, onStartRecording, onStopRecording, onCancelRecording,
  sessionId, tooShortTip,
}: ChatInputProps) {
  const colors = useColors();
  const { isDark } = useTheme();

  const inputRef = useRef<TextInput>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  const hasContent = input.trim().length > 0 || uploadedFiles.length > 0;
  const showStop = loading && (!hasContent || stopping);

  const handleSend = () => {
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
    attachBtnRef.current?.measureInWindow((_x, y, _w, _h) => {
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
    // Attachment list sits above the row, with its own background
    attachContainer: {
      marginHorizontal: 14,
      marginBottom: 4,
      borderRadius: 16,
      backgroundColor: colors.card,
      overflow: 'hidden',
    },
    // Single row layout — transparent background
    row: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 14,
      paddingVertical: 6,
      gap: 6,
    },
    // Circle button base
    circleBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.card,
    },
    // Input pill
    inputPill: {
      flex: 1,
      borderRadius: radius.md,
      backgroundColor: colors.card,
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 10,
      fontSize: typography.body.fontSize,
      fontWeight: typography.body.fontWeight,
      color: colors.foreground,
      minHeight: INPUT_MIN_HEIGHT,
      maxHeight: INPUT_MAX_HEIGHT,
      textAlignVertical: 'center',
    },
    // Recording pill
    recordingPill: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      height: INPUT_MIN_HEIGHT,
      borderRadius: radius.md,
      backgroundColor: colors.card,
      paddingHorizontal: 12,
      gap: 8,
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
    cancelText: {
      ...typography.caption,
      color: colors.destructive,
    },
    // Right button variants
    micBtn: {
      backgroundColor: colors.card,
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
    // Too short floating tip
    tipContainer: {
      position: 'absolute',
      top: -32,
      alignSelf: 'center',
      backgroundColor: colors.foreground,
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: 12,
    },
    tipText: {
      ...typography.caption,
      color: colors.background,
    },
  }), [colors, isDark]);

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
        <TouchableOpacity style={[btnBase, styles.sendBtn]} onPress={handleSend} activeOpacity={0.7}>
          <ArrowUp size={18} color={colors.primaryForeground} strokeWidth={2} />
        </TouchableOpacity>
      );
    }
    return (
      <TouchableOpacity
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
    <View style={styles.wrapper}>
      {/* Attachments — independent floating card above the row */}
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

      {/* Main input row — each element floats independently */}
      <View style={styles.row}>
        {/* Left: attach button */}
        <TouchableOpacity
          ref={attachBtnRef}
          style={styles.circleBtn}
          onPress={showAttachOptions}
          disabled={isRecording}
          activeOpacity={0.7}
        >
          <Plus
            size={24}
            color={colors.mutedForeground}
            strokeWidth={2}
          />
        </TouchableOpacity>

        {/* Center: input or recording indicator */}
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
            style={styles.inputPill}
            placeholder="输入消息..."
            placeholderTextColor={colors.mutedForeground}
            value={input}
            onChangeText={setInput}
            multiline
            submitBehavior="submit"
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={handleSend}
          />
        )}

        {/* Right: mic / send / stop */}
        {renderRightButton()}
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
