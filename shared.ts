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
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	tmuxSession: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	/** tmux argv the child's exit key runs; detach when the parent attached rather than switched. */
	exitArgv?: string[];
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export type InboxMessage =
	| { kind: "message"; message: string; delivery: "auto" | "followUp" }
	| { kind: "interrupt" };

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export interface ModelChoice {
	provider?: string;
	model?: string;
	thinking?: string;
}

export interface SubagentConfig {
	defaults?: ModelChoice;
	presets?: Record<string, ModelChoice>;
	exitKey?: string;
}

export interface ConfigSource {
	path: string;
	config: SubagentConfig;
}

export const DEFAULT_EXIT_KEY = "ctrl+q";

export const CHOICE_FIELDS = ["provider", "model", "thinking"] as const;

export type ChoiceField = (typeof CHOICE_FIELDS)[number];

const CONFIG_FILE_NAME = "subagents.json";

function modelChoice(value: unknown): ModelChoice {
	if (typeof value !== "object" || value === null) {
		return {};
	}
	const record = value as Record<string, unknown>;
	const choice: ModelChoice = {};
	for (const field of CHOICE_FIELDS) {
		const fieldValue = record[field];
		if (typeof fieldValue === "string" && fieldValue.length > 0) {
			choice[field] = fieldValue;
		}
	}
	return choice;
}

/** Keep only known fields, so a stray key in the JSON cannot leak into a launch. */
function sanitizeConfig(value: unknown): SubagentConfig {
	if (typeof value !== "object" || value === null) {
		return {};
	}
	const record = value as Record<string, unknown>;
	const config: SubagentConfig = {};
	if (typeof record.exitKey === "string" && record.exitKey.trim().length > 0) {
		config.exitKey = record.exitKey;
	}
	if (record.defaults !== undefined) {
		config.defaults = modelChoice(record.defaults);
	}
	if (typeof record.presets === "object" && record.presets !== null) {
		const presets: Record<string, ModelChoice> = {};
		for (const [name, choice] of Object.entries(record.presets)) {
			presets[name] = modelChoice(choice);
		}
		config.presets = presets;
	}
	return config;
}

/** A broken or unreadable file only warns; spawn must never fail because of config. */
function readConfig(path: string): SubagentConfig {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		// A missing file is normal; any other read error should still be visible.
		if ((error as { code?: string }).code !== "ENOENT") {
			process.stderr.write(`Warning: cannot read ${path}: ${String(error)}\n`);
		}
		return {};
	}
	try {
		return sanitizeConfig(JSON.parse(raw));
	} catch (error) {
		process.stderr.write(`Warning: ignoring ${path}: ${String(error)}\n`);
		return {};
	}
}

/** User config first, project config second; the later source wins on merge. */
export function configSources(cwd: string): ConfigSource[] {
	const userPath = join(getAgentDir(), CONFIG_FILE_NAME);
	const projectPath = join(cwd, ".pi", CONFIG_FILE_NAME);
	return [
		{ path: userPath, config: readConfig(userPath) },
		{ path: projectPath, config: readConfig(projectPath) },
	];
}

export function mergeConfigs(sources: ConfigSource[]): SubagentConfig {
	const merged: SubagentConfig = {};
	for (const { config } of sources) {
		// exitKey replaces wholesale, defaults merge per field, presets merge per name.
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

export function loadConfig(cwd: string): SubagentConfig {
	return mergeConfigs(configSources(cwd));
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function queueInboxMessage(runDir: string, payload: InboxMessage): void {
	const queueDir = inboxDir(runDir);
	mkdirSync(queueDir, { recursive: true, mode: 0o700 });
	// The timestamp prefix keeps delivery ordered; the suffix prevents collisions within one millisecond.
	const target = join(queueDir, `${Date.now()}-${randomBytes(4).toString("hex")}.json`);
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.tmuxSession !== "string" ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function tmuxSessionExists(session: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
}

/** Start the child pi process for a run in its tmux session. `initialArgs` are only passed on first spawn. */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): void {
	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}

	const result = spawnSync(
		"tmux",
		[
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
			...(metadata.launchArgs ?? []),
			...initialArgs,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to create tmux session");
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!tmuxSessionExists(metadata.tmuxSession)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
