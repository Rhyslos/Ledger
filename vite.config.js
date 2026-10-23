import { defineConfig } from "vite";

// Tauri expects a fixed dev port and wants Vite to leave the terminal alone.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"], // never TAURI_SIGNING_* or other secrets
  build: { target: "es2021", sourcemap: false, chunkSizeWarningLimit: 2000 },
});
