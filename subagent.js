#!/usr/bin/env node

// subagent.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync as readdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { spawnSync as spawnSync2 } from "node:child_process";
import { dirname as dirname2, join as join2, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// shared.ts
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
function getRunsDir() {
  return join(getAgentDir(), "subagents");
}
var DEFAULT_EXIT_KEY = "ctrl+q";
var CHOICE_FIELDS = ["provider", "model", "thinking"];
var CONFIG_FILE_NAME = "subagents.json";
function modelChoice(value) {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value;
  const choice = {};
  for (const field of CHOICE_FIELDS) {
    const fieldValue = record[field];
    if (typeof fieldValue === "string" && fieldValue.length > 0) {
      choice[field] = fieldValue;
    }
  }
  return choice;
}
function sanitizeConfig(value) {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value;
  const config = {};
  if (typeof record.exitKey === "string" && record.exitKey.trim().length > 0) {
    config.exitKey = record.exitKey;
  }
  if (record.defaults !== undefined) {
    config.defaults = modelChoice(record.defaults);
  }
  if (typeof record.presets === "object" && record.presets !== null) {
    const presets = {};
    for (const [name, choice] of Object.entries(record.presets)) {
      presets[name] = modelChoice(choice);
    }
    config.presets = presets;
  }
  return config;
}
function readConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      process.stderr.write(`Warning: cannot read ${path}: ${String(error)}
`);
    }
    return {};
  }
  try {
    return sanitizeConfig(JSON.parse(raw));
  } catch (error) {
    process.stderr.write(`Warning: ignoring ${path}: ${String(error)}
`);
    return {};
  }
}
function configSources(cwd) {
  const userPath = join(getAgentDir(), CONFIG_FILE_NAME);
  const projectPath = join(cwd, ".pi", CONFIG_FILE_NAME);
  return [
    { path: userPath, config: readConfig(userPath) },
    { path: projectPath, config: readConfig(projectPath) }
  ];
}
function mergeConfigs(sources) {
  const merged = {};
  for (const { config } of sources) {
    if (config.exitKey !== undefined) {
      merged.exitKey = config.exitKey;
    }
    if (config.defaults !== undefined) {
      merged.defaults = { ...merged.defaults, ...config.defaults };
    }
    if (config.presets !== undefined) {
      merged.presets = { ...merged.presets, ...config.presets };
    }
  }
  return merged;
}
function loadConfig(cwd) {
  return mergeConfigs(configSources(cwd));
}
function metadataPath(runDir) {
  return join(runDir, "metadata.json");
}
function inboxDir(runDir) {
  return join(runDir, "inbox");
}
function queueInboxMessage(runDir, payload) {
  const queueDir = inboxDir(runDir);
  mkdirSync(queueDir, { recursive: true, mode: 448 });
  const target = join(queueDir, `${Date.now()}-${randomBytes(4).toString("hex")}.json`);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload)}
`, { encoding: "utf8", mode: 384 });
  renameSync(temporary, target);
}
function isValidRunName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function runDisplayName(metadata) {
  return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}
function readMetadata(runDir) {
  try {
    const value = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
    if (typeof value !== "object" || value === null)
      return;
    const metadata = value;
    if (metadata.version !== 1 || typeof metadata.handle !== "string" || metadata.name !== undefined && !isValidRunName(metadata.name) || typeof metadata.tmuxSession !== "string" || typeof metadata.sessionFile !== "string" || typeof metadata.runDir !== "string") {
      return;
    }
    return metadata;
  } catch {
    return;
  }
}
function writeMetadata(metadata) {
  mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 448 });
  const target = metadataPath(metadata.runDir);
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}
`, { encoding: "utf8", mode: 384 });
  renameSync(temporary, target);
}
function updateMetadata(runDir, patch) {
  const current = readMetadata(runDir);
  if (!current)
    return;
  const next = {
    ...current,
    ...patch,
    version: 1,
    handle: current.handle,
    runDir: current.runDir,
    updatedAt: new Date().toISOString()
  };
  writeMetadata(next);
  return next;
}
async function waitForRunShutdown(runDir, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metadata = readMetadata(runDir);
    if (!metadata || metadata.state === "exited")
      return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}
function removeRunDir(runDir) {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
function tmuxSessionExists(session) {
  return spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
}
function launchRun(metadata, initialArgs = []) {
  let launcher = "pi";
  const testLauncher = join(metadata.cwd, "pi-test.sh");
  try {
    accessSync(testLauncher, constants.X_OK);
    launcher = testLauncher;
  } catch {}
  const result = spawnSync("tmux", [
    "new-session",
    "-d",
    "-s",
    metadata.tmuxSession,
    "-x",
    "120",
    "-y",
    "40",
    "-c",
    metadata.cwd,
    "--",
    "env",
    `PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
    `PI_SUBAGENT_EXIT_KEY=${loadConfig(metadata.cwd).exitKey ?? DEFAULT_EXIT_KEY}`,
    launcher,
    "--session",
    metadata.sessionFile,
    "--provider",
    metadata.provider,
    "--model",
    metadata.model,
    "--thinking",
    metadata.thinking,
    ...metadata.launchArgs ?? [],
    ...initialArgs
  ], { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || "Failed to create tmux session");
}
function effectiveRunState(metadata) {
  if ((metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") && !tmuxSessionExists(metadata.tmuxSession)) {
    return "exited";
  }
  return metadata.state;
}
function listRuns(parentSessionId) {
  const root = getRunsDir();
  if (!existsSync(root))
    return [];
  const runs = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory())
      continue;
    const metadata = readMetadata(join(root, entry.name));
    if (!metadata)
      continue;
    if (parentSessionId && metadata.parentSessionId !== parentSessionId)
      continue;
    runs.push(metadata);
  }
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function isSessionEntry(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const entry = value;
  return typeof entry.type === "string" && typeof entry.id === "string" && (entry.parentId === null || typeof entry.parentId === "string");
}
function activeBranch(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = [];
  const seen = new Set;
  let current = entries.at(-1);
  while (current && !seen.has(current.id)) {
    branch.push(current);
    seen.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return branch.reverse();
}
function isAssistantEntry(entry) {
  if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null)
    return false;
  return entry.message.role === "assistant";
}
function readLatestAssistant(sessionFile) {
  let content;
  try {
    content = readFileSync(sessionFile, "utf8");
  } catch {
    return;
  }
  const entries = [];
  for (const line of content.split(`
`)) {
    if (!line.trim())
      continue;
    try {
      const value = JSON.parse(line);
      if (isSessionEntry(value))
        entries.push(value);
    } catch {}
  }
  return activeBranch(entries).findLast(isAssistantEntry)?.message;
}
function assistantText(message) {
  if (!Array.isArray(message.content))
    return message.errorMessage ?? "(no response text)";
  const parts = [];
  for (const item of message.content) {
    if (typeof item !== "object" || item === null)
      continue;
    const block = item;
    if (block.type === "text" && typeof block.text === "string")
      parts.push(block.text);
  }
  return parts.join(`
`).trim() || message.errorMessage || "(no response text)";
}

// subagent.ts
var VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
var BUILTIN_EXTENSION_PREFIX = "builtin:";
var DEFAULT_THINKING = "medium";
var ENV_VARS = {
  provider: "PI_PROVIDER",
  model: "PI_MODEL",
  thinking: "PI_REASONING_LEVEL"
};
var extensionPath = join2(dirname2(fileURLToPath(import.meta.url)), "index.ts");
function fail(message) {
  throw new Error(message);
}
function usage() {
  fail(`Usage:
  subagent spawn [--name <name>] [--preset <name>] [--provider <provider>] [--model <model>]
    [--thinking <level>] [--cwd <dir>] [--tools <names>] [--no-extensions]
    [--extension <path|builtin:name>]... [--no-skills] [--no-prompt-templates] [--no-context-files]
    (--prompt <text> | --file <path>)...
  subagent status <handle>
  subagent rename <handle> <name>
  subagent send <handle> [--follow-up] <message>
  subagent interrupt <handle>
  subagent wait <handle> [--timeout <seconds>]
  subagent stop <handle>
  subagent list

Config: $PI_CODING_AGENT_DIR/subagents.json (~/.pi/agent), then <cwd>/.pi/subagents.json;
  the project file wins. Fields: defaults {provider, model, thinking}, presets.<name>, exitKey.`);
}
function valueAfter(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    fail(`${option} requires a value`);
  return value;
}
function normalizeRunName(value) {
  const name = value.trim();
  if (!isValidRunName(name))
    fail("Subagent name must be a single line of 1 to 64 characters");
  return name;
}
function normalizeExtension(value) {
  if (value.startsWith(BUILTIN_EXTENSION_PREFIX)) {
    if (value.length === BUILTIN_EXTENSION_PREFIX.length)
      fail("builtin: requires an extension name");
    return value;
  }
  const path = resolve(value);
  if (!existsSync2(path))
    fail(`Extension not found: ${value}`);
  return path;
}
function runDirForHandle(handle) {
  if (!/^[a-z0-9]+$/.test(handle))
    fail(`Invalid subagent handle: ${handle}`);
  return join2(getRunsDir(), handle);
}
function getRun(handle) {
  const metadata = readMetadata(runDirForHandle(handle));
  if (!metadata)
    fail(`Unknown subagent: ${handle}`);
  return metadata;
}
function generateHandle() {
  mkdirSync2(getRunsDir(), { recursive: true, mode: 448 });
  for (let attempt = 0;attempt < 100; attempt++) {
    const handle = randomBytes2(3).toString("hex");
    if (!existsSync2(runDirForHandle(handle)))
      return handle;
  }
  fail("Could not allocate a unique subagent handle");
}
function resolvePreset(config, name) {
  if (name === undefined) {
    return;
  }
  const choice = config.presets?.[name];
  if (choice) {
    return { name, choice };
  }
  const available = Object.keys(config.presets ?? {}).sort();
  const hint = available.length > 0 ? ` Available: ${available.join(", ")}` : " No presets defined";
  fail(`Unknown preset: ${name}.${hint}`);
}
function defaultsOrigin(sources, field) {
  for (let index = sources.length - 1;index >= 0; index--) {
    if (sources[index].config.defaults?.[field] !== undefined) {
      return sources[index].path;
    }
  }
  return "config defaults";
}
function resolveChoice(flags, preset, config, sources) {
  const resolved = {};
  for (const field of CHOICE_FIELDS) {
    const presetValue = preset?.choice[field];
    if (presetValue) {
      resolved[field] = { value: presetValue, from: `preset "${preset?.name}"` };
      continue;
    }
    const flagValue = flags[field];
    if (flagValue) {
      resolved[field] = { value: flagValue, from: `--${field}` };
      continue;
    }
    const configValue = config.defaults?.[field];
    if (configValue) {
      resolved[field] = { value: configValue, from: defaultsOrigin(sources, field) };
      continue;
    }
    const envName = ENV_VARS[field];
    const envValue = process.env[envName];
    resolved[field] = envValue ? { value: envValue, from: `$${envName}` } : {};
  }
  return resolved;
}
function spawnSubagent(args) {
  if (process.env.PI_SUBAGENT_RUN_DIR)
    fail("Nested subagents are disabled");
  let name;
  let presetName;
  const flags = {};
  let cwd = process.cwd();
  let tools;
  let noExtensions = false;
  let noSkills = false;
  let noPromptTemplates = false;
  let noContextFiles = false;
  const prompts = [];
  const files = [];
  const extensions = [];
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--name":
        name = normalizeRunName(valueAfter(args, i, arg));
        i++;
        break;
      case "--preset":
        presetName = valueAfter(args, i, arg);
        i++;
        break;
      case "--provider":
        flags.provider = valueAfter(args, i, arg);
        i++;
        break;
      case "--model":
        flags.model = valueAfter(args, i, arg);
        i++;
        break;
      case "--thinking":
        flags.thinking = valueAfter(args, i, arg);
        i++;
        break;
      case "--cwd":
        cwd = resolve(valueAfter(args, i, arg));
        i++;
        break;
      case "--tools":
        tools = valueAfter(args, i, arg);
        i++;
        break;
      case "--no-extensions":
        noExtensions = true;
        break;
      case "--extension":
        extensions.push(normalizeExtension(valueAfter(args, i, arg)));
        i++;
        break;
      case "--no-skills":
        noSkills = true;
        break;
      case "--no-prompt-templates":
        noPromptTemplates = true;
        break;
      case "--no-context-files":
        noContextFiles = true;
        break;
      case "--prompt":
        prompts.push(valueAfter(args, i, arg));
        i++;
        break;
      case "--file": {
        const file = resolve(valueAfter(args, i, arg));
        if (!existsSync2(file))
          fail(`File not found: ${file}`);
        files.push(file);
        i++;
        break;
      }
      default:
        fail(`Unknown spawn argument: ${arg}`);
    }
  }
  const sources = configSources(cwd);
  const config = mergeConfigs(sources);
  const preset = resolvePreset(config, presetName);
  const resolved = resolveChoice(flags, preset, config, sources);
  const provider = resolved.provider.value;
  const model = resolved.model.value;
  const thinking = resolved.thinking.value ?? DEFAULT_THINKING;
  if (!provider)
    fail("No provider specified: pass --provider, a preset, config defaults, or PI_PROVIDER");
  if (!model)
    fail("No model specified: pass --model, a preset, config defaults, or PI_MODEL");
  if (!VALID_THINKING_LEVELS.has(thinking)) {
    fail(`Invalid thinking level: ${thinking} (from ${resolved.thinking.from ?? "builtin default"})`);
  }
  if (tools !== undefined && !tools.split(",").some((name2) => name2.trim()))
    fail("--tools requires at least one tool name");
  if (prompts.length === 0 && files.length === 0)
    fail("spawn requires at least one --prompt or --file");
  if (!existsSync2(cwd))
    fail(`Working directory not found: ${cwd}`);
  const handle = generateHandle();
  const runDir = runDirForHandle(handle);
  const sessionFile = join2(runDir, "session.jsonl");
  const tmuxSession = `pi-subagent-${handle}`;
  mkdirSync2(inboxDir(runDir), { recursive: true, mode: 448 });
  writeFileSync2(sessionFile, "", { mode: 384 });
  const launchArgs = [];
  if (tools)
    launchArgs.push("--tools", tools);
  if (noExtensions)
    launchArgs.push("--no-extensions", "--extension", extensionPath);
  for (const extension of extensions)
    launchArgs.push("--extension", extension);
  if (noSkills)
    launchArgs.push("--no-skills");
  if (noPromptTemplates)
    launchArgs.push("--no-prompt-templates");
  if (noContextFiles)
    launchArgs.push("--no-context-files");
  const now = new Date().toISOString();
  const metadata = {
    version: 1,
    handle,
    name,
    parentSessionId: process.env.PI_SESSION_ID || undefined,
    parentSessionFile: process.env.PI_SESSION_FILE || undefined,
    tmuxSession,
    runDir,
    sessionFile,
    cwd,
    provider,
    model,
    thinking,
    launchArgs,
    state: "starting",
    hasStarted: false,
    createdAt: now,
    updatedAt: now
  };
  writeMetadata(metadata);
  const initialArgs = files.map((file) => `@${file}`);
  if (prompts.length > 0)
    initialArgs.push(`Task:
${prompts.join(`

`)}`);
  try {
    launchRun(metadata, initialArgs);
  } catch (error) {
    removeRunDir(runDir);
    throw error;
  }
  process.stdout.write(`Spawned ${runDisplayName(metadata)}
State: busy
Attach: tmux attach -t ${tmuxSession}
`);
}
function statusSubagent(args) {
  if (args.length !== 1)
    usage();
  const metadata = getRun(args[0]);
  process.stdout.write(`${runDisplayName(metadata)}: ${effectiveRunState(metadata)} (${metadata.provider}/${metadata.model}, ${metadata.thinking})
Attach: tmux attach -t ${metadata.tmuxSession}
`);
}
function renameSubagent(args) {
  if (args.length !== 2)
    usage();
  const metadata = getRun(args[0]);
  const name = normalizeRunName(args[1]);
  const updated = updateMetadata(metadata.runDir, { name });
  if (!updated)
    fail(`Could not rename subagent: ${metadata.handle}`);
  process.stdout.write(`Renamed ${runDisplayName(updated)}
`);
}
function sendSubagent(args) {
  const handle = args.shift();
  if (!handle)
    usage();
  let followUp = false;
  const messageParts = [];
  for (const arg of args) {
    if (arg === "--follow-up")
      followUp = true;
    else if (arg.startsWith("--"))
      fail(`Unknown send argument: ${arg}`);
    else
      messageParts.push(arg);
  }
  const message = messageParts.join(" ").trim();
  if (!message)
    fail("send requires a message");
  const metadata = getRun(handle);
  if (!tmuxSessionExists(metadata.tmuxSession))
    fail(`${handle} is not running`);
  queueInboxMessage(metadata.runDir, { kind: "message", message, delivery: followUp ? "followUp" : "auto" });
  const state = effectiveRunState(metadata);
  const verb = followUp && state === "busy" ? "Queued follow-up for" : state === "idle" ? "Prompted" : "Steered";
  process.stdout.write(`${verb} ${runDisplayName(metadata)}
`);
}
function interruptSubagent(args) {
  if (args.length !== 1)
    usage();
  const metadata = getRun(args[0]);
  if (!tmuxSessionExists(metadata.tmuxSession))
    fail(`${metadata.handle} is not running`);
  queueInboxMessage(metadata.runDir, { kind: "interrupt" });
  process.stdout.write(`Interrupted ${runDisplayName(metadata)}
`);
}
function parseTimeout(args) {
  if (args.length === 0)
    return 1800;
  if (args.length !== 2 || args[0] !== "--timeout")
    usage();
  const timeout = Number(args[1]);
  if (!Number.isInteger(timeout) || timeout <= 0)
    fail("--timeout must be a positive integer");
  return timeout;
}
async function waitSubagent(args) {
  const handle = args.shift();
  if (!handle)
    usage();
  const timeoutSeconds = parseTimeout(args);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const metadata = getRun(handle);
    const pending = existsSync2(inboxDir(metadata.runDir)) ? readdirSync2(inboxDir(metadata.runDir)).some((file) => file.endsWith(".json")) : false;
    const state = effectiveRunState(metadata);
    if (state === "error")
      fail(metadata.error || `${handle} failed`);
    if (state === "exited")
      fail(`${handle} exited before finishing`);
    if (metadata.hasStarted && state === "idle" && !pending) {
      const message = readLatestAssistant(metadata.sessionFile);
      if (!message)
        fail(`${handle} finished without an assistant response`);
      process.stdout.write(`${handle} finished

${assistantText(message)}
`);
      if (message.stopReason === "error" || message.stopReason === "aborted")
        process.exitCode = 1;
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}
async function stopSubagent(args) {
  if (args.length !== 1)
    usage();
  const metadata = getRun(args[0]);
  const wasRunning = tmuxSessionExists(metadata.tmuxSession);
  spawnSync2("tmux", ["kill-session", "-t", metadata.tmuxSession], { stdio: "ignore" });
  if (wasRunning)
    await waitForRunShutdown(metadata.runDir);
  removeRunDir(metadata.runDir);
  process.stdout.write(`Stopped ${runDisplayName(metadata)}
`);
}
function listSubagents(args) {
  if (args.length !== 0)
    usage();
  const runs = listRuns(process.env.PI_SESSION_ID || undefined);
  if (runs.length === 0) {
    process.stdout.write(`No subagents
`);
    return;
  }
  for (const metadata of runs) {
    process.stdout.write(`${runDisplayName(metadata)}  ${effectiveRunState(metadata).padEnd(8)}  ${metadata.provider}/${metadata.model}  ${metadata.thinking}
`);
  }
}
async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  switch (command) {
    case "spawn":
      spawnSubagent(args);
      break;
    case "status":
      statusSubagent(args);
      break;
    case "rename":
      renameSubagent(args);
      break;
    case "send":
      sendSubagent(args);
      break;
    case "interrupt":
      interruptSubagent(args);
      break;
    case "wait":
      await waitSubagent(args);
      break;
    case "stop":
      await stopSubagent(args);
      break;
    case "list":
      listSubagents(args);
      break;
    default:
      usage();
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
});
