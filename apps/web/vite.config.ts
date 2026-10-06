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
      /*
       * The paths the server owns that are not `/api`, which development did
       * not have and a deployed instance does.
       *
       * In production nginx proxies *everything* to the app and the app serves
       * the built bundle itself, so one origin answers both. In development
       * Vite serves the bundle and forwards only what is listed here — so a
       * customer's own account page, a portal link, a shared template's logo
       * and `/healthz` all came back as the application shell. Which looks like
       * a working page: 200, HTML, a blank screen.
       *
       * That is why the screens walk could not run against its own default
       * target. `playwright.config.ts` points at `http://localhost:5173`, and
       * `global-setup.ts` opens `/healthz` and parses it as JSON — it got
       * `<!doctype`.
       *
       * None of these collides with a screen: the `account` module registers no
       * nav entry and no route in `App.tsx`, and neither does the portal. A
       * path that is both would have to be listed more precisely than a prefix.
       */
      "/healthz": "http://localhost:3000",
      "/account": "http://localhost:3000",
      "/portal": "http://localhost:3000",
      "/share": "http://localhost:3000",
    },
  },
  build: { outDir: "dist" },
});
