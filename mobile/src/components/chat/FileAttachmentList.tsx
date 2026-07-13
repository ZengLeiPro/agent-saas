import React, { useMemo } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Play, Video, File, CircleX, CircleAlert, X } from 'lucide-react-native';
import type { UploadedFile } from '@agent/shared';
import { useColors, spacing, typography, radius } from '../../theme';

interface FileAttachmentListProps {
  files: UploadedFile[];
  uploading: boolean;
  uploadError?: string | null;
  onRemove: (index: number) => void;
  onDismissError?: () => void;
}

export function FileAttachmentList({ files, uploading, uploadError, onRemove, onDismissError }: FileAttachmentListProps) {
  const colors = useColors();

  const styles = useMemo(() => StyleSheet.create({
    container: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border + '40',
      backgroundColor: 'transparent',
    },
    scroll: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    item: {
      width: 72,
      alignItems: 'center',
    },
    preview: {
      width: 56,
      height: 56,
      borderRadius: radius.md,
      backgroundColor: colors.muted,
    },
    fileIcon: {
      width: 56,
      height: 56,
      borderRadius: radius.md,
      backgroundColor: colors.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fileName: {
      ...typography.caption,
      color: colors.mutedForeground,
      marginTop: 2,
      textAlign: 'center',
      width: 68,
    },
    removeButton: {
      position: 'absolute',
      top: -4,
      right: 0,
    },
    uploadingItem: {
      justifyContent: 'center',
      height: 56,
    },
    playBadge: {
      position: 'absolute',
      bottom: 4,
      right: 4,
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.overlay,
      alignItems: 'center',
      justifyContent: 'center',
    },
    errorBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    errorText: {
      ...typography.caption,
      color: colors.destructive,
      flex: 1,
    },
    errorDismiss: {
      padding: 2,
    },
  }), [colors]);

  if (files.length === 0 && !uploading && !uploadError) return null;

  const hasItems = files.length > 0 || uploading;

  return (
    <View style={styles.container}>
      {hasItems && (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {files.map((file, index) => {
          const isVideo = file.mimeType?.startsWith('video/');
          return (
          <View key={`${file.savedPath}-${index}`} style={styles.item}>
            {(file.isImage || isVideo) && file.previewUrl ? (
              <View>
                <Image source={{ uri: file.previewUrl }} style={styles.preview} />
                {isVideo && (
                  <View style={styles.playBadge}>
                    <Play size={16} color={colors.onOverlay} strokeWidth={2} />
                  </View>
                )}
              </View>
            ) : (
              <View style={styles.fileIcon}>
                {isVideo
                  ? <Video size={24} color={colors.mutedForeground} strokeWidth={2} />
                  : <File size={24} color={colors.mutedForeground} strokeWidth={2} />}
              </View>
            )}
            <Text style={styles.fileName} numberOfLines={1}>
              {file.originalName}
            </Text>
            <TouchableOpacity style={styles.removeButton} onPress={() => onRemove(index)}>
              <CircleX size={18} color={colors.mutedForeground} strokeWidth={2} />
            </TouchableOpacity>
          </View>
          );
        })}
        {uploading && (
          <View style={[styles.item, styles.uploadingItem]}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        )}
      </ScrollView>
      )}
      {uploadError && (
        <View style={styles.errorBar}>
          <CircleAlert size={16} color={colors.destructive} strokeWidth={2} />
          <Text style={styles.errorText} numberOfLines={2}>
            {uploadError}
          </Text>
          {onDismissError && (
            <TouchableOpacity style={styles.errorDismiss} onPress={onDismissError}>
              <X size={16} color={colors.destructive} strokeWidth={2} />
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}
