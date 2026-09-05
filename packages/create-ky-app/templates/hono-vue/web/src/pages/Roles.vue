<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { app } from '../ky.js';

interface RolesPayload {
  assignableRoles: string[];
  users: Array<{ sub: string; roles: string[] }>;
}

const data = ref<RolesPayload | null>(null);
const message = ref<string | null>(null);

async function load(): Promise<void> {
  const response = await app.fetch('/api/admin/roles');
  if (response.status === 403) {
    message.value = '只有组织管理员可以管理角色权限。';
    return;
  }
  if (!response.ok) {
    message.value = '暂时打不开角色权限，请稍后再试。';
    return;
  }
  data.value = (await response.json()) as RolesPayload;
}

async function toggle(sub: string, role: string, checked: boolean): Promise<void> {
  const current = data.value?.users.find((user) => user.sub === sub)?.roles ?? [];
  const roles = checked ? [...new Set([...current, role])] : current.filter((item) => item !== role);
  const response = await app.fetch('/api/admin/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub, roles }),
  });
  if (response.ok) await load();
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section>
    <h2>角色权限</h2>
    <p v-if="message" class="message">{{ message }}</p>
    <table v-else-if="data">
      <thead>
        <tr>
          <th>成员</th>
          <th v-for="role in data.assignableRoles" :key="role">{{ role }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in data.users" :key="user.sub">
          <td>{{ user.sub }}</td>
          <td v-for="role in data.assignableRoles" :key="role">
            <input
              type="checkbox"
              :checked="user.roles.includes(role)"
              @change="toggle(user.sub, role, ($event.target as HTMLInputElement).checked)"
            />
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
table { border-collapse: collapse; }
th, td { border-bottom: 1px solid #d0d7de; padding: 6px 12px; text-align: left; }
.message { color: #57606a; }
</style>
