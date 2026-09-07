/** 仅注入测试身份；全部响应来自真实 Express / PG，禁止在此伪造业务响应。 */
export function authFetch(path: string, init: RequestInit = {}) {
  return fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      'x-test-identity': sessionStorage.getItem('p0-test-identity') ?? 'platform',
    },
  });
}
export function setOnUnauthorized() {}
