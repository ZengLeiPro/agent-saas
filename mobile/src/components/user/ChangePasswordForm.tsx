import React, { forwardRef, useCallback, useImperativeHandle, useState } from 'react';
import {
  FormScrollView,
  FormSection,
  FormErrorBanner,
  FormTextField,
} from '../form';

export interface ChangePasswordFormRef {
  submit: () => void;
}

interface ChangePasswordFormProps {
  onSubmit: (data: { oldPassword: string; newPassword: string }) => Promise<void>;
}

export const ChangePasswordForm = forwardRef<ChangePasswordFormRef, ChangePasswordFormProps>(
  function ChangePasswordForm({ onSubmit }, ref) {
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');

    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = useCallback(async () => {
      if (submitting) return;
      setError(null);

      if (!oldPassword) {
        setError('请输入当前密码');
        return;
      }
      if (newPassword.length < 6) {
        setError('新密码至少 6 个字符');
        return;
      }
      if (newPassword !== confirmPassword) {
        setError('两次输入的新密码不一致');
        return;
      }

      setSubmitting(true);
      try {
        await onSubmit({ oldPassword, newPassword });
      } catch (err: any) {
        setError(err?.message || '修改失败');
      } finally {
        setSubmitting(false);
      }
    }, [submitting, oldPassword, newPassword, confirmPassword, onSubmit]);

    useImperativeHandle(
      ref,
      () => ({
        submit: () => void handleSubmit(),
      }),
      [handleSubmit],
    );

    return (
      <FormScrollView>
        {error ? <FormErrorBanner message={error} /> : null}
        <FormSection>
          <FormTextField
            label="当前密码"
            value={oldPassword}
            onChangeText={setOldPassword}
            placeholder="当前密码"
            secureTextEntry
            autoFocus
          />
          <FormTextField
            label="新密码"
            value={newPassword}
            onChangeText={setNewPassword}
            placeholder="至少 6 位"
            secureTextEntry
          />
          <FormTextField
            label="确认新密码"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder="再次输入"
            secureTextEntry
          />
        </FormSection>
      </FormScrollView>
    );
  },
);
