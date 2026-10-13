import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_TARGET = process.env.API_PROXY_TARGET ?? "http://localhost:5000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        // Libraries change far less often than the app, so keep them in files browsers can reuse across deploys.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[/](react|react-dom|react-router|scheduler)[/]/ },
            {
              name: "realtime",
              test: /node_modules[/](socket\.io-client|engine\.io-client|socket\.io-parser|engine\.io-parser)[/]/,
            },
          ],
        },
      },
    },
  },
  // MathJax loads its font's rarer parts on demand (see math.ts). Pre-bundled for the dev server, it would get
  // its own copy of the font, which those parts can't add to.
  optimizeDeps: { exclude: ["@mathjax/src", "@mathjax/mathjax-newcm-font"] },
  server: {
    port: 5173,
    proxy: {
      "/api": API_TARGET,
      "/socket.io": { target: API_TARGET, ws: true },
    },
  },
});
