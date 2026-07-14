/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** API/WS 基址（分域部署时注入，如 https://api.agent.kaiyan.net）；留空=同源 */
  readonly VITE_API_BASE?: string;
}
