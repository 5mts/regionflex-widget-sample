import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  optimizeDeps: {
    esbuildOptions: { target: "esnext" },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        "address-lookup": resolve(__dirname, "index.html"),
        "region-map": resolve(__dirname, "region-map.html"),
      },
    },
  },
});
