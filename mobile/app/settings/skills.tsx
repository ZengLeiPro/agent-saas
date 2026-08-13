import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
  Alert,
  ActivityIndicator,
  Modal,
  TextInput,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Pencil, Puzzle, Trash2, Upload } from 'lucide-react-native';
import * as DocumentPicker from 'expo-document-picker';
import { deleteMySkill, fetchMySkillDocument, importMySkillFormData, updateMySkillDocument } from '@agent/shared';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, spacing, typography, radius } from '../../src/theme';
import { useSkills } from '../../src/hooks/useSkills';

export default function SkillsScreen() {
  const { username } = useLocalSearchParams<{ username?: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [workingSkillId, setWorkingSkillId] = useState<string | null>(null);
  const [editSkillId, setEditSkillId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const {
    poolSkills,
    tenantSkills,
    customSkills,
    loading,
    saving,
    selections,
    dirty,
    toggleSkill,
    save,
    refresh,
  } = useSkills(username);

  const canManagePersonal = !username;

  const handleImport = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['text/markdown', 'application/zip'], copyToCacheDirectory: true });
      if (result.canceled) return;
      const asset = result.assets[0];
      const formData = new FormData();
      formData.append('files', { uri: asset.uri, name: asset.name, type: asset.mimeType || 'application/octet-stream' } as any);
      setWorkingSkillId('__import__');
      await importMySkillFormData(formData);
      await refresh();
      Alert.alert('导入成功', '自建技能已导入并默认启用');
    } catch (err) {
      Alert.alert('导入失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setWorkingSkillId(null);
    }
  };

  const handleEdit = async (skillId: string) => {
    try {
      setWorkingSkillId(skillId);
      const doc = await fetchMySkillDocument(skillId);
      setEditContent(doc.content);
      setEditSkillId(skillId);
    } catch (err) {
      Alert.alert('读取失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setWorkingSkillId(null);
    }
  };

  const handleEditSave = async () => {
    if (!editSkillId) return;
    try {
      setWorkingSkillId(editSkillId);
      await updateMySkillDocument(editSkillId, editContent);
      setEditSkillId(null);
      await refresh();
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setWorkingSkillId(null);
    }
  };

  const handleDelete = (skillId: string, name: string) => {
    Alert.alert('确认删除', `确定删除自建技能“${name}”吗？此操作不可撤销。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive', onPress: async () => {
          try {
            setWorkingSkillId(skillId);
            await deleteMySkill(skillId);
            await refresh();
          } catch (err) {
            Alert.alert('删除失败', err instanceof Error ? err.message : '未知错误');
          } finally {
            setWorkingSkillId(null);
          }
        },
      },
    ]);
  };

  const handleSave = async () => {
    try {
      await save();
      Alert.alert('已保存', '技能配置已更新，新会话生效');
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : '未知错误');
    }
  };

  const title = username ? `${username} 的技能` : '技能';

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scrollContent: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg + insets.bottom,
    },
    loadingCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 },
    section: { marginBottom: spacing.xl },
    sectionTitle: {
      ...typography.caption, color: colors.mutedForeground,
      textTransform: 'uppercase', marginBottom: spacing.sm, marginLeft: spacing.xs,
    },
    card: { backgroundColor: colors.card, borderRadius: radius.lg, overflow: 'hidden' },
    row: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    },
    rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    rowLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
    rowIcon: { width: 28, alignItems: 'center' },
    rowText: { flex: 1 },
    rowName: { ...typography.body, color: colors.foreground, fontWeight: '500' },
    rowDesc: { ...typography.caption, color: colors.mutedForeground, marginTop: 2 },
    badge: {
      backgroundColor: colors.secondary, borderRadius: radius.sm,
      paddingHorizontal: spacing.sm, paddingVertical: 2, marginLeft: spacing.sm,
    },
    badgeText: { ...typography.caption, color: colors.mutedForeground, fontSize: 10 },
    saveBtn: {
      backgroundColor: dirty ? colors.primary : colors.muted,
      borderRadius: radius.lg, paddingVertical: 14, alignItems: 'center',
      flexDirection: 'row', justifyContent: 'center', gap: spacing.sm,
    },
    saveBtnText: {
      ...typography.body,
      color: dirty ? colors.primaryForeground : colors.mutedForeground,
      fontWeight: '600',
    },
    emptyText: {
      ...typography.body, color: colors.mutedForeground,
      textAlign: 'center', paddingVertical: spacing.xl,
    },
    actionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    iconButton: { padding: spacing.xs },
    importButton: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
      borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
      paddingVertical: spacing.md, marginBottom: spacing.lg,
    },
    importButtonText: { ...typography.body, color: colors.foreground, fontWeight: '600' },
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: spacing.lg },
    modalCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, maxHeight: '85%' },
    modalTitle: { ...typography.title, color: colors.foreground, marginBottom: spacing.xs },
    modalHint: { ...typography.caption, color: colors.mutedForeground, marginBottom: spacing.md },
    editor: { minHeight: 360, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, color: colors.foreground, textAlignVertical: 'top', fontFamily: 'monospace' },
    modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
    modalButton: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.muted },
    modalPrimary: { backgroundColor: colors.primary },
    modalButtonText: { ...typography.body, color: colors.foreground },
    modalPrimaryText: { ...typography.body, color: colors.primaryForeground, fontWeight: '600' },
  }), [colors, insets.top, insets.bottom, dirty]);

  return (
    <>
      <Stack.Screen options={{ title }} />
      <View style={styles.container}>
        {loading ? (
          <View style={styles.loadingCenter}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            {canManagePersonal && (
              <TouchableOpacity style={styles.importButton} onPress={() => { void handleImport(); }} disabled={workingSkillId === '__import__'}>
                {workingSkillId === '__import__' ? <ActivityIndicator size="small" color={colors.primary} /> : <Upload size={18} color={colors.primary} />}
                <Text style={styles.importButtonText}>导入个人技能（Markdown / ZIP）</Text>
              </TouchableOpacity>
            )}
            {poolSkills.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>系统技能</Text>
                <View style={styles.card}>
                  {poolSkills.map((skill, idx) => (
                    <View
                      key={skill.id}
                      style={[styles.row, idx < poolSkills.length - 1 && styles.rowBorder]}
                    >
                      <View style={styles.rowLeft}>
                        <View style={styles.rowIcon}>
                          <Puzzle size={18} color={colors.primary} strokeWidth={2} />
                        </View>
                        <View style={styles.rowText}>
                          <Text style={styles.rowName}>{skill.name}</Text>
                          {skill.description ? (
                            <Text style={styles.rowDesc} numberOfLines={2}>{skill.description}</Text>
                          ) : null}
                        </View>
                      </View>
                      <Switch
                        value={selections.has(skill.id)}
                        onValueChange={() => toggleSkill(skill.id)}
                        disabled={saving}
                        trackColor={{ false: colors.muted, true: colors.success }}
                        thumbColor={colors.card}
                        ios_backgroundColor={colors.muted}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}

            {tenantSkills.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>组织技能</Text>
                <View style={styles.card}>
                  {tenantSkills.map((skill, idx) => (
                    <View key={`tenant-${skill.id}`} style={[styles.row, idx < tenantSkills.length - 1 && styles.rowBorder]}>
                      <View style={styles.rowLeft}>
                        <View style={styles.rowIcon}><Puzzle size={18} color={colors.primary} strokeWidth={2} /></View>
                        <View style={styles.rowText}>
                          <Text style={styles.rowName}>{skill.name || skill.id}</Text>
                          {skill.description ? <Text style={styles.rowDesc} numberOfLines={2}>{skill.description}</Text> : null}
                        </View>
                      </View>
                      <Switch
                        value={selections.has(skill.id)}
                        onValueChange={() => toggleSkill(skill.id)}
                        disabled={saving}
                        trackColor={{ false: colors.muted, true: colors.success }}
                        thumbColor={colors.card}
                        ios_backgroundColor={colors.muted}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}

            {customSkills.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>自建技能</Text>
                <View style={styles.card}>
                  {customSkills.map((skill, idx) => (
                    <View
                      key={skill.id}
                      style={[styles.row, idx < customSkills.length - 1 && styles.rowBorder]}
                    >
                      <View style={styles.rowLeft}>
                        <View style={styles.rowIcon}>
                          <Puzzle size={18} color={colors.primary} strokeWidth={2} />
                        </View>
                        <View style={styles.rowText}>
                          <Text style={styles.rowName}>{skill.name}</Text>
                          {skill.description ? (
                            <Text style={styles.rowDesc} numberOfLines={2}>{skill.description}</Text>
                          ) : null}
                        </View>
                      </View>
                      <View style={styles.actionRow}>
                        {canManagePersonal && (
                          <TouchableOpacity style={styles.iconButton} onPress={() => { void handleEdit(skill.id); }} disabled={workingSkillId === skill.id}>
                            <Pencil size={17} color={colors.primary} />
                          </TouchableOpacity>
                        )}
                        {canManagePersonal && (
                          <TouchableOpacity style={styles.iconButton} onPress={() => handleDelete(skill.id, skill.name)} disabled={workingSkillId === skill.id}>
                            <Trash2 size={17} color={colors.destructive} />
                          </TouchableOpacity>
                        )}
                        <Switch
                          value={selections.has(skill.id)}
                          onValueChange={() => toggleSkill(skill.id)}
                          disabled={saving}
                          trackColor={{ false: colors.muted, true: colors.success }}
                          thumbColor={colors.card}
                          ios_backgroundColor={colors.muted}
                        />
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {poolSkills.length === 0 && tenantSkills.length === 0 && customSkills.length === 0 && (
              <Text style={styles.emptyText}>暂无可用技能</Text>
            )}

            {(poolSkills.length > 0 || tenantSkills.length > 0 || customSkills.length > 0) && (
              <View style={styles.section}>
                <TouchableOpacity
                  style={styles.saveBtn}
                  onPress={handleSave}
                  disabled={saving || !dirty}
                  activeOpacity={0.7}
                >
                  {saving && <ActivityIndicator size="small" color={colors.primaryForeground} />}
                  <Text style={styles.saveBtnText}>保存</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        )}
      </View>
      <Modal visible={!!editSkillId} transparent animationType="slide" onRequestClose={() => setEditSkillId(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>编辑 SKILL.md</Text>
            <Text style={styles.modalHint}>name 必须继续与技能 ID 保持一致。</Text>
            <TextInput
              style={styles.editor}
              multiline
              value={editContent}
              onChangeText={setEditContent}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalButton} onPress={() => setEditSkillId(null)}>
                <Text style={styles.modalButtonText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalButton, styles.modalPrimary]} onPress={() => { void handleEditSave(); }}>
                <Text style={styles.modalPrimaryText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
