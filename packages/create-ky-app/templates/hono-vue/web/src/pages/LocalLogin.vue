<script setup lang="ts">
import { ref } from 'vue';

/**
 * 兜底登录页（§3.5）。KY Agent 暂时不可用时，组织管理员用具名恢复因子启用兜底模式，
 * 员工再用一次性码登录。这个页面独立打开，不依赖壳。
 */
const sub = ref('');
const password = ref('');
const code = ref('');
const loginId = ref('');
const employeeCode = ref('');
const message = ref<string | null>(null);

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function enable(): Promise<void> {
  const response = await post('/ky-local/enable', {
    sub: sub.value,
    password: password.value,
    code: code.value,
  });
  message.value = response.ok
    ? '已进入兜底模式，有效期 4 小时。请尽快恢复正常访问并复盘。'
    : '恢复因子不正确，或尝试过于频繁，请稍后再试。';
}

async function login(): Promise<void> {
  const response = await post('/ky-local/login', {
    loginId: loginId.value,
    code: employeeCode.value,
  });
  message.value = response.ok ? '登录成功，可以继续使用系统。' : '一次性码无效或已过期。';
}
</script>

<template>
  <section>
    <h2>兜底登录</h2>
    <p class="hint">仅在 KY Agent 暂时不可用时使用；全过程会留下本地操作记录。</p>

    <fieldset>
      <legend>组织管理员启用</legend>
      <input v-model="sub" placeholder="管理员账号" aria-label="管理员账号" />
      <input v-model="password" type="password" placeholder="本地恢复密码" aria-label="本地恢复密码" />
      <input v-model="code" placeholder="一次性恢复码" aria-label="一次性恢复码" />
      <button type="button" @click="enable()">启用兜底模式</button>
    </fieldset>

    <fieldset>
      <legend>员工登录</legend>
      <input v-model="loginId" placeholder="工号或姓名" aria-label="工号或姓名" />
      <input v-model="employeeCode" placeholder="一次性码" aria-label="一次性码" />
      <button type="button" @click="login()">登录</button>
    </fieldset>

    <p v-if="message" class="message">{{ message }}</p>
  </section>
</template>

<style scoped>
fieldset { margin-bottom: 16px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.hint, .message { color: #57606a; }
</style>
