#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assistantText,
	CHOICE_FIELDS,
	configSources,
	getRunsDir,
	inboxDir,
	listTrash,
	listUnreadableRuns,
	markDelivered,
	mergeConfigs,
	purgeTrash,
	readLatestAssistant,
	readRunEvents,
	removeRunDir,
	reconcileAll,
	Run,
	isValidRunName,
	type ChoiceField,
	type ConfigSource,
	type ModelChoice,
	type RunDescriptor,
	type RunState,
	type SubagentConfig,
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
    [--wait] (--prompt <text> | --file <path>)...
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

function getRun(handle: string): Run {
	const run = Run.find(handle);
	if (!run) fail(`Unknown subagent: ${handle}`);
	return run;
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

/**
 * Per field precedence: preset > flag > config defaults > env > builtin fallback.
 *
 * A preset outranks the flags so a model that spawns children cannot talk itself into a
 * pricier choice than the user configured: `--preset scout --model expensive` still runs
 * scout's model. Flags only fill fields the preset leaves empty.
 */
function resolveChoice(
	flags: ModelChoice,
	preset: { name: string; choice: ModelChoice } | undefined,
	config: SubagentConfig,
	sources: ConfigSource[],
): Record<ChoiceField, ResolvedChoice> {
	const resolved = {} as Record<ChoiceField, ResolvedChoice>;
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

async function spawnSubagent(args: string[]): Promise<void> {
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
	let wait = false;
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
			case "--wait":
				wait = true;
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
	const descriptor: RunDescriptor = {
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
		createdAt: now,
	};
	const run = Run.create(descriptor);

	const initialArgs = files.map((file) => `@${file}`);
	if (prompts.length > 0) initialArgs.push(`Task:\n${prompts.join("\n\n")}`);
	try {
		run.launch(initialArgs);
	} catch (error) {
		removeRunDir(runDir);
		throw error;
	}

	process.stdout.write(`Spawned ${run.displayName}\nState: starting\nAttach: tmux attach -t ${tmuxSession}\n`);
	if (!wait) return;
	// Same text `wait` prints, so a caller can treat both paths as one result.
	process.stdout.write("\n");
	await waitSubagent([handle]);
}

async function statusSubagent(args: string[]): Promise<void> {
	if (args.length !== 1) usage();
	const view = await getRun(args[0]).reconcile();
	const { run } = view;
	process.stdout.write(
		`${run.displayName}: ${view.state} (${run.provider}/${run.model}, ${run.thinking})\nAttach: tmux attach -t ${run.tmuxSession}\n`,
	);
}

function renameSubagent(args: string[]): void {
	if (args.length !== 2) usage();
	const run = getRun(args[0]);
	run.updateDescriptor({ name: normalizeRunName(args[1]) });
	process.stdout.write(`Renamed ${run.displayName}\n`);
}

async function sendSubagent(args: string[]): Promise<void> {
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
	const view = await getRun(handle).reconcile();
	const { run } = view;
	if (view.state === "error") fail(run.error || `${handle} failed`);

	const queued = run.queue({
		kind: "message",
		message,
		delivery: followUp ? "followUp" : "auto",
	});

	// No lock and not booting means the process is gone: start it and let the inbox drain.
	let started = false;
	if (!view.alive && view.state !== "starting") {
		startRun(run);
		started = true;
	} else if (view.alive && !(await delivered(queued, run))) {
		// It settled and left between our probe and its inbox poll. The file is still queued.
		startRun(run);
		started = true;
	}

	process.stdout.write(`${sendVerb(started, followUp, view.state)} ${run.displayName}\n`);
}

/** Why the message will run when it will, in one word, from the caller's point of view. */
function sendVerb(started: boolean, followUp: boolean, state: RunState): string {
	if (started) return "Started";
	if (followUp && state === "busy") return "Queued follow-up for";
	if (state === "idle") return "Prompted";
	return "Steered";
}

/** How long a live run gets to take a queued file before we assume it is leaving. */
const DELIVERY_TIMEOUT_MS = 1500;
const DELIVERY_POLL_MS = 50;

/** True once the child removed the queued file; false when its lock dropped first. */
async function delivered(path: string, run: Run): Promise<boolean> {
	const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!existsSync(path)) return true;
		if (!(await run.alive())) return false;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, DELIVERY_POLL_MS));
	}
	// Still alive and slow: its next poll takes the file.
	return true;
}

/** A dead run keeps its tmux name; the fresh process needs it back. */
function startRun(run: Run): void {
	spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
	run.updateStatus({ state: "starting", error: undefined });
	try {
		run.launch();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		run.updateStatus({ state: "error", error: message });
		fail(`Could not start ${run.displayName}: ${message}`);
	}
}

async function interruptSubagent(args: string[]): Promise<void> {
	if (args.length !== 1) usage();
	const view = await getRun(args[0]).reconcile();
	const { run } = view;
	if (!view.alive && view.state !== "starting") fail(`${run.handle} is not running`);
	run.queue({ kind: "interrupt" });
	process.stdout.write(`Interrupted ${run.displayName}\n`);
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
		const view = await getRun(handle).reconcile();
		const { run } = view;
		const state = view.state;
		if (state === "error") fail(run.error || `${handle} failed`);
		if (state === "crashed") fail(`${handle} crashed before finishing`);
		// A booting child has no lock yet, which is not the same as a finished turn.
		if (state === "starting" || view.alive) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
			continue;
		}
		// No lock and past the boot grace: the process is gone, so the turn is over.
		if (!run.hasStarted) fail(`${handle} exited before finishing`);
		const message = readLatestAssistant(run.sessionFile);
		if (!message) fail(`${handle} finished without an assistant response`);
		process.stdout.write(`${handle} finished\n\n${assistantText(message)}\n`);
		// The caller just read the result, so the parent extension must not report it a second time.
		if (process.env.PI_SESSION_FILE === run.parentSessionFile) {
			markDelivered(run.dir, readRunEvents(run.dir).at(-1)?.seq ?? 0);
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") process.exitCode = 1;
		return;
	}
	fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}

async function stopSubagent(args: string[]): Promise<void> {
	if (args.length !== 1) usage();
	const run = getRun(args[0]);
	if (await run.alive()) {
		spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
		if (!(await run.waitForShutdown())) fail(`${run.handle} did not stop`);
	}
	run.trash();
	process.stdout.write(`Stopped ${run.displayName} (moved to trash)\n`);
}

const DAY_MS = 86_400_000;

async function gcSubagents(args: string[]): Promise<void> {
	let purge = false;
	let olderThanDays = 0;
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--purge":
				purge = true;
				break;
			case "--older-than": {
				const value = Number(valueAfter(args, i, "--older-than"));
				if (!Number.isFinite(value) || value < 0) fail("--older-than must be a non-negative number of days");
				olderThanDays = value;
				i++;
				break;
			}
			default:
				usage();
		}
	}

	for (const { run, state, action } of await reconcileAll()) {
		if (action === "none") continue;
		process.stdout.write(`${run.displayName}  ${state}  ${action}\n`);
	}

	const cutoff = Date.now() - olderThanDays * DAY_MS;
	const unreadable = listUnreadableRuns();
	if (unreadable.length > 0) {
		process.stdout.write(`${unreadable.length} unreadable record(s), left in place: ${unreadable.join(", ")}\n`);
	}
	const trash = listTrash();
	const expired = trash.filter((entry) => entry.trashedAt <= cutoff);
	if (purge) {
		process.stdout.write(`Purged ${purgeTrash(olderThanDays).length} trashed run(s)\n`);
		return;
	}
	for (const entry of trash) {
		const age = Math.max(0, Math.round((Date.now() - entry.trashedAt) / DAY_MS));
		const kept = entry.trashedAt > cutoff ? "  (kept)" : "";
		process.stdout.write(`${entry.name}  trashed ${age}d ago${kept}\n`);
	}
	process.stdout.write(`Dry run. ${expired.length} trashed run(s) would be purged with --purge.\n`);
}

async function listSubagents(args: string[]): Promise<void> {
	if (args.length !== 0) usage();
	// A resumed session has a new id for the same file; either one identifies this session's runs.
	const runs = await reconcileAll(process.env.PI_SESSION_ID || undefined, process.env.PI_SESSION_FILE || undefined);
	if (runs.length === 0) {
		process.stdout.write("No subagents\n");
		return;
	}
	for (const { run, state } of runs) {
		process.stdout.write(
			`${run.displayName}  ${state.padEnd(8)}  ${run.provider}/${run.model}  ${run.thinking}\n`,
		);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args.shift();
	switch (command) {
		case "spawn":
			await spawnSubagent(args);
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

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
