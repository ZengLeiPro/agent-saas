/** 本地验收已登录身份；正式登录流程由独立鉴权用例覆盖。 */
export function useAuth() {
  return {
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'u_member', tenantId: 't_demo' },
    logout: async () => {},
  };
}
