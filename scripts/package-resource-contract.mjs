export const REQUIRED_RESOURCE_FILES = Object.freeze([
  "skills/pi-orchestra/SKILL.md",
  "skills/pi-typescript-extension-engineering/SKILL.md",
  "skills/real-product-showcase/SKILL.md",
  "prompts/orchestra-audit.md",
  "prompts/orchestra-plan.md",
  "prompts/orchestra-implement.md",
]);

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  "dist/index.js",
  "dist/index.d.ts",
  "README.md",
  "LICENSE",
  ...REQUIRED_RESOURCE_FILES,
]);
