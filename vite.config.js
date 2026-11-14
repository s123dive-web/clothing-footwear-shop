import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Served at the repo sub-path on GitHub Pages in production; at root during local dev.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/clothing-footwear-shop/" : "/",
  plugins: [
    react(),
    // Installable app + offline app shell. The service worker precaches the shell (HTML, JS for
    // every tab, charts, logo, payment QR) so the app opens at the counter with no network; data
    // comes from the IndexedDB cache and unsynced work waits in the outbox (see CLAUDE.md).
    // registerType "prompt": a new version is downloaded in the background and the user is
    // ASKED to reload (src/ui/UpdatePrompt.jsx) — the page never reloads itself mid-bill.
    VitePWA({
      registerType: "prompt",
      injectRegister: false, // registered by UpdatePrompt, production builds only
      manifest: {
        name: "Clothing & Footwear Shop Manager",
        short_name: "Shop Manager",
        description: "Billing, stock and udhari for the shop counter.",
        lang: "en",
        display: "standalone",
        start_url: ".",
        scope: ".",
        theme_color: "#10331F",
        background_color: "#10331F",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,jpg,png,webmanifest}"],
        // Heavy and rarely used at the counter (spreadsheet + PDF import/export): fetched and
        // cached the first time they are needed instead of on install.
        globIgnores: ["**/xlsx-*.js", "**/pdf-*.js", "**/pdf.worker*"],
        cleanupOutdatedCaches: true,
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.includes("/assets/"),
            handler: "CacheFirst", // hashed file names → safe to keep
            options: { cacheName: "lazy-assets", expiration: { maxEntries: 40 } },
          },
        ],
      },
    }),
  ],
  server: { port: 5173, open: true },
  build: {
    // Split heavy vendors into their own chunks so the browser caches them across
    // deploys and loads them in parallel instead of in one ~1.5 MB blob.
    rollupOptions: {
      output: {
        // recharts and xlsx are NOT listed: they are only reached through dynamic imports
        // (lazy tabs / on-demand export), and Rollup gives them their own async chunks.
        manualChunks: {
          react: ["react", "react-dom"],
          firebase: ["firebase/app", "firebase/auth", "firebase/database", "firebase/storage"],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  // Vitest: unit tests live next to the code in src/. The Playwright specs in e2e/ are run
  // by `npm run test:e2e`, never by vitest.
  test: {
    include: ["src/**/*.test.{js,jsx}"],
  },
}));
