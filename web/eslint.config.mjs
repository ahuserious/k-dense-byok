import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["src/components/dag-builder-surface.tsx"],
    rules: {
      // S9-20260808-dag-builder-surface-cross-lane — remove at integration hardening: file rewritten by S1, error gone on the merged tip.
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
