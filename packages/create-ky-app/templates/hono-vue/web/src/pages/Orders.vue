<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { app, askAgent } from '../ky.js';

interface OrderRow {
  orderId: string;
  customer: string;
  amount: number;
  status: string;
}

const keyword = ref('C-DEMO');
const rows = ref<OrderRow[]>([]);
const message = ref<string | null>(null);
const loading = ref(false);

/** 页面接口与能力共用同一个 service，这里只管展示（§9.2）。 */
async function load(): Promise<void> {
  loading.value = true;
  message.value = null;
  try {
    const response = await app.fetch(`/api/app/orders?keyword=${encodeURIComponent(keyword.value)}`);
    if (response.status === 403) {
      message.value = '你没有查看订单的权限，请联系组织管理员。';
      rows.value = [];
      return;
    }
    if (!response.ok) {
      message.value = '暂时取不到订单，请稍后再试。';
      return;
    }
    rows.value = ((await response.json()) as { items: OrderRow[] }).items;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section>
    <h2>订单</h2>
    <form @submit.prevent="load()">
      <input v-model="keyword" aria-label="客户名或订单号" placeholder="客户名或订单号" />
      <button type="submit" :disabled="loading">查询</button>
    </form>
    <p v-if="message" class="message">{{ message }}</p>
    <table v-else>
      <thead>
        <tr><th>订单号</th><th>客户</th><th>金额</th><th>状态</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.orderId">
          <td>{{ row.orderId }}</td>
          <td>{{ row.customer }}</td>
          <td>{{ row.amount }}</td>
          <td>{{ row.status }}</td>
          <td>
            <button
              type="button"
              @click="askAgent('帮我看看这张订单', { type: 'order', id: row.orderId, label: row.orderId })"
            >
              问 Agent
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid #d0d7de; padding: 6px 8px; text-align: left; }
.message { color: #57606a; }
form { display: flex; gap: 8px; margin-bottom: 12px; }
</style>
