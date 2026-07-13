import React, { useRef, useCallback } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { X, Check } from 'lucide-react-native';
import type { CreateUserInput, UpdateUserInput } from '@agent/shared';
import { useUsers } from '../src/hooks/useUsers';
import { UserForm, type UserFormRef } from '../src/components/user/UserForm';
import { useColors } from '../src/theme';
import { glassFree } from '../src/lib/headerItems';

export default function UserFormScreen() {
  const colors = useColors();
  const router = useRouter();
  const formRef = useRef<UserFormRef>(null);

  const params = useLocalSearchParams<{
    userId?: string;
    username?: string;
    realName?: string;
    role?: string;
    maxTurns?: string;
    maxRequests?: string;
    dingtalkStaffId?: string;
  }>();

  const isEditing = !!params.userId;
  const { createUser, updateUser } = useUsers();

  const initialValues = {
    username: params.username ?? '',
    realName: params.realName ?? '',
    role: (params.role === 'admin' ? 'admin' : 'user') as 'admin' | 'user',
    maxTurns: params.maxTurns ?? '',
    maxRequests: params.maxRequests ?? '',
    dingtalkStaffId: params.dingtalkStaffId ?? '',
  };

  const handleSubmit = useCallback(async (data: CreateUserInput | UpdateUserInput) => {
    if (isEditing) {
      await updateUser(params.userId!, data as UpdateUserInput);
    } else {
      await createUser(data as CreateUserInput);
    }
    router.back();
  }, [isEditing, params.userId, createUser, updateUser, router]);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: isEditing ? '编辑用户' : '创建用户',
          headerLeft: () => (
            <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7}>
              <X size={24} color={colors.foreground} strokeWidth={2} />
            </TouchableOpacity>
          ),
          unstable_headerLeftItems: () => [glassFree(
            <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7}>
              <X size={24} color={colors.foreground} strokeWidth={2} />
            </TouchableOpacity>
          )],
          headerRight: () => (
            <TouchableOpacity onPress={() => formRef.current?.submit()} activeOpacity={0.7}>
              <Check size={24} color={colors.foreground} strokeWidth={2} />
            </TouchableOpacity>
          ),
          unstable_headerRightItems: () => [glassFree(
            <TouchableOpacity onPress={() => formRef.current?.submit()} activeOpacity={0.7}>
              <Check size={24} color={colors.foreground} strokeWidth={2} />
            </TouchableOpacity>
          )],
        }}
      />
      <UserForm
        ref={formRef}
        isEditing={isEditing}
        initialValues={initialValues}
        onSubmit={handleSubmit}
      />
    </View>
  );
}
