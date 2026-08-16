import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LEGACY_ENGINE_DATA_DIRECTORY } from "../server/src/legacy-engine-data.ts";
import { instrumentPreviewLauncher } from "./preview-launcher-observer.mjs";

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
const PREVIEW_WEB_SOURCE_DIRECTORY_NAMES = ["src", "public"];
const PREVIEW_WEB_SOURCE_FILE_NAMES = [
  "components.json",
  "next-env.d.ts",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "package.json",
  "postcss.config.js",
  "postcss.config.mjs",
  "postcss.config.ts",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  "tsconfig.json",
];
const PREVIEW_WEB_PROJECTION_MARKER_VERSION = 4;
const LAUNCHER_HELPER_ANCHOR =
  "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));";
const SERVICE_SPAWN_ANCHOR = "  const child = directArgs";
const ENGINE_INSTALL_ANCHOR =
  '    if (run(bun, ["install"], { cwd: PIPELINE_ENGINE_DIR }) !== 0) {';
const ENGINE_BUILD_ANCHOR =
  '    if (run(bun, ["run", "build:web"], { cwd: PIPELINE_ENGINE_DIR }) !== 0) {';
const ENGINE_ARGUMENTS_ANCHOR =
  '  const engineArgs = ["--filter", "@archon/server", "start"];';
// A launcher that still shells out to Bun synchronously must expose the two
// retired engine anchors below; see guardRetiredLauncherAnchor(). Every
// synchronous runner the launcher owns (run/capture/runCapture/spawnSync)
// counts, applied to any bun-shaped identifier (bun, bunPath, previewBun), so
// anchor drift cannot degrade into a silent skip. The asynchronous
// `spawn(bun, engineArgs, …)` engine start is deliberately not matched: it is
// pinned by the strict exactly-one ENGINE_ARGUMENTS_ANCHOR above.
const LAUNCHER_SYNCHRONOUS_BUN_PATTERN =
  /\b(?:run|capture|runCapture|spawnSync)\(\s*[\w$]*[Bb]un[\w$]*\b/;
// The overlay's start.mjs imports the vendored-dist scripts, and the copied
// builder imports this module (for the automatic-env-file guard), which in
// turn imports the observer. Copy the whole closure so every overlay import
// resolves inside the isolated launch root.
const VENDORED_DIST_LAUNCH_SCRIPTS = [
  "preview-environment.mjs",
  "preview-launcher-observer.mjs",
  "vendored-dist-build.mjs",
  "vendored-dist-check.mjs",
  "vendored-dist-environment.mjs",
];

function writeExecutable(targetPath, content) {
  fs.writeFileSync(targetPath, content, { mode: 0o700 });
}

/**
 * Build the hermetic launch overlay: an isolated start.mjs carrying both
 * instrumentations (observer records + environment-isolation guards), the
 * vendored-dist script closure, blank .env, and the fail-closed npm/git shims.
 *
 * The projected web root is NOT created here — preview-up.mjs calls
 * preparePreviewWebRoot() right after, so the generation-bound projection and
 * its cleanup stay owned by the lifecycle that publishes the state file.
 */
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
    instrumentPreviewEnvironment(instrumentPreviewLauncher(launcherSource)),
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
  // No web/ symlink: Turbopack re-reads checkout env files through a symlinked
  // web root, so preparePreviewWebRoot() projects an env-free copy instead.

  writeExecutable(
    path.join(shimDirectory, "npm"),
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const allowed = args.length === 3 && args[0] === "run" && args[1] === "prep" && args[2] === "--silent";
if (!allowed) {
  console.error("[kady-preview] blocked npm command: " + args.join(" "));
  process.exit(125);
}
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

function isPreviewWebRootExcluded(name) {
  return (
    name === ".next" ||
    name === ".preview" ||
    name === "node_modules" ||
    PACKAGE_MANAGER_LOCK_FILE_NAMES.includes(name) ||
    AUTOMATIC_ENV_FILE_NAMES.includes(name)
  );
}

function pathIsInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function canonicalPreviewSourceDirectory(canonicalRepositoryRoot, name) {
  const sourceDirectory = path.join(canonicalRepositoryRoot, name);
  const sourceStat = fs.lstatSync(sourceDirectory);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(
      `Preview web projection requires checkout ${name}/ to be a real directory: ${sourceDirectory}.`,
    );
  }
  const canonicalDirectory = fs.realpathSync(sourceDirectory);
  if (!pathIsInside(canonicalDirectory, canonicalRepositoryRoot)) {
    throw new Error(
      `Preview web projection refuses checkout ${name}/ outside the canonical checkout: ${canonicalDirectory}.`,
    );
  }
  return canonicalDirectory;
}

function previewWebAllowedSourceRoots(canonicalRepositoryRoot) {
  const webRoot = canonicalPreviewSourceDirectory(canonicalRepositoryRoot, "web");
  const serverRoot = canonicalPreviewSourceDirectory(canonicalRepositoryRoot, "server");
  return [
    ...PREVIEW_WEB_SOURCE_DIRECTORY_NAMES.map((name) => path.join(webRoot, name)),
    ...PREVIEW_WEB_SOURCE_FILE_NAMES.map((name) => path.join(webRoot, name)),
    path.join(serverRoot, "package.json"),
  ];
}

function previewSensitiveTargetClass(canonicalRepositoryRoot, canonicalTarget) {
  const relative = path.relative(canonicalRepositoryRoot, canonicalTarget);
  const segments = relative.split(path.sep);
  if (segments.includes(".git")) return "git metadata";
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    return "environment file";
  }
  if (segments.includes("node_modules")) return "dependency tree";
  if (segments.includes(".next")) return "Next build output";
  if (segments.includes(".preview")) return "preview destination";
  if (segments[0] === "deploy" && segments[1] === "preview") {
    return "preview lifecycle state";
  }
  const vendorIndex = segments.indexOf("vendor");
  if (segments[0] === "server" && vendorIndex === 1 && segments.slice(2).includes("dist")) {
    return "vendored dist staging";
  }
  return null;
}

function resolvePreviewSourceContent(sourcePath, canonicalRepositoryRoot) {
  const sourceStat = fs.lstatSync(sourcePath);
  let canonicalTarget;
  try {
    canonicalTarget = fs.realpathSync(sourcePath);
  } catch (error) {
    throw new Error(
      `Preview web projection refuses ${sourceStat.isSymbolicLink() ? "dangling symlink" : "unresolvable source entry"} ${sourcePath}.`,
      { cause: error },
    );
  }
  if (!pathIsInside(canonicalTarget, canonicalRepositoryRoot)) {
    throw new Error(
      `Preview web projection refuses source entry ${sourcePath}: canonical target ${canonicalTarget} is outside the checkout.`,
    );
  }
  const sensitiveClass = previewSensitiveTargetClass(
    canonicalRepositoryRoot,
    canonicalTarget,
  );
  if (sensitiveClass) {
    throw new Error(
      `Preview web projection refuses source entry ${sourcePath}: canonical target ${canonicalTarget} is ${sensitiveClass}.`,
    );
  }
  const allowedRoots = previewWebAllowedSourceRoots(canonicalRepositoryRoot);
  if (!allowedRoots.some((allowedRoot) => pathIsInside(canonicalTarget, allowedRoot))) {
    throw new Error(
      `Preview web projection refuses source entry ${sourcePath}: canonical target ${canonicalTarget} is outside the copied source set.`,
    );
  }
  return {
    contentPath: canonicalTarget,
    stat: sourceStat.isSymbolicLink() ? fs.statSync(canonicalTarget) : sourceStat,
  };
}

export function previewWebSourceManifest(repositoryRoot) {
  const canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
  const checkoutWebRoot = canonicalPreviewSourceDirectory(canonicalRepositoryRoot, "web");
  const checkoutServerRoot = canonicalPreviewSourceDirectory(canonicalRepositoryRoot, "server");
  const entries = [];

  function visit(absolutePath, manifestPath, ancestorDirectories = new Set()) {
    const { contentPath, stat } = resolvePreviewSourceContent(
      absolutePath,
      canonicalRepositoryRoot,
    );
    if (stat.isDirectory()) {
      const canonicalDirectory = fs.realpathSync(contentPath);
      if (ancestorDirectories.has(canonicalDirectory)) {
        throw new Error(`Preview web projection refuses symlink directory cycle at ${absolutePath}.`);
      }
      const childAncestors = new Set(ancestorDirectories);
      childAncestors.add(canonicalDirectory);
      entries.push({ path: manifestPath, type: "directory" });
      for (const name of fs.readdirSync(contentPath).sort()) {
        visit(path.join(contentPath, name), `${manifestPath}/${name}`, childAncestors);
      }
      return;
    }
    if (stat.isFile()) {
      entries.push({
        path: manifestPath,
        type: "file",
        digest: createHash("sha256").update(fs.readFileSync(contentPath)).digest("hex"),
      });
      return;
    }
    entries.push({ path: manifestPath, type: "other" });
  }

  for (const name of [
    ...PREVIEW_WEB_SOURCE_DIRECTORY_NAMES,
    ...PREVIEW_WEB_SOURCE_FILE_NAMES,
  ].sort()) {
    const sourcePath = path.join(checkoutWebRoot, name);
    if (fs.existsSync(sourcePath)) visit(sourcePath, `web/${name}`);
  }
  visit(
    path.join(checkoutServerRoot, "package.json"),
    "server/package.json",
  );
  return {
    version: 1,
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
  };
}

export function firstPreviewWebSourceDrift(expectedManifest, currentManifest) {
  if (expectedManifest.digest === currentManifest.digest) return null;
  const expectedByPath = new Map(
    expectedManifest.entries.map((entry) => [entry.path, JSON.stringify(entry)]),
  );
  const currentByPath = new Map(
    currentManifest.entries.map((entry) => [entry.path, JSON.stringify(entry)]),
  );
  const paths = [...new Set([...expectedByPath.keys(), ...currentByPath.keys()])].sort();
  return paths.find((entryPath) => expectedByPath.get(entryPath) !== currentByPath.get(entryPath))
    ?? "<unknown>";
}

export function assertPreviewWebProjectionCurrent(repositoryRoot, generation) {
  const manifestPath = path.join(
    path.dirname(previewWebRoot(repositoryRoot)),
    ".source-manifest.json",
  );
  const expected = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (expected.generation !== generation) {
    throw new Error(
      `Preview web source manifest generation mismatch at ${manifestPath}.`,
    );
  }
  const current = previewWebSourceManifest(repositoryRoot);
  const driftPath = firstPreviewWebSourceDrift(expected.manifest, current);
  if (driftPath) {
    throw new Error(
      `Preview web source drift detected at ${path.join(repositoryRoot, driftPath)}; ` +
        "restart with preview-down/up.",
    );
  }
  return true;
}

export function assertPreviewProjectionHasNoSourceSymlinks(
  repositoryRoot,
  projectedWebRoot = previewWebRoot(repositoryRoot),
) {
  const canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
  const projectedNodeModules = path.join(projectedWebRoot, "node_modules");
  const canonicalNodeModules = fs.realpathSync(
    path.join(canonicalRepositoryRoot, "web", "node_modules"),
  );

  function visit(directory) {
    for (const name of fs.readdirSync(directory)) {
      const candidate = path.join(directory, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        const canonicalTarget = fs.realpathSync(candidate);
        if (candidate === projectedNodeModules && canonicalTarget === canonicalNodeModules) {
          continue;
        }
        if (canonicalTarget !== canonicalRepositoryRoot &&
            !canonicalTarget.startsWith(`${canonicalRepositoryRoot}${path.sep}`)) {
          throw new Error(
            `Preview web projection refuses symlink outside the checkout: ${candidate}.`,
          );
        }
        throw new Error(`Preview web projection source must not contain symlink ${candidate}.`);
      } else if (stat.isDirectory()) {
        visit(candidate);
      }
    }
  }

  visit(projectedWebRoot);
}

function assertPreviewHealthRouteParentsReal(webRoot, label) {
  for (const relativePath of ["src", path.join("src", "app"), path.join("src", "app", "api")]) {
    const candidate = path.join(webRoot, relativePath);
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT" && relativePath.endsWith(`${path.sep}api`)) continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Preview web health route requires a real ${label} directory: ${candidate}.`);
    }
  }
}

function copyPreviewSource(
  sourcePath,
  destinationPath,
  canonicalRepositoryRoot,
  ancestorDirectories = new Set(),
) {
  const { contentPath, stat } = resolvePreviewSourceContent(
    sourcePath,
    canonicalRepositoryRoot,
  );
  if (stat.isDirectory()) {
    const canonicalDirectory = fs.realpathSync(contentPath);
    if (ancestorDirectories.has(canonicalDirectory)) {
      throw new Error(`Preview web projection refuses symlink directory cycle at ${sourcePath}.`);
    }
    const childAncestors = new Set(ancestorDirectories);
    childAncestors.add(canonicalDirectory);
    fs.mkdirSync(destinationPath, { recursive: true, mode: stat.mode });
    for (const name of fs.readdirSync(contentPath)) {
      copyPreviewSource(
        path.join(contentPath, name),
        path.join(destinationPath, name),
        canonicalRepositoryRoot,
        childAncestors,
      );
    }
    return;
  }
  if (stat.isFile()) {
    fs.cpSync(contentPath, destinationPath, {
      dereference: true,
      preserveTimestamps: true,
    });
    fs.chmodSync(destinationPath, stat.mode);
    return;
  }
  throw new Error(`Preview web projection refuses unsupported source entry ${sourcePath}.`);
}

export function previewWebRoot(repositoryRoot) {
  const canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
  const checkoutWebRoot = canonicalPreviewSourceDirectory(canonicalRepositoryRoot, "web");
  return path.join(checkoutWebRoot, ".preview", "launch", "web");
}

export function previewWebProjectionMarkerPath(repositoryRoot) {
  return path.join(path.dirname(previewWebRoot(repositoryRoot)), ".kady-preview-owned");
}

export function readPreviewWebProjectionMarker(repositoryRoot) {
  const markerPath = previewWebProjectionMarkerPath(repositoryRoot);
  let markerStat;
  try {
    markerStat = fs.lstatSync(markerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw new Error(`Preview web projection marker is malformed: ${markerPath}.`, {
      cause: error,
    });
  }
  if (
    markerStat.isSymbolicLink() ||
    !markerStat.isFile() ||
    marker?.version !== PREVIEW_WEB_PROJECTION_MARKER_VERSION ||
    typeof marker.generation !== "string" ||
    !marker.generation
  ) {
    throw new Error(`Preview web projection marker failed validation: ${markerPath}.`);
  }
  return marker;
}

export function updatePreviewWebProjectionMarker(repositoryRoot, generation, updates) {
  const markerPath = previewWebProjectionMarkerPath(repositoryRoot);
  const marker = readPreviewWebProjectionMarker(repositoryRoot);
  if (marker?.generation !== generation) {
    throw new Error(`Preview web projection marker generation mismatch at ${markerPath}.`);
  }
  const temporaryMarkerPath = `${markerPath}.${process.pid}.${generation}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryMarkerPath, "wx", 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ ...marker, ...updates }, null, 2)}\n`,
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryMarkerPath, markerPath);
    const directoryDescriptor = fs.openSync(path.dirname(markerPath), "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryMarkerPath, { force: true });
    throw error;
  }
}

function previewWebHealthRouteSource(repositoryRoot, manifestPath, generation) {
  return `import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const AUTOMATIC_ENV_FILE_NAMES = ${JSON.stringify(AUTOMATIC_ENV_FILE_NAMES)};
const PACKAGE_MANAGER_LOCK_FILE_NAMES = ${JSON.stringify(PACKAGE_MANAGER_LOCK_FILE_NAMES)};
const PREVIEW_WEB_SOURCE_DIRECTORY_NAMES = ${JSON.stringify(PREVIEW_WEB_SOURCE_DIRECTORY_NAMES)};
const PREVIEW_WEB_SOURCE_FILE_NAMES = ${JSON.stringify(PREVIEW_WEB_SOURCE_FILE_NAMES)};
const repositoryRoot = ${JSON.stringify(repositoryRoot)};
const manifestPath = ${JSON.stringify(manifestPath)};
const generation = ${JSON.stringify(generation)};

${isPreviewWebRootExcluded.toString()}
${pathIsInside.toString()}
${canonicalPreviewSourceDirectory.toString()}
${previewWebAllowedSourceRoots.toString()}
${previewSensitiveTargetClass.toString()}
${resolvePreviewSourceContent.toString()}
${previewWebSourceManifest.toString()}
${firstPreviewWebSourceDrift.toString()}

export async function GET() {
  try {
    const expected = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (expected.generation !== generation) {
      throw new Error(\`source manifest generation mismatch at \${manifestPath}\`);
    }
    const current = previewWebSourceManifest(repositoryRoot);
    const driftPath = firstPreviewWebSourceDrift(expected.manifest, current);
    if (driftPath) {
      return Response.json(
        {
          status: "unhealthy",
          error: \`Preview web source drift detected at \${path.join(repositoryRoot, driftPath)}; restart with preview-down/up.\`,
        },
        { status: 503 },
      );
    }
    return Response.json({ status: "ok", generation });
  } catch (error) {
    return Response.json(
      { status: "unhealthy", error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
`;
}

export function removePreviewWebRoot(repositoryRoot, generation) {
  if (!generation) throw new Error("Preview web projection cleanup requires a generation.");
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

  const markerPath = previewWebProjectionMarkerPath(repositoryRoot);
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
  let marker = null;
  try {
    marker = readPreviewWebProjectionMarker(repositoryRoot);
  } catch {}
  if (
    markerStat.isSymbolicLink() ||
    !markerStat.isFile() ||
    marker?.version !== PREVIEW_WEB_PROJECTION_MARKER_VERSION ||
    marker?.generation !== generation
  ) {
    throw new Error(
      `Preview web projection cleanup refuses generation mismatch at ${markerPath}.`,
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

export function preparePreviewWebRoot(
  repositoryRoot,
  launchRoot,
  generation,
  { stateRoot, ports } = {},
) {
  if (!generation) throw new Error("Preview web projection requires a generation.");
  const canonicalRepositoryRoot = fs.realpathSync(repositoryRoot);
  const checkoutWebRoot = canonicalPreviewSourceDirectory(canonicalRepositoryRoot, "web");
  const checkoutServerRoot = canonicalPreviewSourceDirectory(canonicalRepositoryRoot, "server");
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
    throw new Error(
      `Preview web projection already exists at ${projectionLaunchRoot}; ` +
        "refusing to replace another lifecycle generation.",
    );
  }
  assertPreviewHealthRouteParentsReal(checkoutWebRoot, "checkout");
  fs.mkdirSync(projectedWebRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(projectionLaunchRoot, ".kady-preview-owned"),
    `${JSON.stringify({
      version: PREVIEW_WEB_PROJECTION_MARKER_VERSION,
      generation,
      repositoryRoot: canonicalRepositoryRoot,
      stateRoot,
      launchRoot,
      ports,
      rootProcess: null,
      serviceStatePath: stateRoot ? path.join(stateRoot, "services.json") : undefined,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  try {
    const sourceManifest = previewWebSourceManifest(canonicalRepositoryRoot);
    const copyStartedAt = process.hrtime.bigint();
    for (const entryName of [
      ...PREVIEW_WEB_SOURCE_DIRECTORY_NAMES,
      ...PREVIEW_WEB_SOURCE_FILE_NAMES,
    ]) {
      const checkoutEntry = path.join(checkoutWebRoot, entryName);
      try {
        fs.lstatSync(checkoutEntry);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      copyPreviewSource(
        checkoutEntry,
        path.join(projectedWebRoot, entryName),
        canonicalRepositoryRoot,
      );
    }
    const projectedServerRoot = path.join(projectionLaunchRoot, "server");
    fs.mkdirSync(projectedServerRoot, { mode: 0o700 });
    copyPreviewSource(
      path.join(checkoutServerRoot, "package.json"),
      path.join(projectedServerRoot, "package.json"),
      canonicalRepositoryRoot,
    );
    const copyElapsedMilliseconds =
      Number(process.hrtime.bigint() - copyStartedAt) / 1_000_000;

    const checkoutNodeModules = path.join(checkoutWebRoot, "node_modules");
    let nodeModulesStat;
    try {
      nodeModulesStat = fs.lstatSync(checkoutNodeModules);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      throw new Error(`Preview web projection requires ${checkoutNodeModules}.`);
    }
    if (nodeModulesStat.isSymbolicLink() || !nodeModulesStat.isDirectory()) {
      throw new Error(
        `Preview web projection requires node_modules to be a real directory; ` +
          `refusing linked dependency tree ${checkoutNodeModules}.`,
      );
    }
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
    fs.symlinkSync(canonicalNodeModules, projectedNodeModules, "dir");

    assertPreviewProjectionHasNoSourceSymlinks(canonicalRepositoryRoot, projectedWebRoot);
    const currentSourceManifest = previewWebSourceManifest(canonicalRepositoryRoot);
    const copyDriftPath = firstPreviewWebSourceDrift(sourceManifest, currentSourceManifest);
    if (copyDriftPath) {
      throw new Error(
        `Preview web source changed during projection at ` +
          `${path.join(canonicalRepositoryRoot, copyDriftPath)}.`,
      );
    }
    const manifestPath = path.join(projectionLaunchRoot, ".source-manifest.json");
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ generation, manifest: sourceManifest }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const healthRouteDirectory = path.join(
      projectedWebRoot,
      "src",
      "app",
      "api",
      "preview-health",
    );
    if (fs.existsSync(healthRouteDirectory)) {
      throw new Error(
        `Preview web projection health route conflicts with ${healthRouteDirectory}.`,
      );
    }
    assertPreviewHealthRouteParentsReal(projectedWebRoot, "projected");
    fs.mkdirSync(healthRouteDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(healthRouteDirectory, "route.ts"),
      previewWebHealthRouteSource(canonicalRepositoryRoot, manifestPath, generation),
      { mode: 0o600 },
    );
    fs.mkdirSync(path.join(projectedWebRoot, ".next"), { mode: 0o700 });
    fs.symlinkSync(projectedWebRoot, path.join(launchRoot, "web"), "dir");
    console.log(
      `Preview web projection copied in ${copyElapsedMilliseconds.toFixed(1)} ms: ` +
        `${projectedWebRoot} (node_modules linked within checkout).`,
    );
    return projectedWebRoot;
  } catch (error) {
    removePreviewWebRoot(canonicalRepositoryRoot, generation);
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

/**
 * The dist-freshness lane removed the launcher's in-process engine dependency
 * install and web build: under KADY_PREVIEW the launcher only re-checks the
 * vendored-dist manifest, and scripts/vendored-dist-build.mjs (which runs the
 * same guard before it starts Bun) owns the rebuild. Guard the anchor when it
 * is present, and refuse to skip silently while any synchronous Bun invocation
 * is still reachable from the launcher.
 */
function guardRetiredLauncherAnchor(source, anchor, replacement, label) {
  if (source.includes(anchor)) {
    return replaceLauncherAnchor(source, anchor, replacement, label);
  }
  if (LAUNCHER_SYNCHRONOUS_BUN_PATTERN.test(source)) {
    throw new Error(
      `Preview environment instrumentation found a synchronous Bun invocation in start.mjs ` +
        `but no ${label} anchor.`,
    );
  }
  return source;
}

export function instrumentPreviewEnvironment(launcherSource) {
  const automaticEnvFileNames = JSON.stringify(AUTOMATIC_ENV_FILE_NAMES);
  const legacyDataDirectory = JSON.stringify(LEGACY_ENGINE_DATA_DIRECTORY);
  const helper = `
const previewAutomaticEnvironmentFileNames = ${automaticEnvFileNames};
// A directory that does not exist cannot hold an env file, and the vendored
// engine tree is optional (a checkout without it skips the engine entirely).
// Every other realpath failure still fails closed.
function canonicalPreviewGuardDirectory(directory) {
  try {
    return fs.realpathSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function assertPreviewAutomaticEnvironmentFilesAbsent(
  directories,
  legacyEnginePackageDirectory = null,
) {
  if (process.env.KADY_PREVIEW !== "1") return;
  const canonicalDirectories = directories
    .map((directory) => canonicalPreviewGuardDirectory(directory))
    .filter((directory) => directory !== null);
  const previewAutomaticEnvironmentFiles = canonicalDirectories.flatMap((directory) =>
    previewAutomaticEnvironmentFileNames.map((fileName) => path.join(directory, fileName)),
  );
  const canonicalLegacyEnginePackageDirectory = legacyEnginePackageDirectory
    ? canonicalPreviewGuardDirectory(legacyEnginePackageDirectory)
    : null;
  if (canonicalLegacyEnginePackageDirectory) {
    previewAutomaticEnvironmentFiles.push(
      path.join(
        canonicalLegacyEnginePackageDirectory,
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
  instrumented = guardRetiredLauncherAnchor(
    instrumented,
    ENGINE_INSTALL_ANCHOR,
    `${engineGuard}${ENGINE_INSTALL_ANCHOR}`,
    "engine install",
  );
  instrumented = guardRetiredLauncherAnchor(
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
  generation,
) {
  // The ambient allowlist below already drops every legacy engine variable
  // (ARCHON_BASE_URL, NEXT_PUBLIC_ARCHON_URL, KADY_ARCHON_PORT) and every
  // credential-shaped name, so it supersedes the earlier denylist scrub.
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
    // Must stay identical to previewVendoredDistEnvironment()'s TMPDIR: the
    // prebuild and the launcher's re-check must run every vendored tool
    // against the same isolated temp root. Only NODE_ENV and PORT are compared
    // against the manifest's buildEnv (vendored-dist-check.mjs:42); TMPDIR is
    // a pass-through for tool resolution, not a fingerprint input.
    TMPDIR: path.join(stateRoot, "tmp"),
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
    // Recording is generation-bound: every record carries the generation and
    // the observer throws without one. Publishing the state file alone would
    // poison the first spawn (SIGSTOP, throw, kill the stopped group), so an
    // ungenerated environment simply disables recording instead.
    ...(generation
      ? {
          KADY_PREVIEW_SERVICE_STATE_FILE: path.join(stateRoot, "services.json"),
          KADY_PREVIEW_GENERATION: generation,
          KADY_PREVIEW_START_GATE_FILE: path.join(
            stateRoot,
            `launcher-${generation}.go`,
          ),
        }
      : {}),
  });
}
