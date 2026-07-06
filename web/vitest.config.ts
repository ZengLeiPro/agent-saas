import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const hoistedReact = fileURLToPath(new URL("../node_modules/react", import.meta.url));
const hoistedReactJsxRuntime = fileURLToPath(new URL("../node_modules/react/jsx-runtime.js", import.meta.url));
const hoistedReactJsxDevRuntime = fileURLToPath(new URL("../node_modules/react/jsx-dev-runtime.js", import.meta.url));
const hoistedReactDom = fileURLToPath(new URL("../node_modules/react-dom", import.meta.url));
const hoistedReactDomClient = fileURLToPath(new URL("../node_modules/react-dom/client.js", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@agent/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "virtual:pwa-register": fileURLToPath(new URL("./src/test/pwaRegisterMock.ts", import.meta.url)),
      "react/jsx-dev-runtime": hoistedReactJsxDevRuntime,
      "react/jsx-runtime": hoistedReactJsxRuntime,
      "react-dom/client": hoistedReactDomClient,
      "react-dom": hoistedReactDom,
      react: hoistedReact,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
