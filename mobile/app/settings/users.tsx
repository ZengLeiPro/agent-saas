import React, { useCallback, useEffect, useMemo } from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { UserManager } from '../../src/components/UserManager';
import { useColors } from '../../src/theme';
import { hapticLight } from '../../src/lib/haptics';
import { glassFree } from '../../src/lib/headerItems';
import { useAuth } from '../../src/contexts/AuthContext';

export default function UsersScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();

  // Admin guard
  useEffect(() => {
    if (user && user.role !== 'admin') router.replace('/(tabs)/settings');
  }, [user, router]);
  if (!user || user.role !== 'admin') return null;

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
  }), [colors]);

  const handleAdd = useCallback(() => {
    hapticLight();
    router.push('/user-form');
  }, [router]);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <TouchableOpacity onPress={handleAdd} activeOpacity={0.7}>
              <Plus size={24} color={colors.foreground} strokeWidth={2} />
            </TouchableOpacity>
          ),
          unstable_headerRightItems: () => [glassFree(
            <TouchableOpacity onPress={handleAdd} activeOpacity={0.7}>
              <Plus size={24} color={colors.foreground} strokeWidth={2} />
            </TouchableOpacity>
          )],
        }}
      />
      <UserManager />
    </View>
  );
}
