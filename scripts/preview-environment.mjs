import path from "node:path";

const LEGACY_ENGINE_ENVIRONMENT_NAMES = [
  "ARCHON_BASE_URL",
  "NEXT_PUBLIC_ARCHON_URL",
  "KADY_ARCHON_PORT",
];

export function previewEnvironment(
  stateRoot,
  launchRoot,
  shimDirectory,
  ports,
  ambientEnvironment = process.env,
) {
  const environment = { ...ambientEnvironment };
  for (const name of Object.keys(environment)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) delete environment[name];
  }
  for (const name of LEGACY_ENGINE_ENVIRONMENT_NAMES) delete environment[name];

  const piAgentDirectory = path.join(stateRoot, "pi-agent");
  const pipelineEngineUrl = `http://127.0.0.1:${ports.engine}`;
  return {
    ...environment,
    PATH: `${shimDirectory}${path.delimiter}${environment.PATH ?? ""}`,
    KADY_PREVIEW: "1",
    KADY_PORT: String(ports.backend),
    KADY_FRONTEND_PORT: String(ports.frontend),
    KADY_PIPELINE_ENGINE_PORT: String(ports.engine),
    PIPELINE_ENGINE_BASE_URL: pipelineEngineUrl,
    NEXT_PUBLIC_PIPELINE_ENGINE_URL: pipelineEngineUrl,
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
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    KADY_PREVIEW_LAUNCH_ROOT: launchRoot,
  };
}
