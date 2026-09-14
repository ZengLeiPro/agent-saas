<script setup lang="ts">
import { onMounted, ref } from 'vue';

const allowed = ref(false);
const runtime = ref('unbound');
const message = ref('');

async function load(): Promise<void> {
  const response = await fetch('/api/admin/integration');
  if (!response.ok) {
    message.value = '暂时无法读取接入状态。';
    return;
  }
  const body = (await response.json()) as { allowed: boolean; runtime: string };
  allowed.value = body.allowed;
  runtime.value = body.runtime;
}

async function toggle(): Promise<void> {
  const response = await fetch('/api/admin/integration', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowed: !allowed.value }),
  });
  if (!response.ok) {
    message.value = '状态未改变，请稍后重试。';
    return;
  }
  allowed.value = !allowed.value;
  message.value = allowed.value
    ? '已允许组织发起接入，业务功能不受影响。'
    : '已停止接受新的组织接入。';
}

onMounted(() => void load());
</script>

<template>
  <section>
    <h2>组织接入</h2>
    <p>业务系统可以独立使用；打开此开关后，平台管理员才能发起组织授权。</p>
    <p>
      当前状态：{{ allowed ? (runtime === 'connected' ? '已接入' : '等待授权') : '未开放接入' }}
    </p>
    <button type="button" @click="toggle()">{{ allowed ? '停止接受接入' : '允许组织接入' }}</button>
    <p v-if="message">{{ message }}</p>
  </section>
</template>
