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
import { useColors, spacing, typography } from "../src/theme";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

export default function LoginScreen() {
  const colors = useColors();
  const { login, loginWithSms } = useAuth();
  const [mode, setMode] = useState<"password" | "sms">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
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
          marginBottom: spacing["4xl"],
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
    if (!PHONE_PATTERN.test(phone)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
    setError("");
    setSendingCode(true);
    try {
      const res = await authFetch("/api/auth/sms/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "验证码发送失败");
        return;
      }
      startCountdown();
    } catch {
      setError("网络错误，请检查服务器地址");
    } finally {
      setSendingCode(false);
    }
  };

  const handleLogin = async () => {
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
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardView}
      >
        <View style={styles.form}>
          <Text style={styles.title}>Agent SaaS</Text>
          <Text style={styles.subtitle}>AI 智能助手</Text>

          <View style={styles.segmented}>
            <TouchableOpacity
              style={[styles.segment, mode === "password" && styles.segmentActive]}
              onPress={() => { setMode("password"); setError(""); }}
              activeOpacity={0.8}
            >
              <Text style={[styles.segmentText, mode === "password" && styles.segmentTextActive]}>密码登录</Text>
            </TouchableOpacity>
            <TouchableOpacity
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
                  style={[
                    styles.codeButton,
                    (sendingCode || countdown > 0 || loading) && styles.codeButtonDisabled,
                  ]}
                  onPress={handleSendSmsCode}
                  disabled={sendingCode || countdown > 0 || loading}
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
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
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
