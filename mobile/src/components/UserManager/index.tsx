import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import type { UserInfo } from '@agent/shared';
import { useUsers } from '../../hooks/useUsers';
import { UserList } from './UserList';
import { useColors } from '../../theme';

export function UserManager() {
  const colors = useColors();
  const { users, loading, refresh } = useUsers();
  const router = useRouter();

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
    },
  }), [colors]);

  // Re-fetch when returning from formSheet
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const handleSelect = (user: UserInfo) => {
    router.push({
      pathname: '/settings/user-detail/[userId]',
      params: { userId: user.id },
    });
  };

  return (
    <View style={styles.container}>
      <UserList
        users={users}
        loading={loading}
        onRefresh={refresh}
        onSelect={handleSelect}
      />
    </View>
  );
}
