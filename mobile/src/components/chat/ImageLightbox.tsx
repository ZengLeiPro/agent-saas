import React, { useMemo } from 'react';
import { Modal, View, Pressable, StyleSheet, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { X } from 'lucide-react-native';
import { useColors } from '../../theme';

interface ImageLightboxProps {
  visible: boolean;
  uri: string;
  onClose: () => void;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export function ImageLightbox({ visible, uri, onClose }: ImageLightboxProps) {
  const colors = useColors();

  const styles = useMemo(() => StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: colors.overlayHeavy,
      justifyContent: 'center',
      alignItems: 'center',
    },
    closeButton: {
      position: 'absolute',
      top: 60,
      right: 20,
      zIndex: 10,
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.overlay,
      justifyContent: 'center',
      alignItems: 'center',
    },
    image: {
      width: SCREEN_W * 0.95,
      height: SCREEN_H * 0.8,
    },
  }), [colors]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.closeButton} onPress={onClose}>
          <X size={24} color={colors.onOverlay} strokeWidth={2} />
        </Pressable>
        <Image
          source={{ uri }}
          style={styles.image}
          contentFit="contain"
          cachePolicy="disk"
        />
      </Pressable>
    </Modal>
  );
}
