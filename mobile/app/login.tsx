import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { authFetch } from "@agent/shared";
import { useAuth } from "../src/contexts/AuthContext";
import { showTextPrompt } from "../src/lib/prompt";
import { useColors, spacing, typography } from "../src/theme";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

export default function LoginScreen() {
  const colors = useColors();
  const {
    login,
    loginWithSms,
    serviceConfig,
    changeServiceOrigin,
    reloadServiceConfig,
  } = useAuth();
  const [mode, setMode] = useState<"password" | "sms">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [checkingConfig, setCheckingConfig] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: colors.background,
        },
        keyboardView: {
          flex: 1,
          justifyContent: "center",
        },
        form: {
          paddingHorizontal: spacing["3xl"],
        },
        title: {
          ...typography.title,
          fontSize: 28,
          textAlign: "center",
          color: colors.foreground,
          marginBottom: spacing.xs,
        },
        subtitle: {
          ...typography.body,
          textAlign: "center",
          color: colors.mutedForeground,
          marginBottom: spacing.xl,
        },
        serviceCard: {
          backgroundColor: colors.card,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 10,
          padding: spacing.md,
          marginBottom: spacing.xl,
        },
        serviceHeader: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: spacing.xs,
        },
        serviceLabel: {
          ...typography.bodySmall,
          color: colors.foreground,
          fontWeight: "600",
        },
        serviceProfile: {
          ...typography.caption,
          color: colors.mutedForeground,
        },
        serviceValue: {
          ...typography.caption,
          color: colors.mutedForeground,
        },
        serviceIssue: {
          ...typography.caption,
          color: colors.destructive,
          marginTop: spacing.xs,
        },
        serviceActions: {
          flexDirection: "row",
          gap: spacing.lg,
          marginTop: spacing.sm,
        },
        serviceActionText: {
          ...typography.bodySmall,
          color: colors.primary,
          fontWeight: "600",
        },
        input: {
          backgroundColor: colors.card,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 10,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          fontSize: typography.body.fontSize,
          fontWeight: typography.body.fontWeight,
          color: colors.foreground,
          marginBottom: spacing.md,
        },
        segmented: {
          flexDirection: "row",
          backgroundColor: colors.muted,
          borderRadius: 10,
          padding: 4,
          marginBottom: spacing.lg,
        },
        segment: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 8,
          paddingVertical: 9,
        },
        segmentActive: {
          backgroundColor: colors.card,
        },
        segmentText: {
          ...typography.bodySmall,
          color: colors.mutedForeground,
          fontWeight: "600",
        },
        segmentTextActive: {
          color: colors.foreground,
        },
        codeRow: {
          flexDirection: "row",
          gap: spacing.sm,
          marginBottom: spacing.md,
        },
        codeInput: {
          flex: 1,
          marginBottom: 0,
        },
        codeButton: {
          width: 116,
          backgroundColor: colors.card,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: spacing.sm,
        },
        codeButtonDisabled: {
          opacity: 0.6,
        },
        codeButtonText: {
          ...typography.bodySmall,
          color: colors.foreground,
          fontWeight: "600",
        },
        error: {
          ...typography.bodySmall,
          color: colors.destructive,
          marginBottom: spacing.md,
          textAlign: "center",
        },
        button: {
          backgroundColor: colors.primary,
          borderRadius: 10,
          paddingVertical: 14,
          alignItems: "center",
          marginTop: spacing.sm,
        },
        buttonDisabled: {
          opacity: 0.6,
        },
        buttonText: {
          ...typography.subtitle,
          color: colors.primaryForeground,
        },
      }),
    [colors],
  );

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const handleReloadServiceConfig = async () => {
    setCheckingConfig(true);
    setError("");
    try {
      const config = await reloadServiceConfig();
      if (!config.ready) {
        setError(config.issue?.message ?? "可信服务配置尚未就绪");
      }
    } finally {
      setCheckingConfig(false);
    }
  };

  const handleChangeServiceOrigin = () => {
    const allowed = serviceConfig.apiAllowlist.join("\n");
    showTextPrompt({
      title: "选择可信服务",
      message: allowed
        ? `仅可使用此构建允许的地址：\n${allowed}`
        : "此构建没有可选择的可信服务地址",
      defaultValue: serviceConfig.apiOrigin ?? "",
      placeholder: "https://...",
      confirmText: "确认",
      keyboardType: "url",
      onConfirm: async (value) => {
        const result = await changeServiceOrigin(value.trim());
        if (!result.ok) {
          setError(result.error ?? "服务地址不可用");
        } else if (result.changed) {
          setError("服务已切换，请重新登录");
        }
      },
    });
  };

  const startCountdown = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCountdown(60);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSendSmsCode = async () => {
    if (!serviceConfig.ready) {
      setError(serviceConfig.issue?.message ?? "可信服务配置尚未就绪");
      return;
    }
    if (!PHONE_PATTERN.test(phone)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
    setError("");
    setSendingCode(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await authFetch("/api/auth/sms/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "验证码发送失败");
        return;
      }
      startCountdown();
    } catch {
      setError("无法连接可信服务，请检查网络或 TLS 配置后重试");
    } finally {
      clearTimeout(timeout);
      setSendingCode(false);
    }
  };

  const handleLogin = async () => {
    if (!serviceConfig.ready) {
      setError(serviceConfig.issue?.message ?? "可信服务配置尚未就绪");
      return;
    }
    if (mode === "password" && (!username.trim() || !password.trim())) {
      setError("请输入用户名和密码");
      return;
    }
    if (mode === "sms") {
      if (!PHONE_PATTERN.test(phone)) {
        setError("请输入有效的 11 位手机号");
        return;
      }
      if (!code.trim()) {
        setError("请输入验证码");
        return;
      }
    }
    setError("");
    setLoading(true);
    try {
      const result = mode === "password"
        ? await login(username.trim(), password)
        : await loginWithSms(phone, code);
      if (!result.ok) {
        setError(result.error || "登录失败");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} testID="login-screen" accessibilityLabel="登录">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardView}
      >
        <View style={styles.form}>
          <Text style={styles.title}>Agent SaaS</Text>
          <Text style={styles.subtitle}>AI 智能助手</Text>

          <View style={styles.serviceCard}>
            <View style={styles.serviceHeader}>
              <Text style={styles.serviceLabel}>服务确认</Text>
              <Text style={styles.serviceProfile}>
                {serviceConfig.profile === "production"
                  ? "生产"
                  : serviceConfig.profile === "preview"
                    ? "预览"
                    : "开发"}
              </Text>
            </View>
            <Text style={styles.serviceValue} numberOfLines={2}>
              {serviceConfig.apiOrigin ?? "未配置可信服务"}
            </Text>
            {serviceConfig.issue ? (
              <Text style={styles.serviceIssue}>{serviceConfig.issue.message}</Text>
            ) : null}
            <View style={styles.serviceActions}>
              <TouchableOpacity
                onPress={() => void handleReloadServiceConfig()}
                disabled={checkingConfig}
              >
                <Text style={styles.serviceActionText}>
                  {checkingConfig ? "检查中…" : "重新检查"}
                </Text>
              </TouchableOpacity>
              {serviceConfig.editable ? (
                <TouchableOpacity onPress={handleChangeServiceOrigin}>
                  <Text style={styles.serviceActionText}>切换服务</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          <View style={styles.segmented}>
            <TouchableOpacity
              testID="login-password-mode"
              accessibilityLabel="密码登录"
              style={[styles.segment, mode === "password" && styles.segmentActive]}
              onPress={() => { setMode("password"); setError(""); }}
              activeOpacity={0.8}
            >
              <Text style={[styles.segmentText, mode === "password" && styles.segmentTextActive]}>密码登录</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="login-sms-mode"
              accessibilityLabel="验证码登录"
              style={[styles.segment, mode === "sms" && styles.segmentActive]}
              onPress={() => { setMode("sms"); setError(""); }}
              activeOpacity={0.8}
            >
              <Text style={[styles.segmentText, mode === "sms" && styles.segmentTextActive]}>验证码登录</Text>
            </TouchableOpacity>
          </View>

          {mode === "password" ? (
            <>
              <TextInput
                testID="login-username-input"
                accessibilityLabel="用户名"
                style={styles.input}
                placeholder="用户名"
                placeholderTextColor={colors.mutedForeground}
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />

              <TextInput
                testID="login-password-input"
                accessibilityLabel="密码"
                style={styles.input}
                placeholder="密码"
                placeholderTextColor={colors.mutedForeground}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />
            </>
          ) : (
            <>
              <TextInput
                testID="login-phone-input"
                accessibilityLabel="手机号"
                style={styles.input}
                placeholder="手机号"
                placeholderTextColor={colors.mutedForeground}
                value={phone}
                onChangeText={(value) => setPhone(value.replace(/\D/g, "").slice(0, 11))}
                keyboardType="phone-pad"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={11}
                returnKeyType="next"
              />

              <View style={styles.codeRow}>
                <TextInput
                  testID="login-otp-input"
                  accessibilityLabel="验证码"
                  style={[styles.input, styles.codeInput]}
                  placeholder="验证码"
                  placeholderTextColor={colors.mutedForeground}
                  value={code}
                  onChangeText={(value) => setCode(value.replace(/\D/g, "").slice(0, 6))}
                  keyboardType="number-pad"
                  maxLength={6}
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                />
                <TouchableOpacity
                  testID="login-send-otp"
                  accessibilityLabel="获取验证码"
                  style={[
                    styles.codeButton,
                    (sendingCode || countdown > 0 || loading || !serviceConfig.ready) && styles.codeButtonDisabled,
                  ]}
                  onPress={handleSendSmsCode}
                  disabled={sendingCode || countdown > 0 || loading || !serviceConfig.ready}
                  activeOpacity={0.7}
                >
                  {sendingCode ? (
                    <ActivityIndicator color={colors.foreground} />
                  ) : (
                    <Text style={styles.codeButtonText}>
                      {countdown > 0 ? `${countdown}s` : "获取验证码"}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            testID="login-submit"
            accessibilityLabel="提交登录"
            style={[styles.button, (loading || !serviceConfig.ready) && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading || !serviceConfig.ready}
            activeOpacity={0.7}
          >
            {loading ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.buttonText}>{mode === "password" ? "登录" : "验证码登录"}</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
