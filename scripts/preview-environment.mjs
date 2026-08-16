import fs from "node:fs";
import path from "node:path";
import { scrubSensitiveEnvironment } from "./vendored-dist-environment.mjs";
import { instrumentPreviewLauncher } from "./preview-launcher-observer.mjs";

const LEGACY_ENGINE_ENVIRONMENT_NAMES = [
  "ARCHON_BASE_URL",
  "NEXT_PUBLIC_ARCHON_URL",
  "KADY_ARCHON_PORT",
];
const VENDORED_DIST_LAUNCH_SCRIPTS = [
  "vendored-dist-build.mjs",
  "vendored-dist-check.mjs",
  "vendored-dist-environment.mjs",
];

function writeExecutable(targetPath, content) {
  fs.writeFileSync(targetPath, content, { mode: 0o700 });
}

export function createLaunchOverlay(repositoryRoot, stateRoot, realNpm, realGit) {
  const launchRoot = path.join(stateRoot, "launch");
  const isolatedHome = path.join(stateRoot, "home");
  // start.mjs prepends ~/.local/bin after its dependency checks. Put the
  // shims there so that normalization cannot expose the host npm/git again.
  const shimDirectory = path.join(isolatedHome, ".local", "bin");
  const launchScriptsDirectory = path.join(launchRoot, "scripts");
  fs.mkdirSync(launchScriptsDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(shimDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(stateRoot, "tmp"), { recursive: true, mode: 0o700 });
  const launcherSource = fs.readFileSync(path.join(repositoryRoot, "start.mjs"), "utf-8");
  fs.writeFileSync(
    path.join(launchRoot, "start.mjs"),
    instrumentPreviewLauncher(launcherSource),
    { mode: 0o700 },
  );
  fs.copyFileSync(path.join(repositoryRoot, "env-file.mjs"), path.join(launchRoot, "env-file.mjs"));
  for (const scriptName of VENDORED_DIST_LAUNCH_SCRIPTS) {
    fs.copyFileSync(
      path.join(repositoryRoot, "scripts", scriptName),
      path.join(launchScriptsDirectory, scriptName),
    );
  }
  fs.writeFileSync(path.join(launchRoot, ".env"), "# Intentionally blank preview environment.\n", {
    mode: 0o600,
  });
  fs.symlinkSync(path.join(repositoryRoot, "server"), path.join(launchRoot, "server"), "dir");
  fs.symlinkSync(path.join(repositoryRoot, "web"), path.join(launchRoot, "web"), "dir");

  writeExecutable(
    path.join(shimDirectory, "npm"),
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "view") process.exit(1);
const result = spawnSync(${JSON.stringify(realNpm)}, args, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`,
  );
  writeExecutable(
    path.join(shimDirectory, "git"),
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("push")) {
  console.error("[kady-preview] blocked destructive git command: push");
  process.exit(125);
}
const gitEnvironment = {
  ...process.env,
  GIT_ALLOW_PROTOCOL: "file",
  GIT_PROTOCOL_FROM_USER: "0",
  GIT_TERMINAL_PROMPT: "0",
};
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit", env: gitEnvironment });
process.exit(result.status ?? 1);
`,
  );
  return { launchRoot, shimDirectory };
}

function browserOrigin(environment, environmentName, fallbackUrl) {
  const configuredUrl = environment[environmentName];
  if (configuredUrl === undefined) return fallbackUrl;

  let parsedUrl;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error(
      `${environmentName} must be an absolute http(s) origin.`,
    );
  }

  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new Error(
      `${environmentName} must be an absolute http(s) origin.`,
    );
  }

  return parsedUrl.origin;
}

export function previewEnvironment(
  stateRoot,
  launchRoot,
  shimDirectory,
  ports,
  ambientEnvironment = process.env,
) {
  const environment = scrubSensitiveEnvironment(ambientEnvironment);
  for (const name of LEGACY_ENGINE_ENVIRONMENT_NAMES) delete environment[name];

  const piAgentDirectory = path.join(stateRoot, "pi-agent");
  const backendUrl = `http://127.0.0.1:${ports.backend}`;
  const pipelineEngineUrl = `http://127.0.0.1:${ports.engine}`;
  const backendBrowserUrl = browserOrigin(
    environment,
    "NEXT_PUBLIC_ADK_API_URL",
    backendUrl,
  );
  const pipelineEngineBrowserUrl = browserOrigin(
    environment,
    "NEXT_PUBLIC_PIPELINE_ENGINE_URL",
    pipelineEngineUrl,
  );
  return {
    ...environment,
    HOME: path.join(stateRoot, "home"),
    PATH: `${shimDirectory}${path.delimiter}${environment.PATH ?? ""}`,
    KADY_PREVIEW: "1",
    KADY_PORT: String(ports.backend),
    KADY_FRONTEND_PORT: String(ports.frontend),
    NEXT_PUBLIC_ADK_API_URL: backendBrowserUrl,
    NEXT_PUBLIC_SCIENTIFIC_DAG_STUDIO: "1",
    KADY_PIPELINE_ENGINE_PORT: String(ports.engine),
    PIPELINE_ENGINE_BASE_URL: pipelineEngineUrl,
    NEXT_PUBLIC_PIPELINE_ENGINE_URL: pipelineEngineBrowserUrl,
    KADY_PROJECTS_ROOT: path.join(stateRoot, "projects"),
    KADY_PI_AGENT_DIR: piAgentDirectory,
    PI_CODING_AGENT_DIR: piAgentDirectory,
    KADY_SKILLS_CACHE_DIR: path.join(stateRoot, "skills-cache"),
    KADY_SKILLS_REPO: "kady-preview-nonexistent/none",
    KADY_WORKFLOW_SUPERVISOR_DIR: path.join(stateRoot, "workflow-supervisor"),
    KADY_WORKFLOW_SUPERVISOR_SOCKET: path.join(stateRoot, "wf.sock"),
    TELEGRAM_BOT_TOKEN: "",
    OPENAI_COMPATIBLE_BASE_URL: "",
    OLLAMA_BASE_URL: "http://127.0.0.1:9",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_cache: path.join(stateRoot, "npm-cache"),
    KADY_PREVIEW_LAUNCH_ROOT: launchRoot,
    KADY_PREVIEW_SERVICE_STATE_FILE: path.join(stateRoot, "services.json"),
  };
}
