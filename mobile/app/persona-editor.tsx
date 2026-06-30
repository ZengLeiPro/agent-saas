import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Markdown from 'react-native-markdown-display';
import { useColors, spacing, typography } from '../src/theme';
import { createMarkdownStyles } from '../src/components/chat/markdownStyles';
import { createMarkdownRules } from '../src/components/chat/markdownRules';
import {
  fetchPersona, updatePersona, parsePersona,
  fetchAgentMemory, updateAgentMemory,
  reportActivity,
} from '@agent/shared';

type EditorMode = 'persona' | 'memory';

interface ModeConfig {
  viewTitle: string;
  editTitle: string;
  hint: string;
  placeholder: string;
  emptyText: string;
  saveAlert: { title: string; message: string };
  load: (username: string) => Promise<{ body: string; hint: string }>;
  save: (username: string, body: string, hint: string) => Promise<void>;
}

const MODE_CONFIGS: Record<EditorMode, ModeConfig> = {
  persona: {
    viewTitle: '人格定义',
    editTitle: '编辑人格',
    hint: '在这里定义你的专属 Agent 的人格和行为风格',
    placeholder: '定义你的 Agent 的性格、说话风格和专业知识...',
    emptyText: '尚未定义人格',
    saveAlert: { title: '已保存', message: '人格定义已更新，新会话生效' },
    load: async (username) => {
      const data = await fetchPersona(username);
      const parsed = parsePersona(data || '');
      return { body: parsed.body, hint: '' };
    },
    save: async (username, body) => {
      await updatePersona(username, body);
    },
  },
  memory: {
    viewTitle: 'Agent 记忆',
    editTitle: '编辑记忆',
    hint: '此记忆由 Agent 自行维护更新，请谨慎编辑。',
    placeholder: '记忆内容...',
    emptyText: '暂无记忆',
    saveAlert: { title: '已保存', message: 'Agent 记忆已更新，新会话生效' },
    load: async (username) => {
      const content = await fetchAgentMemory(username);
      return { body: content, hint: '' };
    },
    save: async (username, body) => {
      await updateAgentMemory(username, body);
    },
  },
};

export default function PersonaEditorScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { username, mode: modeParam } = useLocalSearchParams<{ username: string; mode?: string }>();
  const mode: EditorMode = modeParam === 'memory' ? 'memory' : 'persona';
  const config = MODE_CONFIGS[mode];

  useEffect(() => {
    reportActivity(mode === 'memory' ? 'agent_memory_viewed' : 'agent_persona_viewed', { detail: username });
  }, [mode, username]);

  const [body, setBody] = useState('');
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [currentMode, setCurrentMode] = useState<'view' | 'edit'>('view');
  const initialBody = useRef('');

  const isDirty = body !== initialBody.current;
  const isViewMode = currentMode === 'view';

  // Use config.hint as default, but load() can override (persona mode)
  const displayHint = hint || config.hint;

  useEffect(() => {
    if (!username) return;
    (async () => {
      setLoading(true);
      try {
        const result = await config.load(username);
        setBody(result.body);
        setHint(result.hint);
        initialBody.current = result.body;
      } catch {
        setBody('');
        setHint('');
        initialBody.current = '';
      } finally {
        setLoading(false);
      }
    })();
  }, [username, config]);

  const handleSave = useCallback(async () => {
    if (!username) return;
    setSaving(true);
    try {
      await config.save(username, body, hint);
      initialBody.current = body;
      setCurrentMode('view');
      Alert.alert(config.saveAlert.title, config.saveAlert.message);
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setSaving(false);
    }
  }, [username, body, hint, config]);

  const handleCloseEdit = useCallback(() => {
    const exitEdit = () => {
      setBody(initialBody.current);
      setCurrentMode('view');
    };
    if (isDirty) {
      Alert.alert('放弃修改？', '你有未保存的修改，确定要放弃吗？', [
        { text: '继续编辑', style: 'cancel' },
        { text: '放弃', style: 'destructive', onPress: exitEdit },
      ]);
    } else {
      exitEdit();
    }
  }, [isDirty]);

  const title = isViewMode ? config.viewTitle : config.editTitle;

  const headerLeft = isViewMode
    ? undefined
    : () => (
        <TouchableOpacity onPress={handleCloseEdit} activeOpacity={0.7}>
          <Ionicons name="close" size={24} color={colors.foreground} />
        </TouchableOpacity>
      );

  const headerRight = isViewMode
    ? () => (
        <TouchableOpacity onPress={() => setCurrentMode('edit')} activeOpacity={0.7}>
          <Text style={{ fontSize: 17, color: colors.foreground }}>编辑</Text>
        </TouchableOpacity>
      )
    : () => (
        <TouchableOpacity onPress={handleSave} disabled={saving} activeOpacity={0.7}>
          {saving ? (
            <ActivityIndicator size="small" color={colors.foreground} />
          ) : (
            <Feather name="check" size={24} color={colors.foreground} />
          )}
        </TouchableOpacity>
      );

  const mdStyles = useMemo(() => createMarkdownStyles(colors), [colors]);
  const mdRules = useMemo(() => createMarkdownRules({ colors, selectable: true }), [colors]);

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.card },
    content: {
      flex: 1,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
    },
    hintText: {
      ...typography.caption,
      color: colors.mutedForeground,
      lineHeight: 18,
      marginBottom: spacing.lg,
    },
    textArea: {
      ...typography.body,
      color: colors.foreground,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 13,
      lineHeight: 20,
      flex: 1,
      textAlignVertical: 'top',
      padding: 0,
    },
    placeholder: {
      ...typography.body,
      color: colors.mutedForeground,
      fontStyle: 'italic',
    },
    loadingCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  }), [colors]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title, headerLeft, headerRight }} />
      {loading ? (
        <View style={styles.loadingCenter}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <View style={styles.content}>
            {displayHint ? <Text style={styles.hintText}>{displayHint}</Text> : null}
            {isViewMode ? (
              <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
              >
                {body ? (
                  <Markdown style={mdStyles} rules={mdRules}>{body}</Markdown>
                ) : (
                  <Text style={styles.placeholder}>{config.emptyText}</Text>
                )}
              </ScrollView>
            ) : (
              <TextInput
                style={[styles.textArea, { paddingBottom: insets.bottom + spacing.xl }]}
                value={body}
                onChangeText={setBody}
                placeholder={config.placeholder}
                placeholderTextColor={colors.mutedForeground}
                multiline
                maxLength={10000}
                autoFocus
              />
            )}
          </View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
