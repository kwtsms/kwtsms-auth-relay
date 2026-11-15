/*
FILE:      eslint.config.mjs
CREATED:   2026-11-16 01:50 +03
TASK:      int-clerk int-neon
AUTHOR:    M Alhassoun
WHAT:      ESLint flat config with typescript-eslint recommended.
WHY:       `npm run lint` is a done criterion and a CI step.
*/
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
);
