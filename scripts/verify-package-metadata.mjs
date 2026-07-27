import { readFile } from "node:fs/promises";
import { REQUIRED_RESOURCE_FILES } from "./package-resource-contract.mjs";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const CANONICAL_REPOSITORY = "https://github.com/OnlineChefGroep/pi-agent-orchestrator";
const CANONICAL_PREVIEW =
  "https://onlinechefgroep.github.io/pi-agent-orchestrator/assets/dashboard_preview.mp4";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Package metadata check failed: ${message}`);
  }
}

assert(packageJson.name === "@onlinechefgroep/pi-agent-orchestrator", "unexpected package name");
assert(packageJson.license === "MIT", "license must remain explicit");
assert(packageJson.publishConfig?.access === "public", "scoped package must publish publicly");
assert(packageJson.keywords?.includes("pi-package"), "missing pi-package discovery keyword");
assert(packageJson.keywords?.includes("pi-coding-agent"), "missing exact Pi search keyword");
assert(packageJson.description?.length >= 80, "description is too weak for catalog discovery");
assert(packageJson.description?.length <= 180, "description is too long for catalog cards");

const repositoryValue = packageJson.repository;
const repositoryUrl =
  typeof repositoryValue === "string" ? repositoryValue : repositoryValue?.url ?? "";
const normalizedRepository = repositoryUrl
  .replace(/^git\+/, "")
  .replace(/\.git$/, "")
  .replace(/\/$/, "");
assert(
  normalizedRepository === CANONICAL_REPOSITORY,
  "repository must point at the public canonical repository",
);

const extensions = packageJson.pi?.extensions;
const skills = packageJson.pi?.skills;
const prompts = packageJson.pi?.prompts;
assert(Array.isArray(extensions) && extensions.length > 0, "pi.extensions must not be empty");
assert(extensions.includes("./dist/index.js"), "compiled extension entrypoint is not declared");
assert(Array.isArray(skills) && skills.includes("./skills"), "Orchestra skill resources are not declared");
assert(Array.isArray(prompts) && prompts.includes("./prompts"), "Orchestra prompt resources are not declared");
assert(packageJson.files?.includes("dist/"), "dist/ is excluded from the npm tarball");
assert(packageJson.files?.includes("skills/"), "skills/ is excluded from the npm tarball");
assert(packageJson.files?.includes("prompts/"), "prompts/ is excluded from the npm tarball");

for (const resourcePath of REQUIRED_RESOURCE_FILES) {
  let content;
  try {
    content = await readFile(new URL(`../${resourcePath}`, import.meta.url), "utf8");
  } catch {
    throw new Error(`Package metadata check failed: missing required resource ${resourcePath}`);
  }

  const normalizedContent = content.replace(/^\uFEFF/, "");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalizedContent);
  assert(frontmatter, `${resourcePath} is missing valid frontmatter`);
  const frontmatterBody = frontmatter[1];
  assert(
    /(?:^|\r?\n)description:\s*\S/.test(frontmatterBody),
    `${resourcePath} is missing a frontmatter description`,
  );

  if (resourcePath === "skills/pi-orchestra/SKILL.md") {
    assert(
      /(?:^|\r?\n)name:\s*pi-orchestra\s*(?:\r?\n|$)/.test(frontmatterBody),
      "Orchestra skill frontmatter name is invalid",
    );
  }

  if (resourcePath === "skills/pi-typescript-extension-engineering/SKILL.md") {
    assert(
      /(?:^|\r?\n)name:\s*pi-typescript-extension-engineering\s*(?:\r?\n|$)/.test(
        frontmatterBody,
      ),
      "TypeScript extension engineering skill frontmatter name is invalid",
    );
  }

  if (resourcePath === "skills/real-product-showcase/SKILL.md") {
    assert(
      /(?:^|\r?\n)name:\s*real-product-showcase\s*(?:\r?\n|$)/.test(frontmatterBody),
      "Real product showcase skill frontmatter name is invalid",
    );
  }
}

const preview = packageJson.pi?.video;
assert(preview === CANONICAL_PREVIEW, "Pi gallery video must use the canonical showcase asset");
try {
  const previewUrl = new URL(preview);
  assert(previewUrl.protocol === "https:", "Pi gallery video must use HTTPS");
  assert(previewUrl.pathname.endsWith(".mp4"), "Pi gallery video must be an MP4");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Package metadata check failed:")) {
    throw error;
  }
  throw new Error("Package metadata check failed: Pi gallery video is not a valid URL");
}

for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
  assert(
    !dependencyName.startsWith("@earendil-works/pi-"),
    `${dependencyName} must be a peer dependency, not a runtime dependency`,
  );
}

console.log(
  `Package metadata ready: ${packageJson.name}@${packageJson.version} with extension, skill, prompts, and Pi gallery video`,
);
