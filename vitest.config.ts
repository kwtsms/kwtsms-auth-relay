/*
FILE:      vitest.config.ts
CREATED:   2026-11-16 01:50 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      Vitest config: unit tests in tests/.
WHY:       `npm test` is a done criterion and a CI step.
*/
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
