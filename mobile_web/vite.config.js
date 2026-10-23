import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/pocket/",
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2020",
  },
});
