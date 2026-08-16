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
const AUTOMATIC_ENV_FILE_NAMES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];
const PACKAGE_MANAGER_LOCK_FILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];
const PREVIEW_WEB_PROJECTION_MARKER = "kady-preview-web-projection-v1\n";
const LAUNCHER_HELPER_ANCHOR =
  "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));";
const SERVICE_SPAWN_ANCHOR = "  const child = directArgs";
const ENGINE_INSTALL_ANCHOR =
  '    if (run(bun, ["install"], { cwd: PIPELINE_ENGINE_DIR }) !== 0) {';
const ENGINE_BUILD_ANCHOR =
  '    if (run(bun, ["run", "build:web"], { cwd: PIPELINE_ENGINE_DIR }) !== 0) {';
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
  return { ...environment, ...explicitPreviewVariables };
}

export function previewPrebuildEnvironment(previewParentEnvironment) {
  return { ...previewParentEnvironment, NODE_ENV: "production" };
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

export function previewWebRoot(repositoryRoot) {
  const checkoutWebRoot = fs.realpathSync(path.join(repositoryRoot, "web"));
  return path.join(checkoutWebRoot, ".preview", "launch", "web");
}

export function removePreviewWebRoot(repositoryRoot) {
  const projectedWebRoot = previewWebRoot(repositoryRoot);
  const projectionLaunchRoot = path.dirname(projectedWebRoot);
  const previewDirectory = path.dirname(projectionLaunchRoot);
  let previewDirectoryStat;
  try {
    previewDirectoryStat = fs.lstatSync(previewDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (previewDirectoryStat.isSymbolicLink() || !previewDirectoryStat.isDirectory()) {
    throw new Error(`Preview web projection cleanup refuses unowned path ${previewDirectory}.`);
  }

  let projectionStat;
  try {
    projectionStat = fs.lstatSync(projectionLaunchRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (projectionStat.isSymbolicLink() || !projectionStat.isDirectory()) {
    throw new Error(
      `Preview web projection cleanup refuses unowned path ${projectionLaunchRoot}.`,
    );
  }

  const markerPath = path.join(projectionLaunchRoot, ".kady-preview-owned");
  let markerStat;
  try {
    markerStat = fs.lstatSync(markerPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Preview web projection cleanup refuses unmarked path ${projectionLaunchRoot}.`,
      );
    }
    throw error;
  }
  if (
    markerStat.isSymbolicLink() ||
    !markerStat.isFile() ||
    fs.readFileSync(markerPath, "utf8") !== PREVIEW_WEB_PROJECTION_MARKER
  ) {
    throw new Error(
      `Preview web projection cleanup refuses invalid marker ${markerPath}.`,
    );
  }

  fs.rmSync(projectionLaunchRoot, { recursive: true, force: true });
  try {
    fs.rmdirSync(previewDirectory);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
  }
  return true;
}

export function preparePreviewWebRoot(repositoryRoot, launchRoot) {
  const canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
  const checkoutWebRoot = fs.realpathSync(path.join(canonicalRepositoryRoot, "web"));
  const projectedWebRoot = previewWebRoot(canonicalRepositoryRoot);
  const projectionLaunchRoot = path.dirname(projectedWebRoot);
  const previewDirectory = path.dirname(projectionLaunchRoot);
  if (fs.existsSync(previewDirectory)) {
    const previewDirectoryStat = fs.lstatSync(previewDirectory);
    if (previewDirectoryStat.isSymbolicLink() || !previewDirectoryStat.isDirectory()) {
      throw new Error(`Preview web projection requires a real directory: ${previewDirectory}`);
    }
  }
  if (fs.existsSync(projectionLaunchRoot)) {
    removePreviewWebRoot(canonicalRepositoryRoot);
  }
  fs.mkdirSync(projectedWebRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(projectionLaunchRoot, ".kady-preview-owned"),
    PREVIEW_WEB_PROJECTION_MARKER,
    { mode: 0o600 },
  );

  try {
    const copyStartedAt = process.hrtime.bigint();
    for (const entry of fs.readdirSync(checkoutWebRoot, { withFileTypes: true })) {
      if (
        entry.name === ".next" ||
        entry.name === ".preview" ||
        entry.name === "node_modules" ||
        PACKAGE_MANAGER_LOCK_FILE_NAMES.includes(entry.name) ||
        AUTOMATIC_ENV_FILE_NAMES.includes(entry.name)
      ) {
        continue;
      }
      const checkoutEntry = path.join(checkoutWebRoot, entry.name);
      const canonicalCheckoutEntry = fs.realpathSync(checkoutEntry);
      if (
        canonicalCheckoutEntry !== canonicalRepositoryRoot &&
        !canonicalCheckoutEntry.startsWith(`${canonicalRepositoryRoot}${path.sep}`)
      ) {
        throw new Error(
          `Preview web projection refuses symlink target outside the checkout: ${checkoutEntry}.`,
        );
      }
      fs.cpSync(
        checkoutEntry,
        path.join(projectedWebRoot, entry.name),
        { recursive: true, dereference: false },
      );
    }
    const projectedServerRoot = path.join(projectionLaunchRoot, "server");
    fs.mkdirSync(projectedServerRoot, { mode: 0o700 });
    fs.cpSync(
      path.join(canonicalRepositoryRoot, "server", "package.json"),
      path.join(projectedServerRoot, "package.json"),
      { dereference: false },
    );
    const copyElapsedMilliseconds =
      Number(process.hrtime.bigint() - copyStartedAt) / 1_000_000;

    const checkoutNodeModules = path.join(checkoutWebRoot, "node_modules");
    let canonicalNodeModules;
    try {
      canonicalNodeModules = fs.realpathSync(checkoutNodeModules);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      throw new Error(`Preview web projection requires ${checkoutNodeModules}.`);
    }
    if (
      canonicalNodeModules !== canonicalRepositoryRoot &&
      !canonicalNodeModules.startsWith(`${canonicalRepositoryRoot}${path.sep}`)
    ) {
      throw new Error(
        `Preview web projection refuses node_modules outside the checkout: ${checkoutNodeModules}.`,
      );
    }
    const projectedNodeModules = path.join(projectedWebRoot, "node_modules");
    fs.symlinkSync(checkoutNodeModules, projectedNodeModules, "dir");

    fs.mkdirSync(path.join(projectedWebRoot, ".next"), { mode: 0o700 });
    fs.symlinkSync(projectedWebRoot, path.join(launchRoot, "web"), "dir");
    console.log(
      `Preview web projection copied in ${copyElapsedMilliseconds.toFixed(1)} ms: ` +
        `${projectedWebRoot} (node_modules linked within checkout).`,
    );
    return projectedWebRoot;
  } catch (error) {
    removePreviewWebRoot(canonicalRepositoryRoot);
    throw error;
  }
}

export function previewAutomaticEnvironmentFiles(repositoryRoot) {
  const webRoot = fs.realpathSync(path.join(repositoryRoot, "web"));
  const vendoredRoot = fs.realpathSync(
    path.join(repositoryRoot, "server", "vendor", "pipeline-engine"),
  );
  const engineWebDirectory = fs.realpathSync(path.join(vendoredRoot, "packages", "web"));
  // `bun --filter @archon/server start` runs the package script from here,
  // so this is the cwd used by the engine's repository env loader.
  const enginePackageDirectory = fs.realpathSync(
    path.join(vendoredRoot, "packages", "server"),
  );
  return [
    ...[webRoot, vendoredRoot, engineWebDirectory, enginePackageDirectory].flatMap(
      (directory) =>
        AUTOMATIC_ENV_FILE_NAMES.map((fileName) => path.join(directory, fileName)),
    ),
    path.join(enginePackageDirectory, LEGACY_ENGINE_DATA_DIRECTORY, ".env"),
  ];
}

export function assertPreviewAutomaticEnvironmentFilesAbsent(repositoryRoot) {
  for (const file of previewAutomaticEnvironmentFiles(repositoryRoot)) {
    try {
      fs.lstatSync(file);
      throw new Error(`Preview environment isolation refuses environment file ${file}.`);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

function replaceLauncherAnchor(source, anchor, replacement, label) {
  const firstAnchor = source.indexOf(anchor);
  if (firstAnchor === -1 || source.indexOf(anchor, firstAnchor + anchor.length) !== -1) {
    throw new Error(
      `Preview environment instrumentation expected one ${label} anchor in start.mjs.`,
    );
  }
  return source.replace(anchor, replacement);
}

export function instrumentPreviewEnvironment(launcherSource) {
  const automaticEnvFileNames = JSON.stringify(AUTOMATIC_ENV_FILE_NAMES);
  const legacyDataDirectory = JSON.stringify(LEGACY_ENGINE_DATA_DIRECTORY);
  const helper = `
const previewAutomaticEnvironmentFileNames = ${automaticEnvFileNames};
function assertPreviewAutomaticEnvironmentFilesAbsent(
  directories,
  legacyEnginePackageDirectory = null,
) {
  if (process.env.KADY_PREVIEW !== "1") return;
  const canonicalDirectories = directories.map((directory) => fs.realpathSync(directory));
  const previewAutomaticEnvironmentFiles = canonicalDirectories.flatMap((directory) =>
    previewAutomaticEnvironmentFileNames.map((fileName) => path.join(directory, fileName)),
  );
  if (legacyEnginePackageDirectory) {
    previewAutomaticEnvironmentFiles.push(
      path.join(
        fs.realpathSync(legacyEnginePackageDirectory),
        ${legacyDataDirectory},
        ".env",
      ),
    );
  }
  for (const previewAutomaticEnvironmentFile of previewAutomaticEnvironmentFiles) {
    try {
      fs.lstatSync(previewAutomaticEnvironmentFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      \`Preview environment isolation refuses environment file \${previewAutomaticEnvironmentFile}.\`,
    );
  }
}`;
  const engineGuard = `    assertPreviewAutomaticEnvironmentFilesAbsent(
      [
        PIPELINE_ENGINE_DIR,
        path.join(PIPELINE_ENGINE_DIR, "packages", "web"),
        path.join(PIPELINE_ENGINE_DIR, "packages", "server"),
      ],
      path.join(PIPELINE_ENGINE_DIR, "packages", "server"),
    );
`;

  let instrumented = replaceLauncherAnchor(
    launcherSource,
    LAUNCHER_HELPER_ANCHOR,
    `${LAUNCHER_HELPER_ANCHOR}${helper}`,
    "helper",
  );
  instrumented = replaceLauncherAnchor(
    instrumented,
    SERVICE_SPAWN_ANCHOR,
    `  if (dir === "web") {
    assertPreviewAutomaticEnvironmentFilesAbsent([cwd]);
  }
${SERVICE_SPAWN_ANCHOR}`,
    "service spawn",
  );
  instrumented = replaceLauncherAnchor(
    instrumented,
    ENGINE_INSTALL_ANCHOR,
    `${engineGuard}${ENGINE_INSTALL_ANCHOR}`,
    "engine install",
  );
  instrumented = replaceLauncherAnchor(
    instrumented,
    ENGINE_BUILD_ANCHOR,
    `${engineGuard}${ENGINE_BUILD_ANCHOR}`,
    "engine build",
  );
  return replaceLauncherAnchor(
    instrumented,
    ENGINE_ARGUMENTS_ANCHOR,
    `  assertPreviewAutomaticEnvironmentFilesAbsent(
    [
      PIPELINE_ENGINE_DIR,
      path.join(PIPELINE_ENGINE_DIR, "packages", "web"),
      path.join(PIPELINE_ENGINE_DIR, "packages", "server"),
    ],
    path.join(PIPELINE_ENGINE_DIR, "packages", "server"),
  );
${ENGINE_ARGUMENTS_ANCHOR}`,
    "engine spawn",
  );
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
