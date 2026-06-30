import React, { useRef, useCallback } from 'react';
import { View, TouchableOpacity, Alert } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Feather } from '@expo/vector-icons';
import { authFetch } from '@agent/shared';
import { ChangePasswordForm, type ChangePasswordFormRef } from '../src/components/user/ChangePasswordForm';
import { useColors } from '../src/theme';
import { glassFree } from '../src/lib/headerItems';

export default function ChangePasswordScreen() {
  const colors = useColors();
  const router = useRouter();
  const formRef = useRef<ChangePasswordFormRef>(null);

  const handleSubmit = useCallback(async (data: { oldPassword: string; newPassword: string }) => {
    const res = await authFetch('/api/auth/password', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || '修改失败');
    }
    Alert.alert('成功', '密码已修改');
  }, []);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: '修改密码',
          headerLeft: () => (
            <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7}>
              <Ionicons name="close" size={24} color={colors.foreground} />
            </TouchableOpacity>
          ),
          unstable_headerLeftItems: () => [glassFree(
            <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7}>
              <Ionicons name="close" size={24} color={colors.foreground} />
            </TouchableOpacity>
          )],
          headerRight: () => (
            <TouchableOpacity onPress={() => formRef.current?.submit()} activeOpacity={0.7}>
              <Feather name="check" size={24} color={colors.foreground} />
            </TouchableOpacity>
          ),
          unstable_headerRightItems: () => [glassFree(
            <TouchableOpacity onPress={() => formRef.current?.submit()} activeOpacity={0.7}>
              <Feather name="check" size={24} color={colors.foreground} />
            </TouchableOpacity>
          )],
        }}
      />
      <ChangePasswordForm
        ref={formRef}
        onSubmit={async (data) => {
          await handleSubmit(data);
          router.back();
        }}
      />
    </View>
  );
}
