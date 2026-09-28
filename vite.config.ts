import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "client",
  publicDir: false,
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (
            id.includes("/node_modules/@mui/") ||
            id.includes("/node_modules/@emotion/")
          )
            return "material-ui";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api/": { target: "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
});
