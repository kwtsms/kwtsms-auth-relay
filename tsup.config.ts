/*
FILE:      tsup.config.ts
CREATED:   2026-11-16 01:50 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      tsup build: ESM + CJS + .d.ts for the index, clerk and neon entry points.
WHY:       Subpath exports keep svix (Clerk) and jose (Neon) out of the bundle that does not need them.
*/
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/clerk.ts", "src/neon.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node18",
});
