import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useState,
} from "react";
import type { CreateUserInput, UpdateUserInput } from "@agent/shared";
import {
  FormScrollView,
  FormSection,
  FormErrorBanner,
  FormTextField,
  FormSwitchRow,
  FormSegmentedRow,
  type SegmentedOption,
} from "../form";

export interface UserFormRef {
  submit: () => void;
}

interface UserFormProps {
  isEditing: boolean;
  initialValues: {
    username: string;
    realName: string;
    role: "admin" | "user";
    maxTurns: string;
    maxRequests: string;
    dingtalkStaffId: string;
  };
  onSubmit: (data: CreateUserInput | UpdateUserInput) => Promise<void>;
}

const ROLE_OPTIONS: SegmentedOption<"admin" | "user">[] = [
  { value: "admin", label: "管理员" },
  { value: "user", label: "用户" },
];

export const UserForm = forwardRef<UserFormRef, UserFormProps>(
  function UserForm({ isEditing, initialValues, onSubmit }, ref) {
    const [username, setUsername] = useState(initialValues.username);
    const [realName, setRealName] = useState(initialValues.realName);
    const [password, setPassword] = useState("");
    const [role, setRole] = useState<"admin" | "user">(initialValues.role);
    const [maxTurns, setMaxTurns] = useState(initialValues.maxTurns);
    const [maxRequests, setMaxRequests] = useState(initialValues.maxRequests);
    const [dingtalkStaffId, setDingtalkStaffId] = useState(
      initialValues.dingtalkStaffId,
    );

    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = useCallback(async () => {
      if (submitting) return;
      setError(null);

      if (!isEditing && !username.trim()) {
        setError("用户名不能为空");
        return;
      }
      if (!isEditing && password.length < 6) {
        setError("密码至少 6 个字符");
        return;
      }
      if (isEditing && password && password.length < 6) {
        setError("密码至少 6 个字符");
        return;
      }

      const permissions: {
        maxTurns?: number;
        rateLimit?: { maxRequests?: number };
      } = {};
      if (maxTurns.trim()) permissions.maxTurns = parseInt(maxTurns, 10);
      if (maxRequests.trim())
        permissions.rateLimit = { maxRequests: parseInt(maxRequests, 10) };

      setSubmitting(true);
      try {
        if (isEditing) {
          const input: UpdateUserInput = {
            role,
            ...(realName.trim() ? { realName: realName.trim() } : {}),
            ...(password ? { password } : {}),
            ...(dingtalkStaffId.trim()
              ? { dingtalkStaffId: dingtalkStaffId.trim() }
              : {}),
            ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
          };
          await onSubmit(input);
        } else {
          const input: CreateUserInput = {
            username: username.trim(),
            password,
            role,
            ...(realName.trim() ? { realName: realName.trim() } : {}),
            ...(dingtalkStaffId.trim()
              ? { dingtalkStaffId: dingtalkStaffId.trim() }
              : {}),
            ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
          };
          await onSubmit(input);
        }
      } catch (err: any) {
        setError(err?.message || "操作失败");
      } finally {
        setSubmitting(false);
      }
    }, [
      submitting,
      isEditing,
      username,
      realName,
      password,
      role,
      maxTurns,
      maxRequests,
      dingtalkStaffId,
      onSubmit,
    ]);

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

        <FormSection header="账户">
          <FormTextField
            label="用户名"
            value={username}
            onChangeText={setUsername}
            placeholder={isEditing ? "" : "必填"}
            disabled={isEditing}
            autoCapitalize="none"
          />
          <FormTextField
            label="真实姓名"
            value={realName}
            onChangeText={setRealName}
            placeholder="可选"
            autoCapitalize="words"
          />
          <FormTextField
            label="密码"
            value={password}
            onChangeText={setPassword}
            placeholder={isEditing ? "留空不修改" : "至少 6 位"}
            secureTextEntry
          />
          <FormTextField
            label="钉钉 ID"
            value={dingtalkStaffId}
            onChangeText={setDingtalkStaffId}
            placeholder="可选"
          />
        </FormSection>

        <FormSection header="角色">
          <FormSegmentedRow
            label="角色"
            value={role}
            options={ROLE_OPTIONS}
            onChange={setRole}
          />
        </FormSection>

        <FormSection header="权限">
          <FormTextField
            label="最大轮次"
            value={maxTurns}
            onChangeText={setMaxTurns}
            placeholder="不限制"
            keyboardType="numeric"
          />
          <FormTextField
            label="每分钟请求"
            value={maxRequests}
            onChangeText={setMaxRequests}
            placeholder="不限制"
            keyboardType="numeric"
          />
        </FormSection>
      </FormScrollView>
    );
  },
);
