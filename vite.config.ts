// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv } from "vite";

const privateClientKey = "VITE_SUPABASE_SERVICE_ROLE_KEY";
const hasPrivateClientKey =
  Boolean(process.env[privateClientKey]) ||
  ["development", "production"].some((mode) =>
    Boolean(loadEnv(mode, process.cwd(), "")[privateClientKey]),
  );
if (hasPrivateClientKey) {
  throw new Error(`${privateClientKey} must not be set; use SUPABASE_SERVICE_ROLE_KEY instead.`);
}

export default defineConfig({
  nitro: {
    preset: "node-server",
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    server: {
      host: true,
      allowedHosts: [
        ".ngrok-free.dev",
        ".ngrok-free.app",
        ".ngrok.io",
        "bobsled-shorter-unrigged.ngrok-free.dev",
      ],
    },
  },
});
