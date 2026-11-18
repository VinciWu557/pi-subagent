#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assistantText,
	CHOICE_FIELDS,
	configSources,
	effectiveRunState,
	getRunsDir,
	inboxDir,
	launchRun,
	listRuns,
	mergeConfigs,
	queueInboxMessage,
	readLatestAssistant,
	readMetadata,
	removeRunDir,
	runDisplayName,
	isValidRunName,
	type ChoiceField,
	type ConfigSource,
	type ModelChoice,
	type RunMetadata,
	type SubagentConfig,
	tmuxSessionExists,
	updateMetadata,
	waitForRunShutdown,
	writeMetadata,
} from "./shared.ts";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const BUILTIN_EXTENSION_PREFIX = "builtin:";
const DEFAULT_THINKING = "medium";
const ENV_VARS: Record<ChoiceField, string> = {
	provider: "PI_PROVIDER",
	model: "PI_MODEL",
	thinking: "PI_REASONING_LEVEL",
};
const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

function fail(message: string): never {
	throw new Error(message);
}

function usage(): never {
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

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
	return value;
}

function normalizeRunName(value: string): string {
	const name = value.trim();
	if (!isValidRunName(name)) fail("Subagent name must be a single line of 1 to 64 characters");
	return name;
}

function normalizeExtension(value: string): string {
	if (value.startsWith(BUILTIN_EXTENSION_PREFIX)) {
		if (value.length === BUILTIN_EXTENSION_PREFIX.length) fail("builtin: requires an extension name");
		return value;
	}
	const path = resolve(value);
	if (!existsSync(path)) fail(`Extension not found: ${value}`);
	return path;
}

function runDirForHandle(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) fail(`Invalid subagent handle: ${handle}`);
	return join(getRunsDir(), handle);
}

function getRun(handle: string): RunMetadata {
	const metadata = readMetadata(runDirForHandle(handle));
	if (!metadata) fail(`Unknown subagent: ${handle}`);
	return metadata;
}

function generateHandle(): string {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = randomBytes(3).toString("hex");
		if (!existsSync(runDirForHandle(handle))) return handle;
	}
	fail("Could not allocate a unique subagent handle");
}

function resolvePreset(
	config: SubagentConfig,
	name: string | undefined,
): { name: string; choice: ModelChoice } | undefined {
	if (name === undefined) {
		return undefined;
	}
	const choice = config.presets?.[name];
	if (choice) {
		return { name, choice };
	}
	const available = Object.keys(config.presets ?? {}).sort();
	const hint = available.length > 0 ? ` Available: ${available.join(", ")}` : " No presets defined";
	fail(`Unknown preset: ${name}.${hint}`);
}

interface ResolvedChoice {
	value?: string;
	/** Where the value came from; reported when the value turns out to be invalid. */
	from?: string;
}

function defaultsOrigin(sources: ConfigSource[], field: ChoiceField): string {
	// The last source defining the field is the one that survives the merge.
	for (let index = sources.length - 1; index >= 0; index--) {
		if (sources[index].config.defaults?.[field] !== undefined) {
			return sources[index].path;
		}
	}
	return "config defaults";
}

/** Per field precedence: flag > preset > config defaults > env > builtin fallback. */
function resolveChoice(
	flags: ModelChoice,
	preset: { name: string; choice: ModelChoice } | undefined,
	config: SubagentConfig,
	sources: ConfigSource[],
): Record<ChoiceField, ResolvedChoice> {
	const resolved = {} as Record<ChoiceField, ResolvedChoice>;
	for (const field of CHOICE_FIELDS) {
		const flagValue = flags[field];
		if (flagValue) {
			resolved[field] = { value: flagValue, from: `--${field}` };
			continue;
		}

		const presetValue = preset?.choice[field];
		if (presetValue) {
			resolved[field] = { value: presetValue, from: `preset "${preset?.name}"` };
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

function spawnSubagent(args: string[]): void {
	if (process.env.PI_SUBAGENT_RUN_DIR) fail("Nested subagents are disabled");
	let name: string | undefined;
	let presetName: string | undefined;
	const flags: ModelChoice = {};
	let cwd = process.cwd();
	let tools: string | undefined;
	let noExtensions = false;
	let noSkills = false;
	let noPromptTemplates = false;
	let noContextFiles = false;
	const prompts: string[] = [];
	const files: string[] = [];
	const extensions: string[] = [];

	for (let i = 0; i < args.length; i++) {
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
				if (!existsSync(file)) fail(`File not found: ${file}`);
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

	if (!provider) fail("No provider specified: pass --provider, a preset, config defaults, or PI_PROVIDER");
	if (!model) fail("No model specified: pass --model, a preset, config defaults, or PI_MODEL");
	if (!VALID_THINKING_LEVELS.has(thinking)) {
		fail(`Invalid thinking level: ${thinking} (from ${resolved.thinking.from ?? "builtin default"})`);
	}
	if (tools !== undefined && !tools.split(",").some((name) => name.trim()))
		fail("--tools requires at least one tool name");
	if (prompts.length === 0 && files.length === 0) fail("spawn requires at least one --prompt or --file");
	if (!existsSync(cwd)) fail(`Working directory not found: ${cwd}`);

	const handle = generateHandle();
	const runDir = runDirForHandle(handle);
	const sessionFile = join(runDir, "session.jsonl");
	const tmuxSession = `pi-subagent-${handle}`;
	mkdirSync(inboxDir(runDir), { recursive: true, mode: 0o700 });
	writeFileSync(sessionFile, "", { mode: 0o600 });

	const launchArgs: string[] = [];
	if (tools) launchArgs.push("--tools", tools);
	if (noExtensions) launchArgs.push("--no-extensions", "--extension", extensionPath);
	for (const extension of extensions) launchArgs.push("--extension", extension);
	if (noSkills) launchArgs.push("--no-skills");
	if (noPromptTemplates) launchArgs.push("--no-prompt-templates");
	if (noContextFiles) launchArgs.push("--no-context-files");

	const now = new Date().toISOString();
	const metadata: RunMetadata = {
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
		updatedAt: now,
	};
	writeMetadata(metadata);

	const initialArgs = files.map((file) => `@${file}`);
	if (prompts.length > 0) initialArgs.push(`Task:\n${prompts.join("\n\n")}`);
	try {
		launchRun(metadata, initialArgs);
	} catch (error) {
		removeRunDir(runDir);
		throw error;
	}

	process.stdout.write(`Spawned ${runDisplayName(metadata)}\nState: busy\nAttach: tmux attach -t ${tmuxSession}\n`);
}

function statusSubagent(args: string[]): void {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	process.stdout.write(
		`${runDisplayName(metadata)}: ${effectiveRunState(metadata)} (${metadata.provider}/${metadata.model}, ${metadata.thinking})\nAttach: tmux attach -t ${metadata.tmuxSession}\n`,
	);
}

function renameSubagent(args: string[]): void {
	if (args.length !== 2) usage();
	const metadata = getRun(args[0]);
	const name = normalizeRunName(args[1]);
	const updated = updateMetadata(metadata.runDir, { name });
	if (!updated) fail(`Could not rename subagent: ${metadata.handle}`);
	process.stdout.write(`Renamed ${runDisplayName(updated)}\n`);
}

function sendSubagent(args: string[]): void {
	const handle = args.shift();
	if (!handle) usage();
	let followUp = false;
	const messageParts: string[] = [];
	for (const arg of args) {
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`Unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}
	const message = messageParts.join(" ").trim();
	if (!message) fail("send requires a message");
	const metadata = getRun(handle);
	if (!tmuxSessionExists(metadata.tmuxSession)) fail(`${handle} is not running`);

	queueInboxMessage(metadata.runDir, { kind: "message", message, delivery: followUp ? "followUp" : "auto" });

	const state = effectiveRunState(metadata);
	const verb = followUp && state === "busy" ? "Queued follow-up for" : state === "idle" ? "Prompted" : "Steered";
	process.stdout.write(`${verb} ${runDisplayName(metadata)}\n`);
}

function interruptSubagent(args: string[]): void {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	if (!tmuxSessionExists(metadata.tmuxSession)) fail(`${metadata.handle} is not running`);
	queueInboxMessage(metadata.runDir, { kind: "interrupt" });
	process.stdout.write(`Interrupted ${runDisplayName(metadata)}\n`);
}

function parseTimeout(args: string[]): number {
	if (args.length === 0) return 1800;
	if (args.length !== 2 || args[0] !== "--timeout") usage();
	const timeout = Number(args[1]);
	if (!Number.isInteger(timeout) || timeout <= 0) fail("--timeout must be a positive integer");
	return timeout;
}

async function waitSubagent(args: string[]): Promise<void> {
	const handle = args.shift();
	if (!handle) usage();
	const timeoutSeconds = parseTimeout(args);
	const deadline = Date.now() + timeoutSeconds * 1000;

	while (Date.now() < deadline) {
		const metadata = getRun(handle);
		const pending = existsSync(inboxDir(metadata.runDir))
			? readdirSync(inboxDir(metadata.runDir)).some((file) => file.endsWith(".json"))
			: false;
		const state = effectiveRunState(metadata);
		if (state === "error") fail(metadata.error || `${handle} failed`);
		if (state === "exited") fail(`${handle} exited before finishing`);
		if (metadata.hasStarted && state === "idle" && !pending) {
			const message = readLatestAssistant(metadata.sessionFile);
			if (!message) fail(`${handle} finished without an assistant response`);
			process.stdout.write(`${handle} finished\n\n${assistantText(message)}\n`);
			if (message.stopReason === "error" || message.stopReason === "aborted") process.exitCode = 1;
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}

async function stopSubagent(args: string[]): Promise<void> {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	const wasRunning = tmuxSessionExists(metadata.tmuxSession);
	spawnSync("tmux", ["kill-session", "-t", metadata.tmuxSession], { stdio: "ignore" });
	if (wasRunning) await waitForRunShutdown(metadata.runDir);
	removeRunDir(metadata.runDir);
	process.stdout.write(`Stopped ${runDisplayName(metadata)}\n`);
}

function listSubagents(args: string[]): void {
	if (args.length !== 0) usage();
	const runs = listRuns(process.env.PI_SESSION_ID || undefined);
	if (runs.length === 0) {
		process.stdout.write("No subagents\n");
		return;
	}
	for (const metadata of runs) {
		process.stdout.write(
			`${runDisplayName(metadata)}  ${effectiveRunState(metadata).padEnd(8)}  ${metadata.provider}/${metadata.model}  ${metadata.thinking}\n`,
		);
	}
}

async function main(): Promise<void> {
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

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
