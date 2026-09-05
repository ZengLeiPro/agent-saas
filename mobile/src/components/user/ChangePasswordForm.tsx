import React, { forwardRef, useCallback, useImperativeHandle, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { spacing, radius, fontScale, fontWeight, useThemedStyles } from '../../theme';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '../ui';

export interface ChangePasswordFormRef {
  submit: () => void;
}

interface ChangePasswordFormProps {
  onSubmit: (data: { oldPassword: string; newPassword: string }) => Promise<void>;
}

/** 新密码最短长度（与服务端校验一致） */
const MIN_PASSWORD_LENGTH = 6;

export const ChangePasswordForm = forwardRef<ChangePasswordFormRef, ChangePasswordFormProps>(
  function ChangePasswordForm({ onSubmit }, ref) {
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const styles = useThemedStyles((colors) => ({
      flex: { flex: 1, backgroundColor: colors.background },
      content: { padding: spacing.lg, gap: spacing.lg },
      errorBanner: {
        backgroundColor: colors.dangerFamily.subtle,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
      },
      errorText: { ...fontScale.sm, color: colors.dangerFamily.ink },
      field: { gap: spacing.xs },
      label: {
        ...fontScale.sm,
        fontWeight: fontWeight.medium,
        color: colors.foreground,
      },
      cardBody: { gap: spacing.lg },
    }));

    const handleSubmit = useCallback(async () => {
      if (submitting) return;
      setError(null);

      if (!oldPassword) {
        setError('请输入当前密码');
        return;
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setError(`新密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
        return;
      }
      if (newPassword !== confirmPassword) {
        setError('两次输入的新密码不一致');
        return;
      }

      setSubmitting(true);
      try {
        await onSubmit({ oldPassword, newPassword });
      } catch (err) {
        setError(err instanceof Error ? err.message : '修改失败');
      } finally {
        setSubmitting(false);
      }
    }, [submitting, oldPassword, newPassword, confirmPassword, onSubmit]);

    useImperativeHandle(ref, () => ({ submit: () => void handleSubmit() }), [handleSubmit]);

    return (
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {error ? (
            <View style={styles.errorBanner} accessibilityRole="alert">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>修改登录密码</CardTitle>
              <CardDescription>
                修改后当前设备保持登录，其他设备需要用新密码重新登录。
              </CardDescription>
            </CardHeader>
            <CardContent style={styles.cardBody}>
              <View style={styles.field}>
                <Text style={styles.label}>当前密码</Text>
                <Input
                  testID="change-password-old"
                  accessibilityLabel="当前密码"
                  value={oldPassword}
                  onChangeText={setOldPassword}
                  placeholder="当前密码"
                  secureTextEntry
                  autoFocus
                />
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>新密码</Text>
                <Input
                  testID="change-password-new"
                  accessibilityLabel="新密码"
                  value={newPassword}
                  onChangeText={setNewPassword}
                  placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
                  secureTextEntry
                />
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>确认新密码</Text>
                <Input
                  testID="change-password-confirm"
                  accessibilityLabel="确认新密码"
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder="再次输入"
                  secureTextEntry
                  returnKeyType="done"
                  onSubmitEditing={() => void handleSubmit()}
                />
              </View>
            </CardContent>
          </Card>

          <Button
            testID="change-password-submit"
            accessibilityLabel="保存新密码"
            label="保存新密码"
            variant="primary"
            size="lg"
            fullWidth
            loading={submitting}
            onPress={() => void handleSubmit()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  },
);
