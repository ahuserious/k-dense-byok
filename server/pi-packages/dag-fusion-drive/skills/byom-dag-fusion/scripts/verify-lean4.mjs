import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXIT_USAGE = 64;
const EXIT_REJECTED = 65;
const EXIT_INPUT = 66;
const EXIT_UNAVAILABLE = 69;
const EXIT_TIMEOUT = 124;
const DEFAULT_TIMEOUT_MS = 120_000;

function stop(code, message) {
  process.stderr.write(`byom-dag-fusion: ${message}\n`);
  process.exit(code);
}

function regularFile(file, description) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    stop(EXIT_UNAVAILABLE, `${description} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    stop(EXIT_INPUT, `${description} must be a regular non-symlink file`);
  }
}

function regularDirectory(directory, description) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    stop(EXIT_UNAVAILABLE, `${description} is missing`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    stop(EXIT_INPUT, `${description} must be a regular non-symlink directory`);
  }
}

function canonicalPath(candidate, description) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    stop(EXIT_INPUT, `${description} cannot be resolved`);
  }
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function requireTrustedUserOwnedPath(candidate, description) {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) {
    stop(EXIT_INPUT, `${description} cannot be a symbolic link`);
  }
  if (process.platform !== "win32") {
    const currentUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUserId !== undefined && stat.uid !== currentUserId) {
      stop(EXIT_INPUT, `${description} must be owned by the current OS account`);
    }
    if ((stat.mode & 0o022) !== 0) {
      stop(EXIT_INPUT, `${description} cannot be group- or world-writable`);
    }
  }
  return stat;
}

function sameFileIdentity(before, after) {
  return before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function timeoutMs() {
  const value = process.env.BYOM_DAG_FUSION_TIMEOUT_MS;
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(value)) {
    stop(EXIT_USAGE, "BYOM_DAG_FUSION_TIMEOUT_MS must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 600_000) {
    stop(EXIT_USAGE, "verification timeout must be at most 600000 milliseconds");
  }
  return parsed;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    timeout: options.timeout ?? timeoutMs(),
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    stop(EXIT_TIMEOUT, `${options.description ?? path.basename(command)} timed out`);
  }
  if (result.error) {
    stop(EXIT_UNAVAILABLE, `${options.description ?? path.basename(command)} failed: ${result.error.message}`);
  }
  return result;
}

function requireSuccess(result, code, description) {
  if (result.status === 0) return;
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  stop(code, `${description} failed with exit ${String(result.status)}`);
}

const [sourceArgument, theoremName, projectArgument, ...extraArguments] = process.argv.slice(2);
if (!sourceArgument || !theoremName || !projectArgument || extraArguments.length > 0) {
  stop(
    EXIT_USAGE,
    "usage: <trusted-kady-node> verify-lean4.mjs <source.lean> <theorem-name> <lake-project-dir>",
  );
}
if (!sourceArgument.endsWith(".lean")) {
  stop(EXIT_REJECTED, "source file must end in .lean");
}

regularFile(sourceArgument, "source");
regularDirectory(projectArgument, "Lake project");
const sourcePath = canonicalPath(sourceArgument, "source");
const projectPath = canonicalPath(projectArgument, "Lake project");

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scanScript = path.join(scriptDirectory, "scan-lean-source.mjs");
const inspectScript = path.join(scriptDirectory, "inspect-lake-project.mjs");
const checkAxiomsScript = path.join(scriptDirectory, "check-lean-axioms.mjs");
const scan = run(process.execPath, [scanScript, sourcePath, theoremName], {
  description: "source admission",
});
requireSuccess(scan, EXIT_REJECTED, "source admission");

const toolchainFile = path.join(projectPath, "lean-toolchain");
regularFile(toolchainFile, "lean-toolchain pin");
const lakefileToml = path.join(projectPath, "lakefile.toml");
const lakefileLean = path.join(projectPath, "lakefile.lean");
if (!fs.existsSync(lakefileToml) && !fs.existsSync(lakefileLean)) {
  stop(EXIT_UNAVAILABLE, "Lake project has no lakefile.toml or lakefile.lean");
}
regularFile(fs.existsSync(lakefileToml) ? lakefileToml : lakefileLean, "Lake project file");
const manifestFile = path.join(projectPath, "lake-manifest.json");
regularFile(manifestFile, "lake-manifest.json");

const toolchainLines = fs.readFileSync(toolchainFile, "utf8").split(/\r?\n/).filter(Boolean);
if (
  toolchainLines.length !== 1 ||
  !/^leanprover\/lean4:v[0-9]+\.[0-9]+\.[0-9]+$/.test(toolchainLines[0])
) {
  stop(EXIT_UNAVAILABLE, "lean-toolchain must pin one stable Lean release tag");
}
const toolchain = toolchainLines[0];

if (
  Object.prototype.hasOwnProperty.call(process.env, "BYOM_DAG_FUSION_ELAN_HOME") ||
  Object.prototype.hasOwnProperty.call(process.env, "ELAN_HOME")
) {
  stop(
    EXIT_INPUT,
    "task-controlled Elan overrides are not accepted; use the current OS account's canonical .elan installation",
  );
}
let accountHome;
try {
  accountHome = os.userInfo().homedir;
} catch {
  stop(EXIT_UNAVAILABLE, "the current OS account home cannot be resolved");
}
if (!path.isAbsolute(accountHome)) {
  stop(EXIT_UNAVAILABLE, "the current OS account home must be absolute");
}
const configuredElanHome = path.join(accountHome, ".elan");
regularDirectory(configuredElanHome, "canonical Elan home");
requireTrustedUserOwnedPath(configuredElanHome, "canonical Elan home");
const elanHome = canonicalPath(configuredElanHome, "canonical Elan home");
if (elanHome !== configuredElanHome) {
  stop(EXIT_INPUT, "canonical Elan home cannot resolve through a symbolic link");
}
if (isWithin(projectPath, elanHome)) {
  stop(EXIT_INPUT, "Elan home cannot be controlled by the Lake project");
}
const elanBinDirectory = path.join(elanHome, "bin");
regularDirectory(elanBinDirectory, "canonical Elan bin directory");
requireTrustedUserOwnedPath(elanBinDirectory, "canonical Elan bin directory");
const elanBinary = path.join(elanHome, "bin", process.platform === "win32" ? "elan.exe" : "elan");
regularFile(elanBinary, "Elan binary");
const elanIdentity = requireTrustedUserOwnedPath(elanBinary, "Elan binary");
const canonicalElanBinary = canonicalPath(elanBinary, "Elan binary");
if (canonicalElanBinary !== elanBinary) {
  stop(EXIT_INPUT, "Elan binary cannot resolve through a symbolic link");
}
try {
  fs.accessSync(elanBinary, fs.constants.X_OK);
} catch {
  stop(EXIT_UNAVAILABLE, "Elan binary is not executable");
}
const elanSha256 = sha256File(elanBinary);
const trustedElanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    !name.startsWith("BYOM_DAG_FUSION_") &&
    !name.startsWith("ELAN_") &&
    !name.startsWith("LEAN_") &&
    !name.startsWith("LAKE_")
  ),
);
trustedElanEnvironment.HOME = accountHome;
trustedElanEnvironment.ELAN_HOME = elanHome;

const toolchains = run(elanBinary, ["toolchain", "list"], {
  description: "Elan toolchain inventory",
  env: trustedElanEnvironment,
});
requireSuccess(toolchains, EXIT_UNAVAILABLE, "Elan toolchain inventory");
const installedToolchains = toolchains.stdout
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/, 1)[0])
  .filter(Boolean);
if (!installedToolchains.includes(toolchain)) {
  stop(EXIT_UNAVAILABLE, `pinned toolchain ${toolchain} is not installed; no download was attempted`);
}

const mathlibDirectory = path.join(projectPath, ".lake", "packages", "mathlib");
const inspect = run(process.execPath, [inspectScript, manifestFile, mathlibDirectory], {
  description: "Mathlib pin inspection",
});
requireSuccess(inspect, EXIT_UNAVAILABLE, "Mathlib pin inspection");
const mathlibRevision = inspect.stdout.trim();

const lakeVersion = run(elanBinary, ["run", toolchain, "lake", "--version"], {
  cwd: projectPath,
  description: "pinned Lake version",
  env: trustedElanEnvironment,
});
requireSuccess(lakeVersion, EXIT_UNAVAILABLE, "pinned Lake version");

const auditDirectory = fs.mkdtempSync(path.join(projectPath, ".byom-lean-audit-"));
const auditFile = path.join(auditDirectory, "Audit.lean");
const outputFile = path.join(auditDirectory, "lean-output.log");
const marker = `BYOM_${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
try {
  const source = fs.readFileSync(sourcePath, "utf8");
  const audit = [
    source,
    "",
    `#check ${theoremName}`,
    `#eval IO.println \"${marker}_BEGIN\"`,
    `#print ${theoremName}`,
    `#print axioms ${theoremName}`,
    `#eval IO.println \"${marker}_END\"`,
    "",
  ].join("\n");
  fs.writeFileSync(auditFile, audit, { encoding: "utf8", mode: 0o600 });

  const verification = run(
    elanBinary,
    ["run", toolchain, "lake", "env", "lean", auditFile],
    { cwd: projectPath, description: "Lean verification", env: trustedElanEnvironment },
  );
  fs.writeFileSync(outputFile, `${verification.stdout}${verification.stderr}`, {
    encoding: "utf8",
    mode: 0o600,
  });
  requireSuccess(verification, EXIT_REJECTED, "Lean verification");

  const axiomCheck = run(
    process.execPath,
    [checkAxiomsScript, outputFile, theoremName, marker],
    { description: "Lean axiom audit" },
  );
  requireSuccess(axiomCheck, EXIT_REJECTED, "Lean axiom audit");

  let finalElanIdentity;
  try {
    finalElanIdentity = fs.lstatSync(elanBinary);
  } catch {
    stop(EXIT_INPUT, "Elan binary changed during verification");
  }
  if (
    !sameFileIdentity(elanIdentity, finalElanIdentity) ||
    sha256File(elanBinary) !== elanSha256
  ) {
    stop(EXIT_INPUT, "Elan binary changed during verification");
  }

  process.stdout.write(`byom-dag-fusion: project=${projectPath}\n`);
  process.stdout.write(`byom-dag-fusion: source=${sourcePath}\n`);
  process.stdout.write(`byom-dag-fusion: theorem=${theoremName}\n`);
  process.stdout.write(`byom-dag-fusion: toolchain=${toolchain}\n`);
  process.stdout.write(`byom-dag-fusion: mathlib_revision=${mathlibRevision}\n`);
  process.stdout.write(`byom-dag-fusion: elan_path=${elanBinary}\n`);
  process.stdout.write(`byom-dag-fusion: elan_sha256=${elanSha256}\n`);
  process.stdout.write(lakeVersion.stdout);
  process.stdout.write(verification.stdout);
  process.stdout.write(axiomCheck.stdout);
} finally {
  fs.rmSync(auditDirectory, { recursive: true, force: true });
}
