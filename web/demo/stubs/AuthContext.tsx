/** 演示态登录态桩：只提供壳用到的 `user.tenantId` 与 `logout`。 */
export function useAuth() {
  return {
    user: { id: 'u_demo', tenantId: 't_demo', username: 'zhangsan' },
    logout: async () => {
      window.alert('演示态：这里会执行壳登出并卸载 iframe');
    },
  };
}
