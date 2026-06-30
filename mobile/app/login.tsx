import React, { useState, useMemo } from "react";
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
import { useAuth } from "../src/contexts/AuthContext";
import { useColors, spacing, typography } from "../src/theme";

export default function LoginScreen() {
  const colors = useColors();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setError("请输入用户名和密码");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const result = await login(username.trim(), password);
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
              <Text style={styles.buttonText}>登录</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
