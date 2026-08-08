import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Modal,
  TextInput,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { Pencil, Trash2, Upload } from 'lucide-react-native';
import {
  deleteTenantOwnSkill,
  fetchTenantOwnSkillDocument,
  fetchTenantOwnSkills,
  fetchTenantSkillPool,
  importTenantSkillFormData,
  updateTenantOwnSkillDocument,
  updateTenantOwnSkillSettings,
  updateTenantSkillSelections,
  type TenantOwnSkillInfo,
  type TenantSkillInfo,
} from '@agent/shared';
import { useAuth } from '../../src/contexts/AuthContext';
import { useUsers } from '../../src/hooks/useUsers';
import { useColors, radius, spacing, typography } from '../../src/theme';

export default function TenantSkillsAdminScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const { users } = useUsers();
  const tenantId = user?.tenantId || '';
  const tenantMembers = users.filter(member => member.tenantId === tenantId && member.username !== user?.username);
  const [poolSkills, setPoolSkills] = useState<TenantSkillInfo[]>([]);
  const [ownSkills, setOwnSkills] = useState<TenantOwnSkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [editSkill, setEditSkill] = useState<TenantOwnSkillInfo | null>(null);
  const [editContent, setEditContent] = useState('');

  const canManageTenantSkills = user?.role === 'admin'
    && user.tenantId !== 'pantheon';
  useEffect(() => {
    if (user && !canManageTenantSkills) router.replace('/(tabs)/settings');
  }, [canManageTenantSkills, router, user]);

  const refresh = useCallback(async () => {
    if (!tenantId) return;
    const [pool, own] = await Promise.all([fetchTenantSkillPool(tenantId), fetchTenantOwnSkills(tenantId)]);
    setPoolSkills(pool.skills);
    setOwnSkills(own.skills);
  }, [tenantId]);

  useEffect(() => {
    void refresh().catch(err => Alert.alert('加载失败', err instanceof Error ? err.message : '未知错误')).finally(() => setLoading(false));
  }, [refresh]);

  const togglePool = async (skillId: string, enabled: boolean) => {
    const next = new Set(poolSkills.filter(skill => skill.enabled).map(skill => skill.id));
    if (enabled) next.add(skillId); else next.delete(skillId);
    setWorking(skillId);
    try {
      await updateTenantSkillSelections(tenantId, [...next]);
      await refresh();
    } catch (err) {
      Alert.alert('更新失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setWorking(null);
    }
  };

  const toggleOwn = async (skill: TenantOwnSkillInfo, enabled: boolean) => {
    setWorking(skill.id);
    try {
      await updateTenantOwnSkillSettings(tenantId, {
        [skill.id]: { enabled, exposure: skill.exposure, usernames: skill.usernames },
      });
      await refresh();
    } catch (err) {
      Alert.alert('更新失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setWorking(null);
    }
  };

  const importSkill = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['text/markdown', 'application/zip'], copyToCacheDirectory: true });
      if (result.canceled) return;
      const asset = result.assets[0];
      const formData = new FormData();
      formData.append('files', { uri: asset.uri, name: asset.name, type: asset.mimeType || 'application/octet-stream' } as any);
      setWorking('__import__');
      await importTenantSkillFormData(tenantId, formData);
      await refresh();
    } catch (err) {
      Alert.alert('导入失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setWorking(null);
    }
  };

  const openSkillEditor = async (skill: TenantOwnSkillInfo) => {
    try {
      setWorking(skill.id);
      const doc = await fetchTenantOwnSkillDocument(tenantId, skill.id);
      setEditContent(doc.content);
      setEditSkill(skill);
    } catch (err) {
      Alert.alert('读取失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setWorking(null);
    }
  };

  const saveEdit = async () => {
    if (!editSkill) return;
    try {
      setWorking(editSkill.id);
      await updateTenantOwnSkillDocument(tenantId, editSkill.id, editContent);
      setEditSkill(null);
      await refresh();
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setWorking(null);
    }
  };

  const removeSkill = (skill: TenantOwnSkillInfo) => {
    Alert.alert('确认删除', `确定删除组织技能“${skill.name}”吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => {
        try {
          setWorking(skill.id);
          await deleteTenantOwnSkill(tenantId, skill.id);
          await refresh();
        } catch (err) {
          Alert.alert('删除失败', err instanceof Error ? err.message : '未知错误');
        } finally {
          setWorking(null);
        }
      } },
    ]);
  };

  const styles = useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.lg, paddingBottom: spacing['2xl'] },
    section: { marginBottom: spacing.xl },
    sectionTitle: { ...typography.caption, color: colors.mutedForeground, marginBottom: spacing.sm },
    card: { backgroundColor: colors.card, borderRadius: radius.lg, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    border: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    info: { flex: 1, marginRight: spacing.md },
    name: { ...typography.body, color: colors.foreground, fontWeight: '500' },
    desc: { ...typography.caption, color: colors.mutedForeground, marginTop: 2 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    icon: { padding: spacing.xs },
    importButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingVertical: spacing.md, marginBottom: spacing.lg },
    importText: { ...typography.body, color: colors.foreground, fontWeight: '600' },
    loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  }), [colors]);

  if (!user || !canManageTenantSkills) return null;
  return (
    <>
      <Stack.Screen options={{ title: '组织技能管理' }} />
      <View style={styles.container}>
        {loading ? <View style={styles.loading}><ActivityIndicator size="large" color={colors.primary} /></View> : (
          <ScrollView
            contentContainerStyle={styles.content}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)); }} />}
          >
            <TouchableOpacity style={styles.importButton} onPress={() => { void importSkill(); }} disabled={working === '__import__'}>
              {working === '__import__' ? <ActivityIndicator size="small" color={colors.primary} /> : <Upload size={18} color={colors.primary} />}
              <Text style={styles.importText}>导入组织技能</Text>
            </TouchableOpacity>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>平台技能启用</Text>
              <View style={styles.card}>
                {poolSkills.map((skill, index) => (
                  <View key={skill.id} style={[styles.row, index < poolSkills.length - 1 && styles.border]}>
                    <View style={styles.info}><Text style={styles.name}>{skill.name}</Text>{skill.description ? <Text style={styles.desc}>{skill.description}</Text> : null}</View>
                    <Switch value={skill.enabled} onValueChange={value => { void togglePool(skill.id, value); }} disabled={working === skill.id} />
                  </View>
                ))}
              </View>
            </View>

            {tenantMembers.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>成员技能</Text>
                <View style={styles.card}>
                  {tenantMembers.map((member, index) => (
                    <TouchableOpacity
                      key={member.username}
                      style={[styles.row, index < tenantMembers.length - 1 && styles.border]}
                      onPress={() => router.push(`/settings/skills?username=${encodeURIComponent(member.username)}`)}
                    >
                      <View style={styles.info}>
                        <Text style={styles.name}>{member.realName || member.username}</Text>
                        <Text style={styles.desc}>{member.username}</Text>
                      </View>
                      <Text style={styles.desc}>管理选择与个人技能</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>组织自有技能</Text>
              <View style={styles.card}>
                {ownSkills.map((skill, index) => (
                  <View key={skill.id} style={[styles.row, index < ownSkills.length - 1 && styles.border]}>
                    <View style={styles.info}><Text style={styles.name}>{skill.name}</Text>{skill.description ? <Text style={styles.desc}>{skill.description}</Text> : null}</View>
                    <View style={styles.actions}>
                      <TouchableOpacity style={styles.icon} onPress={() => { void openSkillEditor(skill); }}><Pencil size={17} color={colors.primary} /></TouchableOpacity>
                      <TouchableOpacity style={styles.icon} onPress={() => removeSkill(skill)}><Trash2 size={17} color={colors.destructive} /></TouchableOpacity>
                      <Switch value={skill.enabled} onValueChange={value => { void toggleOwn(skill, value); }} disabled={working === skill.id} />
                    </View>
                  </View>
                ))}
              </View>
            </View>
          </ScrollView>
        )}
      </View>
      <Modal visible={!!editSkill} transparent animationType="slide" onRequestClose={() => setEditSkill(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>编辑组织 SKILL.md</Text>
            <Text style={styles.modalHint}>name 必须继续与技能 ID 保持一致。</Text>
            <TextInput style={styles.editor} multiline value={editContent} onChangeText={setEditContent} autoCapitalize="none" autoCorrect={false} />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalButton} onPress={() => setEditSkill(null)}><Text style={styles.modalButtonText}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalButton, styles.modalPrimary]} onPress={() => { void saveEdit(); }}><Text style={styles.modalPrimaryText}>保存</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
