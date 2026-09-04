import React, { useEffect, useRef, useState } from "react";
import { View, Text, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { authFetch } from "@agent/shared";
import { useAuth } from "../src/contexts/AuthContext";
import { showTextPrompt } from "../src/lib/prompt";
import { spacing, radius, fontScale, fontWeight, useThemedStyles } from "../src/theme";
import { Button, Card, CardContent, Chip, Input } from "../src/components/ui";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const CODE_BUTTON_WIDTH = 116;

export default function LoginScreen() {
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

  const styles = useThemedStyles((colors) => ({
    container: { flex: 1, backgroundColor: colors.background },
    keyboardView: { flex: 1, justifyContent: "center" as const },
    form: { paddingHorizontal: spacing["2xl"], gap: spacing.md },
    title: {
      ...fontScale.xl2,
      fontWeight: fontWeight.semibold,
      textAlign: "center" as const,
      color: colors.foreground,
    },
    subtitle: {
      ...fontScale.sm,
      textAlign: "center" as const,
      color: colors.mutedForeground,
      marginBottom: spacing.sm,
    },
    serviceHeader: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
    },
    serviceLabel: {
      ...fontScale.sm,
      fontWeight: fontWeight.semibold,
      color: colors.foreground,
    },
    serviceProfile: { ...fontScale.xs, color: colors.mutedForeground },
    serviceValue: { ...fontScale.xs, color: colors.mutedForeground },
    serviceIssue: { ...fontScale.xs, color: colors.dangerFamily.ink },
    serviceActions: { flexDirection: "row" as const, gap: spacing.lg },
    modeRow: { flexDirection: "row" as const, gap: spacing.sm },
    codeRow: { flexDirection: "row" as const, gap: spacing.sm, alignItems: "center" as const },
    codeInput: { flex: 1 },
    codeButton: { width: CODE_BUTTON_WIDTH },
    errorBanner: {
      backgroundColor: colors.dangerFamily.subtle,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    errorText: { ...fontScale.sm, color: colors.dangerFamily.ink },
    cardBody: { gap: spacing.xs, paddingTop: spacing.lg },
  }));

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

  const profileLabel = serviceConfig.profile === "production"
    ? "生产"
    : serviceConfig.profile === "preview"
      ? "预览"
      : "开发";

  return (
    <SafeAreaView style={styles.container} testID="login-screen" accessibilityLabel="登录">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardView}
      >
        <View style={styles.form}>
          <Text style={styles.title}>Agent SaaS</Text>
          <Text style={styles.subtitle}>AI 智能助手</Text>

          <Card density="compact">
            <CardContent style={styles.cardBody}>
              <View style={styles.serviceHeader}>
                <Text style={styles.serviceLabel}>服务确认</Text>
                <Text style={styles.serviceProfile}>{profileLabel}</Text>
              </View>
              <Text style={styles.serviceValue} numberOfLines={2}>
                {serviceConfig.apiOrigin ?? "未配置可信服务"}
              </Text>
              {serviceConfig.issue ? (
                <Text style={styles.serviceIssue}>{serviceConfig.issue.message}</Text>
              ) : null}
              <View style={styles.serviceActions}>
                <Button
                  variant="link"
                  size="sm"
                  label={checkingConfig ? "检查中…" : "重新检查"}
                  disabled={checkingConfig || loading}
                  onPress={() => void handleReloadServiceConfig()}
                />
                {serviceConfig.editable ? (
                  <Button
                    variant="link"
                    size="sm"
                    label="切换服务"
                    disabled={loading}
                    onPress={handleChangeServiceOrigin}
                  />
                ) : null}
              </View>
            </CardContent>
          </Card>

          <View style={styles.modeRow}>
            <Chip
              testID="login-password-mode"
              accessibilityLabel="密码登录"
              label="密码登录"
              selected={mode === "password"}
              onPress={() => { setMode("password"); setError(""); }}
            />
            <Chip
              testID="login-sms-mode"
              accessibilityLabel="验证码登录"
              label="验证码登录"
              selected={mode === "sms"}
              onPress={() => { setMode("sms"); setError(""); }}
            />
          </View>

          {mode === "password" ? (
            <>
              <Input
                testID="login-username-input"
                accessibilityLabel="用户名"
                placeholder="用户名"
                value={username}
                onChangeText={setUsername}
                returnKeyType="next"
              />
              <Input
                testID="login-password-input"
                accessibilityLabel="密码"
                placeholder="密码"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />
            </>
          ) : (
            <>
              <Input
                testID="login-phone-input"
                accessibilityLabel="手机号"
                placeholder="手机号"
                value={phone}
                onChangeText={(value) => setPhone(value.replace(/\D/g, "").slice(0, 11))}
                keyboardType="phone-pad"
                maxLength={11}
                returnKeyType="next"
              />
              <View style={styles.codeRow}>
                <Input
                  testID="login-otp-input"
                  accessibilityLabel="验证码"
                  style={styles.codeInput}
                  placeholder="验证码"
                  value={code}
                  onChangeText={(value) => setCode(value.replace(/\D/g, "").slice(0, 6))}
                  keyboardType="number-pad"
                  maxLength={6}
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                />
                <Button
                  testID="login-send-otp"
                  accessibilityLabel="获取验证码"
                  variant="outline"
                  size="lg"
                  style={styles.codeButton}
                  label={countdown > 0 ? `${countdown}s` : "获取验证码"}
                  loading={sendingCode}
                  disabled={countdown > 0 || loading || !serviceConfig.ready}
                  onPress={() => void handleSendSmsCode()}
                />
              </View>
            </>
          )}

          {error ? (
            <View style={styles.errorBanner} accessibilityRole="alert">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Button
            testID="login-submit"
            accessibilityLabel="提交登录"
            variant="primary"
            size="lg"
            fullWidth
            label={mode === "password" ? "登录" : "验证码登录"}
            loading={loading}
            disabled={!serviceConfig.ready}
            onPress={() => void handleLogin()}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
