import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/address-lookup.js",
      formats: ["es"],
      fileName: "address-lookup",
    },
  },
});
