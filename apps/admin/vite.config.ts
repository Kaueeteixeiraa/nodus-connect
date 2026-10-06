import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
export default defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)), base: "/", envDir: fileURLToPath(new URL("../..", import.meta.url)), plugins: [react()], server: { host: "127.0.0.1", port: 5190, strictPort: true }, build: { outDir: "../../dist/admin", emptyOutDir: true } });
