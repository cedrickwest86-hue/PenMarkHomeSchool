import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { BRAND } from "./src/brand.js";

// BASE_PATH is set by the GitHub workflow (e.g. "/HomeSchool/").
export default defineConfig({
  plugins: [
    react(),
    { name: "brand-name", transformIndexHtml: (html) => html.replaceAll("%BRAND_NAME%", BRAND.name) },
  ],
  base: process.env.BASE_PATH || "/",
  build: { chunkSizeWarningLimit: 2000 },
});
