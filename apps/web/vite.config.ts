import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // the SPA talks to the Hono API; same origin in production
    proxy: {
      "/api": "http://localhost:3000",
      // A module's screens are built files the host serves, not part of this
      // application's bundle. Without this they 404 in development, the screen
      // never registers, and every optional module looks broken in the one
      // place anybody would notice — which is how they went unlooked-at.
      "/modules": "http://localhost:3000",
    },
  },
  build: { outDir: "dist" },
});
