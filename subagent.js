#!/usr/bin/env node

// subagent.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
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
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { connect, createServer } from "node:net";
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
var RUN_FILE = "run.json";
var STATUS_FILE = "status.json";
var VIEW_FILE = "view.json";
var LOCK_FILE = "alive.sock";
var LOCK_PROBE_TIMEOUT_MS = 250;
var LOCK_RELEASE_POLL_MS = 50;
var LOCK_RELEASE_TIMEOUT_MS = 3000;
var START_GRACE_MS = 60000;
var DAY_MS = 86400000;
var TRASH_DIR = ".trash";
function lockPath(runDir) {
  return join(runDir, LOCK_FILE);
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, { encoding: "utf8", mode: 384 });
  renameSync(temporary, path);
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
  return target;
}
function isValidRunName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function parseDescriptor(value) {
  if (typeof value !== "object" || value === null)
    return;
  const descriptor = value;
  if (descriptor.version !== 1 || typeof descriptor.handle !== "string" || descriptor.name !== undefined && !isValidRunName(descriptor.name) || typeof descriptor.tmuxSession !== "string" || typeof descriptor.sessionFile !== "string" || typeof descriptor.runDir !== "string" || typeof descriptor.createdAt !== "string") {
    return;
  }
  return descriptor;
}
var RUN_STATES = new Set(["starting", "busy", "idle", "exited", "interrupted", "crashed", "error"]);
function parseStatus(value) {
  if (typeof value !== "object" || value === null)
    return;
  const status = value;
  if (status.version !== 1 || typeof status.state !== "string" || !RUN_STATES.has(status.state)) {
    return;
  }
  return {
    version: 1,
    state: status.state,
    hasStarted: status.hasStarted === true,
    childSessionId: typeof status.childSessionId === "string" ? status.childSessionId : undefined,
    updatedAt: typeof status.updatedAt === "string" ? status.updatedAt : new Date(0).toISOString(),
    error: typeof status.error === "string" ? status.error : undefined
  };
}
function initialStatus(descriptor) {
  return {
    version: 1,
    state: "starting",
    hasStarted: false,
    updatedAt: descriptor.createdAt
  };
}

class Run {
  descriptor;
  status;
  view;
  constructor(descriptor, status, view) {
    this.descriptor = descriptor;
    this.status = status;
    this.view = view;
  }
  static load(runDir) {
    const descriptor = parseDescriptor(readJson(join(runDir, RUN_FILE)));
    if (!descriptor)
      return;
    const status = parseStatus(readJson(join(runDir, STATUS_FILE)));
    const view = readJson(join(runDir, VIEW_FILE));
    return new Run(descriptor, status ?? initialStatus(descriptor), view ?? {});
  }
  static create(descriptor) {
    const run = new Run(descriptor, initialStatus(descriptor), {});
    writeJson(join(descriptor.runDir, RUN_FILE), descriptor);
    run.writeStatus();
    return run;
  }
  static find(handle) {
    return Run.load(join(getRunsDir(), handle));
  }
  static list(parentSessionId) {
    const root = getRunsDir();
    if (!existsSync(root))
      return [];
    const runs = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("."))
        continue;
      const run = Run.load(join(root, entry.name));
      if (!run)
        continue;
      if (parentSessionId && run.parentSessionId !== parentSessionId)
        continue;
      runs.push(run);
    }
    return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  get dir() {
    return this.descriptor.runDir;
  }
  get handle() {
    return this.descriptor.handle;
  }
  get name() {
    return this.descriptor.name;
  }
  get displayName() {
    return this.name ? `${this.name} (${this.handle})` : this.handle;
  }
  get sessionFile() {
    return this.descriptor.sessionFile;
  }
  get tmuxSession() {
    return this.descriptor.tmuxSession;
  }
  get cwd() {
    return this.descriptor.cwd;
  }
  get provider() {
    return this.descriptor.provider;
  }
  get model() {
    return this.descriptor.model;
  }
  get thinking() {
    return this.descriptor.thinking;
  }
  get parentSessionId() {
    return this.descriptor.parentSessionId;
  }
  get createdAt() {
    return this.descriptor.createdAt;
  }
  get inboxDir() {
    return inboxDir(this.dir);
  }
  get exitArgv() {
    return this.view.exitArgv;
  }
  get state() {
    return this.status.state;
  }
  get hasStarted() {
    return this.status.hasStarted;
  }
  get updatedAt() {
    return this.status.updatedAt;
  }
  get error() {
    return this.status.error;
  }
  updateStatus(patch) {
    this.status = { ...this.status, ...patch, version: 1, updatedAt: new Date().toISOString() };
    this.writeStatus();
  }
  updateDescriptor(patch) {
    this.descriptor = { ...this.descriptor, ...patch, version: 1, handle: this.handle, runDir: this.dir };
    writeJson(join(this.dir, RUN_FILE), this.descriptor);
  }
  attach(exitArgv) {
    this.view = { exitArgv };
    writeJson(join(this.dir, VIEW_FILE), this.view);
  }
  launch(initialArgs = []) {
    launchProcess(this.descriptor, initialArgs);
  }
  queue(payload) {
    return queueInboxMessage(this.dir, payload);
  }
  lock() {
    return holdLock(this.dir);
  }
  unlock() {
    releaseLock(this.dir);
  }
  alive() {
    return isAlive(this.dir);
  }
  waitForShutdown(timeoutMs) {
    return waitForRunShutdown(this.dir, timeoutMs);
  }
  trash() {
    return moveToTrash(this.dir);
  }
  async inspect() {
    const alive = await this.alive();
    return { run: this, alive, state: this.snapshotState(alive) };
  }
  async reconcile() {
    const snapshot = await this.inspect();
    if (snapshot.alive)
      return { ...snapshot, action: "none" };
    if (snapshot.state !== "starting") {
      rmSync(lockPath(this.dir), { force: true });
    }
    if (this.isZeroValue() && snapshot.state !== "starting") {
      this.trash();
      return { ...snapshot, action: "trashed" };
    }
    if (snapshot.state === this.state)
      return { ...snapshot, action: "none" };
    const previous = this.state;
    const action = snapshot.state === "crashed" ? "crashed" : "exited";
    this.updateStatus({
      state: action,
      error: action === "crashed" ? `Process exited while ${previous}` : this.error
    });
    return { ...snapshot, action };
  }
  writeStatus() {
    writeJson(join(this.dir, STATUS_FILE), this.status);
  }
  snapshotState(alive) {
    if (alive)
      return this.state;
    if (this.state === "error")
      return "error";
    if (this.state === "starting" && Date.now() - Date.parse(this.updatedAt) < START_GRACE_MS) {
      return "starting";
    }
    if (this.state === "interrupted")
      return "interrupted";
    if (this.state === "busy" || this.state === "starting")
      return "crashed";
    if (this.state === "crashed")
      return "crashed";
    return "exited";
  }
  hasTranscript() {
    try {
      return statSync(this.sessionFile).size > 0;
    } catch {
      return false;
    }
  }
  hasInbox() {
    try {
      return readdirSync(this.inboxDir).some((file) => file.endsWith(".json"));
    } catch {
      return false;
    }
  }
  isZeroValue() {
    return !this.hasStarted && !this.hasTranscript() && !this.hasInbox();
  }
}
async function reconcileAll(parentSessionId) {
  const results = [];
  for (const run of Run.list(parentSessionId)) {
    results.push(await run.reconcile());
  }
  return results;
}
function isAlive(runDir) {
  return new Promise((resolveAlive) => {
    const client = connect(lockPath(runDir));
    let settled = false;
    const finish = (alive) => {
      if (settled)
        return;
      settled = true;
      client.destroy();
      resolveAlive(alive);
    };
    client.setTimeout(LOCK_PROBE_TIMEOUT_MS, () => finish(false));
    client.once("connect", () => finish(true));
    client.once("error", () => finish(false));
  });
}
var LOCK_REGISTRY = Symbol.for("pi-subagent.locks");
function lockRegistry() {
  const global = globalThis;
  if (global[LOCK_REGISTRY] instanceof Map)
    return global[LOCK_REGISTRY];
  const registry = new Map;
  global[LOCK_REGISTRY] = registry;
  return registry;
}
function listen(path) {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", rejectListen);
    server.listen(path, () => {
      server.removeListener("error", rejectListen);
      resolveListen(server);
    });
  });
}
async function holdLock(runDir) {
  const path = lockPath(runDir);
  const registry = lockRegistry();
  if (registry.has(path))
    return;
  if (existsSync(path) && !await isAlive(runDir)) {
    rmSync(path, { force: true });
  }
  const server = await listen(path);
  registry.set(path, server);
}
function releaseLock(runDir) {
  const path = lockPath(runDir);
  const server = lockRegistry().get(path);
  if (!server)
    return;
  lockRegistry().delete(path);
  rmSync(path, { force: true });
  server.close();
}
async function waitForRunShutdown(runDir, timeoutMs = LOCK_RELEASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await isAlive(runDir))
      return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RELEASE_POLL_MS));
  }
  return !await isAlive(runDir);
}
function removeRunDir(runDir) {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
function launchProcess(descriptor, initialArgs = []) {
  let launcher = "pi";
  const testLauncher = join(descriptor.cwd, "pi-test.sh");
  try {
    accessSync(testLauncher, constants.X_OK);
    launcher = testLauncher;
  } catch {}
  const result = spawnSync("tmux", [
    "new-session",
    "-d",
    "-s",
    descriptor.tmuxSession,
    "-x",
    "120",
    "-y",
    "40",
    "-c",
    descriptor.cwd,
    "--",
    "env",
    `PI_SUBAGENT_RUN_DIR=${descriptor.runDir}`,
    `PI_SUBAGENT_EXIT_KEY=${loadConfig(descriptor.cwd).exitKey ?? DEFAULT_EXIT_KEY}`,
    launcher,
    "--session",
    descriptor.sessionFile,
    "--provider",
    descriptor.provider,
    "--model",
    descriptor.model,
    "--thinking",
    descriptor.thinking,
    ...descriptor.launchArgs ?? [],
    ...initialArgs
  ], { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || "Failed to create tmux session");
}
function moveToTrash(runDir) {
  mkdirSync(trashRoot(), { recursive: true, mode: 448 });
  const target = join(trashRoot(), `${basename(runDir)}.${Date.now()}`);
  renameSync(runDir, target);
  return target;
}
function trashRoot() {
  return join(getRunsDir(), TRASH_DIR);
}
function listTrash() {
  if (!existsSync(trashRoot()))
    return [];
  const entries = [];
  for (const entry of readdirSync(trashRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory())
      continue;
    const stamp = Number(entry.name.slice(entry.name.lastIndexOf(".") + 1));
    entries.push({
      path: join(trashRoot(), entry.name),
      name: entry.name,
      trashedAt: Number.isFinite(stamp) ? stamp : 0
    });
  }
  return entries.sort((a, b) => a.trashedAt - b.trashedAt);
}
function purgeTrash(olderThanDays) {
  const cutoff = Date.now() - olderThanDays * DAY_MS;
  const removed = [];
  for (const entry of listTrash()) {
    if (entry.trashedAt > cutoff)
      continue;
    rmSync(entry.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    removed.push(entry.path);
  }
  return removed;
}
function listUnreadableRuns() {
  const root = getRunsDir();
  if (!existsSync(root))
    return [];
  const unreadable = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("."))
      continue;
    const runDir = join(root, entry.name);
    if (!existsSync(join(runDir, RUN_FILE)))
      continue;
    if (!Run.load(runDir))
      unreadable.push(entry.name);
  }
  return unreadable;
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
  subagent gc [--older-than <days>] [--purge]
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
  const run = Run.find(handle);
  if (!run)
    fail(`Unknown subagent: ${handle}`);
  return run;
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
  const descriptor = {
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
    createdAt: now
  };
  const run = Run.create(descriptor);
  const initialArgs = files.map((file) => `@${file}`);
  if (prompts.length > 0)
    initialArgs.push(`Task:
${prompts.join(`

`)}`);
  try {
    run.launch(initialArgs);
  } catch (error) {
    removeRunDir(runDir);
    throw error;
  }
  process.stdout.write(`Spawned ${run.displayName}
State: starting
Attach: tmux attach -t ${tmuxSession}
`);
}
async function statusSubagent(args) {
  if (args.length !== 1)
    usage();
  const view = await getRun(args[0]).reconcile();
  const { run } = view;
  process.stdout.write(`${run.displayName}: ${view.state} (${run.provider}/${run.model}, ${run.thinking})
Attach: tmux attach -t ${run.tmuxSession}
`);
}
function renameSubagent(args) {
  if (args.length !== 2)
    usage();
  const run = getRun(args[0]);
  run.updateDescriptor({ name: normalizeRunName(args[1]) });
  process.stdout.write(`Renamed ${run.displayName}
`);
}
async function sendSubagent(args) {
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
  const view = await getRun(handle).reconcile();
  const { run } = view;
  if (view.state === "error")
    fail(run.error || `${handle} failed`);
  const queued = run.queue({
    kind: "message",
    message,
    delivery: followUp ? "followUp" : "auto"
  });
  let started = false;
  if (!view.alive && view.state !== "starting") {
    startRun(run);
    started = true;
  } else if (view.alive && !await delivered(queued, run)) {
    startRun(run);
    started = true;
  }
  process.stdout.write(`${sendVerb(started, followUp, view.state)} ${run.displayName}
`);
}
function sendVerb(started, followUp, state) {
  if (started)
    return "Started";
  if (followUp && state === "busy")
    return "Queued follow-up for";
  if (state === "idle")
    return "Prompted";
  return "Steered";
}
var DELIVERY_TIMEOUT_MS = 1500;
var DELIVERY_POLL_MS = 50;
async function delivered(path, run) {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!existsSync2(path))
      return true;
    if (!await run.alive())
      return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, DELIVERY_POLL_MS));
  }
  return true;
}
function startRun(run) {
  spawnSync2("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
  run.updateStatus({ state: "starting", error: undefined });
  try {
    run.launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.updateStatus({ state: "error", error: message });
    fail(`Could not start ${run.displayName}: ${message}`);
  }
}
async function interruptSubagent(args) {
  if (args.length !== 1)
    usage();
  const view = await getRun(args[0]).reconcile();
  const { run } = view;
  if (!view.alive && view.state !== "starting")
    fail(`${run.handle} is not running`);
  run.queue({ kind: "interrupt" });
  process.stdout.write(`Interrupted ${run.displayName}
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
    const view = await getRun(handle).reconcile();
    const { run } = view;
    const state = view.state;
    if (state === "error")
      fail(run.error || `${handle} failed`);
    if (state === "crashed")
      fail(`${handle} crashed before finishing`);
    if (state === "starting" || view.alive) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      continue;
    }
    if (!run.hasStarted)
      fail(`${handle} exited before finishing`);
    const message = readLatestAssistant(run.sessionFile);
    if (!message)
      fail(`${handle} finished without an assistant response`);
    process.stdout.write(`${handle} finished

${assistantText(message)}
`);
    if (message.stopReason === "error" || message.stopReason === "aborted")
      process.exitCode = 1;
    return;
  }
  fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}
async function stopSubagent(args) {
  if (args.length !== 1)
    usage();
  const run = getRun(args[0]);
  if (await run.alive()) {
    spawnSync2("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
    if (!await run.waitForShutdown())
      fail(`${run.handle} did not stop`);
  }
  run.trash();
  process.stdout.write(`Stopped ${run.displayName} (moved to trash)
`);
}
var DAY_MS2 = 86400000;
async function gcSubagents(args) {
  let purge = false;
  let olderThanDays = 0;
  for (let i = 0;i < args.length; i++) {
    switch (args[i]) {
      case "--purge":
        purge = true;
        break;
      case "--older-than": {
        const value = Number(valueAfter(args, i, "--older-than"));
        if (!Number.isFinite(value) || value < 0)
          fail("--older-than must be a non-negative number of days");
        olderThanDays = value;
        i++;
        break;
      }
      default:
        usage();
    }
  }
  for (const { run, state, action } of await reconcileAll()) {
    if (action === "none")
      continue;
    process.stdout.write(`${run.displayName}  ${state}  ${action}
`);
  }
  const cutoff = Date.now() - olderThanDays * DAY_MS2;
  const unreadable = listUnreadableRuns();
  if (unreadable.length > 0) {
    process.stdout.write(`${unreadable.length} unreadable record(s), left in place: ${unreadable.join(", ")}
`);
  }
  const trash = listTrash();
  const expired = trash.filter((entry) => entry.trashedAt <= cutoff);
  if (purge) {
    process.stdout.write(`Purged ${purgeTrash(olderThanDays).length} trashed run(s)
`);
    return;
  }
  for (const entry of trash) {
    const age = Math.max(0, Math.round((Date.now() - entry.trashedAt) / DAY_MS2));
    const kept = entry.trashedAt > cutoff ? "  (kept)" : "";
    process.stdout.write(`${entry.name}  trashed ${age}d ago${kept}
`);
  }
  process.stdout.write(`Dry run. ${expired.length} trashed run(s) would be purged with --purge.
`);
}
async function listSubagents(args) {
  if (args.length !== 0)
    usage();
  const runs = await reconcileAll(process.env.PI_SESSION_ID || undefined);
  if (runs.length === 0) {
    process.stdout.write(`No subagents
`);
    return;
  }
  for (const { run, state } of runs) {
    process.stdout.write(`${run.displayName}  ${state.padEnd(8)}  ${run.provider}/${run.model}  ${run.thinking}
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
      await statusSubagent(args);
      break;
    case "rename":
      renameSubagent(args);
      break;
    case "send":
      await sendSubagent(args);
      break;
    case "interrupt":
      await interruptSubagent(args);
      break;
    case "wait":
      await waitSubagent(args);
      break;
    case "stop":
      await stopSubagent(args);
      break;
    case "gc":
      await gcSubagents(args);
      break;
    case "list":
      await listSubagents(args);
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
