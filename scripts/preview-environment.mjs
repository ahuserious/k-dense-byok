import fs from "node:fs";
import path from "node:path";
import { LEGACY_ENGINE_DATA_DIRECTORY } from "../server/src/legacy-engine-data.ts";

const ALLOWED_AMBIENT_VARIABLES = [
  "PATH",
  "TMPDIR",
  "LANG",
  "TERM",
  "CI",
  "NEXT_PUBLIC_ADK_API_URL",
  "NEXT_PUBLIC_PIPELINE_ENGINE_URL",
];
const BUN_AUTO_ENV_FILE_NAMES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
];
const ENGINE_ARGUMENTS_ANCHOR =
  '  const engineArgs = ["--filter", "@archon/server", "start"];';

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

export function previewEngineHome(stateRoot) {
  return path.join(stateRoot, "pipeline-engine-home");
}

export function allowlistedPreviewEnvironment(
  ambientEnvironment = process.env,
  explicitPreviewVariables = {},
) {
  const environment = {};
  for (const name of ALLOWED_AMBIENT_VARIABLES) {
    if (ambientEnvironment[name] !== undefined) {
      environment[name] = ambientEnvironment[name];
    }
  }
  if (ambientEnvironment.NODE_ENV !== undefined) {
    environment.NODE_ENV = ambientEnvironment.NODE_ENV;
  }
  return { ...environment, ...explicitPreviewVariables };
}

export function preparePreviewEngineHome(stateRoot) {
  const engineHome = previewEngineHome(stateRoot);
  fs.mkdirSync(engineHome, { recursive: true, mode: 0o700 });
  const engineHomeStat = fs.lstatSync(engineHome);
  if (engineHomeStat.isSymbolicLink() || !engineHomeStat.isDirectory()) {
    throw new Error(`Preview engine ARCHON_HOME must be a real directory: ${engineHome}`);
  }
  if (fs.readdirSync(engineHome).length > 0) {
    throw new Error(`Preview engine ARCHON_HOME must be empty: ${engineHome}`);
  }
  return engineHome;
}

export function previewEngineEnvironmentFiles(repositoryRoot) {
  const vendoredRoot = path.join(
    repositoryRoot,
    "server",
    "vendor",
    "pipeline-engine",
  );
  // `bun --filter @archon/server start` runs the package script from here,
  // so this is the cwd used by the engine's repository env loader.
  const enginePackageDirectory = path.join(vendoredRoot, "packages", "server");
  return [
    ...BUN_AUTO_ENV_FILE_NAMES.flatMap((fileName) => [
      path.join(vendoredRoot, fileName),
      path.join(enginePackageDirectory, fileName),
    ]),
    path.join(enginePackageDirectory, LEGACY_ENGINE_DATA_DIRECTORY, ".env"),
  ];
}

export function assertPreviewEngineEnvironmentFilesAbsent(repositoryRoot) {
  for (const file of previewEngineEnvironmentFiles(repositoryRoot)) {
    try {
      fs.lstatSync(file);
      throw new Error(`Preview engine isolation refuses environment file ${file}.`);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

export function instrumentPreviewEnvironment(launcherSource) {
  const firstAnchor = launcherSource.indexOf(ENGINE_ARGUMENTS_ANCHOR);
  if (
    firstAnchor === -1 ||
    launcherSource.indexOf(ENGINE_ARGUMENTS_ANCHOR, firstAnchor + 1) !== -1
  ) {
    throw new Error(
      "Preview engine isolation instrumentation expected one engine spawn anchor in start.mjs.",
    );
  }

  const autoEnvFileNames = JSON.stringify(BUN_AUTO_ENV_FILE_NAMES);
  const legacyDataDirectory = JSON.stringify(LEGACY_ENGINE_DATA_DIRECTORY);
  const guard = `  if (process.env.KADY_PREVIEW === "1") {
    const previewEnginePackageDirectory = path.join(PIPELINE_ENGINE_DIR, "packages", "server");
    const previewEngineEnvironmentFiles = [
      ...${autoEnvFileNames}.flatMap((fileName) => [
        path.join(PIPELINE_ENGINE_DIR, fileName),
        path.join(previewEnginePackageDirectory, fileName),
      ]),
      path.join(previewEnginePackageDirectory, ${legacyDataDirectory}, ".env"),
    ];
    for (const previewEngineEnvironmentFile of previewEngineEnvironmentFiles) {
      try {
        fs.lstatSync(previewEngineEnvironmentFile);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      throw new Error(
        \`Preview engine isolation refuses environment file \${previewEngineEnvironmentFile}.\`,
      );
    }
  }
`;
  return launcherSource.replace(ENGINE_ARGUMENTS_ANCHOR, guard + ENGINE_ARGUMENTS_ANCHOR);
}

export function previewEnvironment(
  stateRoot,
  launchRoot,
  shimDirectory,
  ports,
  ambientEnvironment = process.env,
) {
  const piAgentDirectory = path.join(stateRoot, "pi-agent");
  const backendUrl = `http://127.0.0.1:${ports.backend}`;
  const pipelineEngineUrl = `http://127.0.0.1:${ports.engine}`;
  const backendBrowserUrl = browserOrigin(
    ambientEnvironment,
    "NEXT_PUBLIC_ADK_API_URL",
    backendUrl,
  );
  const pipelineEngineBrowserUrl = browserOrigin(
    ambientEnvironment,
    "NEXT_PUBLIC_PIPELINE_ENGINE_URL",
    pipelineEngineUrl,
  );
  const allowedAmbientEnvironment = allowlistedPreviewEnvironment(ambientEnvironment);
  return allowlistedPreviewEnvironment(ambientEnvironment, {
    HOME: path.join(stateRoot, "home"),
    ARCHON_HOME: previewEngineHome(stateRoot),
    PATH: [shimDirectory, allowedAmbientEnvironment.PATH].filter(Boolean).join(path.delimiter),
    KADY_PREVIEW: "1",
    KADY_ENV_FILE: path.join(launchRoot, ".env"),
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
  });
}
