<script setup lang="ts">
import { computed } from 'vue';

import { currentPath, menus } from './router.js';
import { app, askAgent, me, meState, notice, phase, refreshMe, theme } from './ky.js';
import OrdersPage from './pages/Orders.vue';
import RolesPage from './pages/Roles.vue';
import LocalLoginPage from './pages/LocalLogin.vue';
import { navigate } from './ky.js';

const flatMenus = computed(() =>
  menus.value.flatMap((item) => (item.children === undefined ? [item] : item.children)),
);

const page = computed(() => {
  if (currentPath.value.startsWith('/settings/roles')) return RolesPage;
  if (currentPath.value === '/local-login') return LocalLoginPage;
  return OrdersPage;
});

function openDocs(): void {
  void app.openLink('https://docs.kaiyan.net/ky-app');
}
</script>

<template>
  <div class="layout" :data-theme="theme">
    <aside>
      <h1>__SYSTEM_NAME__</h1>
      <div v-if="meState === 'loading'" class="menu-skeleton" aria-label="正在加载菜单">
        <span v-for="index in 3" :key="index" />
      </div>
      <nav v-else>
        <button
          v-for="item in flatMenus"
          :key="item.key"
          type="button"
          :class="{ active: currentPath === item.path }"
          @click="navigate(item.path)"
        >
          {{ item.label }}
        </button>
      </nav>
      <div v-if="meState === 'error'" class="empty">
        <p>系统信息暂时没有加载出来。</p>
        <button type="button" @click="refreshMe()">重试</button>
      </div>
      <p v-else-if="meState === 'ready' && flatMenus.length === 0" class="empty">
        你在《__SYSTEM_NAME__》中还没有被分配角色，请联系组织管理员。
      </p>
      <div class="tools">
        <button type="button" @click="askAgent('帮我看看最近的订单情况')">问 Agent</button>
        <button type="button" @click="openDocs()">使用说明</button>
      </div>
      <p class="who" v-if="me">
        {{ me.user.displayName }}<span v-if="me.user.isTenantAdmin">（管理员）</span>
      </p>
      <p class="phase">状态：{{ phase }}</p>
    </aside>
    <main>
      <p v-if="notice" class="notice">{{ notice }}</p>
      <component :is="page" />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
  font-family: system-ui, sans-serif;
  color: #1f2328;
}
aside {
  width: 200px;
  padding: 16px;
  background: #f6f8fa;
  border-right: 1px solid #d0d7de;
}
h1 {
  font-size: 16px;
  margin: 0 0 12px;
}
nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
nav button,
.tools button {
  text-align: left;
  padding: 6px 8px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  border-radius: 6px;
}
nav button.active {
  background: #dbeafe;
  border-color: #93c5fd;
}
.tools {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.empty,
.who,
.phase {
  font-size: 12px;
  color: #57606a;
}
main {
  flex: 1;
  padding: 20px;
}
.notice {
  padding: 8px 12px;
  border: 1px solid #d4a72c;
  background: #fff8c5;
  border-radius: 6px;
}
.menu-skeleton {
  display: grid;
  gap: 8px;
}
.menu-skeleton span {
  display: block;
  height: 30px;
  border-radius: 6px;
  background: #e5e7eb;
  animation: pulse 1.2s ease-in-out infinite alternate;
}
@keyframes pulse {
  to {
    opacity: 0.45;
  }
}
</style>
