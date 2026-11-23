import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ARC-03: a module may reach another module only through its public service interface.
// Core is the base layer and must not depend on Feedback Hub or Journey Boards at all.
const onlyService = (mod) => ({
  group: [`@/modules/${mod}/*`, `!@/modules/${mod}/service`],
  message: `Use @/modules/${mod}/service; other modules' internals and tables are off limits (ARC-03).`,
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/modules/fh/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [onlyService("jb"), onlyService("core")] }] },
  },
  {
    files: ["src/modules/jb/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [onlyService("fh"), onlyService("core")] }] },
  },
  {
    files: ["src/modules/core/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["@/modules/fh/*", "@/modules/jb/*"], message: "Core must not depend on Feedback Hub or Journey Boards (ARC-03)." },
      ] }],
    },
  },
  {
    files: ["packages/contracts/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["*", "!./*", "!../*"], message: "contracts has no runtime dependencies (ARC-04)." },
      ] }],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "coverage/**"]),
]);

export default eslintConfig;
