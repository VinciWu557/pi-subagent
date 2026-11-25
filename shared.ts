import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	accessSync,
	appendFileSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { connect, createServer, type Server } from "node:net";

export type RunState = "starting" | "busy" | "idle" | "exited" | "interrupted" | "crashed" | "error";

/** run.json. Written by the CLI at spawn and by rename; never by a running child. */
export interface RunDescriptor {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	tmuxSession: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	createdAt: string;
	/** Pane pid recorded at spawn, so a child that dies before it can report still counts as dead. */
	pid?: number;
}

/** status.json. Owned by the live process; reconcile corrects it once that process is gone. */
export interface RunStatus {
	version: 1;
	state: RunState;
	hasStarted: boolean;
	childSessionId?: string;
	updatedAt: string;
	error?: string;
	/** The child's own pid, written once it has a session. */
	pid?: number;
}

/** view.json. tmux argv the child's exit key runs; written by whoever attached. */
interface RunViewFile {
	exitArgv?: string[];
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

const RUN_FILE = "run.json";
const STATUS_FILE = "status.json";
const EVENTS_FILE = "events.jsonl";
const DELIVERED_FILE = "delivered.json";
const VIEW_FILE = "view.json";
const LOCK_FILE = "alive.sock";
const LOCK_PROBE_TIMEOUT_MS = 250;
const LOCK_RELEASE_POLL_MS = 50;
const LOCK_RELEASE_TIMEOUT_MS = 3000;
/** A run that has not bound its lock yet is booting, not dead. */
const START_GRACE_MS = 60_000;
const CRASH_FILE = "crashed.json";
const DAY_MS = 86_400_000;
const TRASH_DIR = ".trash";

export function lockPath(runDir: string): string {
	return join(runDir, LOCK_FILE);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function queueInboxMessage(runDir: string, payload: InboxMessage): string {
	const queueDir = inboxDir(runDir);
	mkdirSync(queueDir, { recursive: true, mode: 0o700 });
	// The timestamp prefix keeps delivery ordered; the suffix prevents collisions within one millisecond.
	const target = join(queueDir, `${Date.now()}-${randomBytes(4).toString("hex")}.json`);
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
	return target;
}

/**
 * Completions leave the child as append-only lines, not as a status flip the parent has to
 * interpret: a settle and a crash both change status.json, and only one of them has a result.
 */
export type RunEventKind = "settled" | "aborted";

export interface RunEvent {
	version: 1;
	seq: number;
	kind: RunEventKind;
	at: string;
	text: string;
}

export function eventsPath(runDir: string): string {
	return join(runDir, EVENTS_FILE);
}

/** A watcher gets every write under the runs root; only completion lines wake the parent. */
export function isEventsFile(file: string): boolean {
	return file.endsWith(`/${EVENTS_FILE}`) || file === EVENTS_FILE;
}

function isRunEvent(value: unknown): value is RunEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Partial<RunEvent>;
	return (
		event.version === 1 &&
		typeof event.seq === "number" &&
		(event.kind === "settled" || event.kind === "aborted") &&
		typeof event.at === "string" &&
		typeof event.text === "string"
	);
}

export function readRunEvents(runDir: string): RunEvent[] {
	let content: string;
	try {
		content = readFileSync(eventsPath(runDir), "utf8");
	} catch {
		return [];
	}
	const events: RunEvent[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isRunEvent(value)) events.push(value);
		} catch {
			// The last line can be mid-write; the next read picks it up whole.
		}
	}
	return events;
}

/** The child is the only writer, so seq only has to grow within one run directory. */
export function appendRunEvent(runDir: string, kind: RunEventKind, text: string): RunEvent {
	const seq = (readRunEvents(runDir).at(-1)?.seq ?? 0) + 1;
	const event: RunEvent = { version: 1, seq, kind, at: new Date().toISOString(), text };
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	appendFileSync(eventsPath(runDir), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
	return event;
}

/** Highest event seq the parent has already put into its own context. */
export function readDeliveredSeq(runDir: string): number {
	const value = readJson(join(runDir, DELIVERED_FILE)) as { version?: unknown; seq?: unknown } | undefined;
	return value?.version === 1 && typeof value.seq === "number" ? value.seq : 0;
}

/**
 * A crash is observed by the parent, so it cannot share the child's event sequence: the child might
 * still be alive and writing. One marker file per run keeps the notice at-most-once.
 */
export function wasCrashNotified(runDir: string): boolean {
	const value = readJson(join(runDir, CRASH_FILE)) as { version?: unknown; kind?: unknown } | undefined;
	return value?.version === 1 && typeof value.kind === "string";
}

/** Returns false when another tick (or a previous parent) already reported this run. */
export function markCrashNotified(runDir: string, kind: string): boolean {
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	try {
		writeFileSync(
			join(runDir, CRASH_FILE),
			JSON.stringify({ version: 1, kind, at: new Date().toISOString() }),
			{ encoding: "utf8", mode: 0o600, flag: "wx" },
		);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/** EPERM means the pid exists but belongs to another user, which still counts as alive. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** `tmux` runs the child directly, so the pane pid is the child's pid. */
function panePid(tmuxSession: string): number | undefined {
	const result = spawnSync("tmux", ["list-panes", "-t", tmuxSession, "-F", "#{pane_pid}"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const pid = Number.parseInt(result.stdout.trim(), 10);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function markDelivered(runDir: string, seq: number): void {
	writeJson(join(runDir, DELIVERED_FILE), { version: 1, seq, at: new Date().toISOString() });
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

function parseDescriptor(value: unknown): RunDescriptor | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const descriptor = value as Partial<RunDescriptor>;
	if (
		descriptor.version !== 1 ||
		typeof descriptor.handle !== "string" ||
		(descriptor.name !== undefined && !isValidRunName(descriptor.name)) ||
		typeof descriptor.tmuxSession !== "string" ||
		typeof descriptor.sessionFile !== "string" ||
		typeof descriptor.runDir !== "string" ||
		typeof descriptor.createdAt !== "string"
	) {
		return undefined;
	}
	return descriptor as RunDescriptor;
}

const RUN_STATES = new Set<RunState>(["starting", "busy", "idle", "exited", "interrupted", "crashed", "error"]);

function parseStatus(value: unknown): RunStatus | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const status = value as Partial<RunStatus>;
	if (status.version !== 1 || typeof status.state !== "string" || !RUN_STATES.has(status.state as RunState)) {
		return undefined;
	}
	return {
		version: 1,
		state: status.state as RunState,
		hasStarted: status.hasStarted === true,
		childSessionId: typeof status.childSessionId === "string" ? status.childSessionId : undefined,
		updatedAt: typeof status.updatedAt === "string" ? status.updatedAt : new Date(0).toISOString(),
		error: typeof status.error === "string" ? status.error : undefined,
		pid: typeof status.pid === "number" ? status.pid : undefined,
	};
}

/** The status a directory starts with before any process writes one. */
function initialStatus(descriptor: RunDescriptor): RunStatus {
	return {
		version: 1,
		state: "starting",
		hasStarted: false,
		updatedAt: descriptor.createdAt,
	};
}

export interface RunSnapshot {
	run: Run;
	alive: boolean;
	state: RunState;
}

export type ReconcileAction = "none" | "crashed" | "exited" | "trashed";

export interface ReconcileResult extends RunSnapshot {
	action: ReconcileAction;
}

/**
 * One run directory. run.json is static, status.json belongs to the live turn, view.json records
 * how to leave. Every write for this run goes through here, so callers never join paths themselves.
 */
export class Run {
	private descriptor: RunDescriptor;
	private status: RunStatus;
	private view: RunViewFile;

	private constructor(descriptor: RunDescriptor, status: RunStatus, view: RunViewFile) {
		this.descriptor = descriptor;
		this.status = status;
		this.view = view;
	}

	/** Read a run directory, or undefined when run.json is missing or unreadable. */
	static load(runDir: string): Run | undefined {
		const descriptor = parseDescriptor(readJson(join(runDir, RUN_FILE)));
		if (!descriptor) return undefined;
		const status = parseStatus(readJson(join(runDir, STATUS_FILE)));
		const view = readJson(join(runDir, VIEW_FILE)) as RunViewFile | undefined;
		return new Run(descriptor, status ?? initialStatus(descriptor), view ?? {});
	}

	static create(descriptor: RunDescriptor): Run {
		const run = new Run(descriptor, initialStatus(descriptor), {});
		writeJson(join(descriptor.runDir, RUN_FILE), descriptor);
		run.writeStatus();
		return run;
	}

	static find(handle: string): Run | undefined {
		return Run.load(join(getRunsDir(), handle));
	}

	static list(parentSessionId?: string, parentSessionFile?: string): Run[] {
		const root = getRunsDir();
		if (!existsSync(root)) return [];
		const runs: Run[] = [];
		// A resumed session gets a fresh id for the same file, so either one is enough to claim a run.
		const mine = (run: Run): boolean =>
			!parentSessionId ||
			run.parentSessionId === parentSessionId ||
			(parentSessionFile !== undefined && run.parentSessionFile === parentSessionFile);
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const run = Run.load(join(root, entry.name));
			if (!run || !mine(run)) continue;
			runs.push(run);
		}
		return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	get dir(): string {
		return this.descriptor.runDir;
	}

	get handle(): string {
		return this.descriptor.handle;
	}

	get name(): string | undefined {
		return this.descriptor.name;
	}

	get displayName(): string {
		return this.name ? `${this.name} (${this.handle})` : this.handle;
	}

	get sessionFile(): string {
		return this.descriptor.sessionFile;
	}

	get tmuxSession(): string {
		return this.descriptor.tmuxSession;
	}

	get cwd(): string {
		return this.descriptor.cwd;
	}

	get provider(): string {
		return this.descriptor.provider;
	}

	get model(): string {
		return this.descriptor.model;
	}

	get thinking(): string {
		return this.descriptor.thinking;
	}

	get parentSessionId(): string | undefined {
		return this.descriptor.parentSessionId;
	}

	get parentSessionFile(): string | undefined {
		return this.descriptor.parentSessionFile;
	}

	get createdAt(): string {
		return this.descriptor.createdAt;
	}

	get inboxDir(): string {
		return inboxDir(this.dir);
	}

	get exitArgv(): string[] | undefined {
		return this.view.exitArgv;
	}

	get state(): RunState {
		return this.status.state;
	}

	get hasStarted(): boolean {
		return this.status.hasStarted;
	}

	get updatedAt(): string {
		return this.status.updatedAt;
	}

	get error(): string | undefined {
		return this.status.error;
	}

	/** Patch status.json. Only the live process, or reconcile after it died, may call this. */
	updateStatus(patch: Partial<RunStatus>): void {
		this.status = { ...this.status, ...patch, version: 1, updatedAt: new Date().toISOString() };
		this.writeStatus();
	}

	updateDescriptor(patch: Partial<RunDescriptor>): void {
		this.descriptor = { ...this.descriptor, ...patch, version: 1, handle: this.handle, runDir: this.dir };
		writeJson(join(this.dir, RUN_FILE), this.descriptor);
	}

	attach(exitArgv: string[]): void {
		this.view = { exitArgv };
		writeJson(join(this.dir, VIEW_FILE), this.view);
	}

	launch(initialArgs: string[] = []): void {
		launchProcess(this.descriptor, initialArgs);
		// Recorded here so a child that dies before its first turn is still visibly dead, not
		// "starting" until the boot grace expires.
		const pid = panePid(this.descriptor.tmuxSession);
		if (pid !== undefined) this.updateDescriptor({ pid });
	}

	get pid(): number | undefined {
		return this.status.pid ?? this.descriptor.pid;
	}

	queue(payload: InboxMessage): string {
		return queueInboxMessage(this.dir, payload);
	}

	lock(): Promise<void> {
		return holdLock(this.dir);
	}

	unlock(): void {
		releaseLock(this.dir);
	}

	alive(): Promise<boolean> {
		return isAlive(this.dir);
	}

	waitForShutdown(timeoutMs?: number): Promise<boolean> {
		return waitForRunShutdown(this.dir, timeoutMs);
	}

	trash(): string {
		return moveToTrash(this.dir);
	}

	/** Pure read: the truth on disk plus the lock probe. Never writes. */
	async inspect(): Promise<RunSnapshot> {
		const alive = await this.alive();
		return { run: this, alive, state: this.snapshotState(alive) };
	}

	/** Correct what a dead process left behind. Idempotent, and never touches a live run. */
	async reconcile(): Promise<ReconcileResult> {
		const snapshot = await this.inspect();
		if (snapshot.alive) return { ...snapshot, action: "none" };
		// A crashed process leaves the socket file behind; clear it so the next boot can bind. A run
		// still inside its boot grace may be about to bind its own, so leave that one alone.
		if (snapshot.state !== "starting") {
			rmSync(lockPath(this.dir), { force: true });
		}
		if (this.isZeroValue() && snapshot.state !== "starting") {
			this.trash();
			return { ...snapshot, action: "trashed" };
		}
		if (snapshot.state === this.state) return { ...snapshot, action: "none" };
		const previous = this.state;
		const action: ReconcileAction = snapshot.state === "crashed" ? "crashed" : "exited";
		this.updateStatus({
			state: action,
			error: action === "crashed" ? `Process exited while ${previous}` : this.error,
		});
		return { ...snapshot, action };
	}

	private writeStatus(): void {
		writeJson(join(this.dir, STATUS_FILE), this.status);
	}

	private snapshotState(alive: boolean): RunState {
		if (alive) return this.state;
		if (this.state === "error") return "error";
		// updatedAt marks the last transition into starting, so a resumed run keeps its boot grace.
		if (this.state === "starting" && Date.now() - Date.parse(this.updatedAt) < START_GRACE_MS) {
			return "starting";
		}
		if (this.state === "interrupted") return "interrupted";
		if (this.state === "busy" || this.state === "starting") return "crashed";
		if (this.state === "crashed") return "crashed";
		return "exited";
	}

	private hasTranscript(): boolean {
		try {
			// Size, not content: a long transcript only needs an emptiness answer.
			return statSync(this.sessionFile).size > 0;
		} catch {
			return false;
		}
	}

	hasInbox(): boolean {
		try {
			return readdirSync(this.inboxDir).some((file) => file.endsWith(".json"));
		} catch {
			return false;
		}
	}

	/** Nothing happened and nothing is queued: the record holds no history worth keeping. */
	private isZeroValue(): boolean {
		return !this.hasStarted && !this.hasTranscript() && !this.hasInbox();
	}
}

export async function inspectRuns(parentSessionId?: string, parentSessionFile?: string): Promise<RunSnapshot[]> {
	return Promise.all(Run.list(parentSessionId, parentSessionFile).map((run) => run.inspect()));
}

export async function reconcileAll(parentSessionId?: string, parentSessionFile?: string): Promise<ReconcileResult[]> {
	const results: ReconcileResult[] = [];
	for (const run of Run.list(parentSessionId, parentSessionFile)) {
		results.push(await run.reconcile());
	}
	return results;
}

/**
 * Liveness is a bound Unix socket, which the kernel releases when the process dies.
 * tmux only carries the terminal, so a tmux restart no longer changes the answer.
 */
function isAlive(runDir: string): Promise<boolean> {
	return new Promise<boolean>((resolveAlive) => {
		const client = connect(lockPath(runDir));
		let settled = false;
		const finish = (alive: boolean): void => {
			if (settled) return;
			settled = true;
			client.destroy();
			resolveAlive(alive);
		};
		client.setTimeout(LOCK_PROBE_TIMEOUT_MS, () => finish(false));
		client.once("connect", () => finish(true));
		client.once("error", () => finish(false));
	});
}

const LOCK_REGISTRY = Symbol.for("pi-subagent.locks");

function lockRegistry(): Map<string, Server> {
	const global = globalThis as typeof globalThis & { [key: symbol]: unknown };
	if (global[LOCK_REGISTRY] instanceof Map) return global[LOCK_REGISTRY] as Map<string, Server>;
	const registry = new Map<string, Server>();
	global[LOCK_REGISTRY] = registry;
	return registry;
}

function listen(path: string): Promise<Server> {
	return new Promise<Server>((resolveListen, rejectListen) => {
		const server = createServer((socket) => socket.destroy());
		server.once("error", rejectListen);
		server.listen(path, () => {
			server.removeListener("error", rejectListen);
			resolveListen(server);
		});
	});
}

/**
 * Bind the liveness socket. The registry lives on globalThis so a /reload reuses the
 * bound server instead of failing to bind its own path.
 */
async function holdLock(runDir: string): Promise<void> {
	const path = lockPath(runDir);
	const registry = lockRegistry();
	if (registry.has(path)) return;
	// A crashed process leaves the socket file behind; clear it so this boot can bind.
	if (existsSync(path) && !(await isAlive(runDir))) {
		rmSync(path, { force: true });
	}
	const server = await listen(path);
	registry.set(path, server);
}

function releaseLock(runDir: string): void {
	const path = lockPath(runDir);
	const server = lockRegistry().get(path);
	if (!server) return;
	lockRegistry().delete(path);
	// Unlink first: a newcomer that binds in between must not lose its socket to this cleanup.
	rmSync(path, { force: true });
	server.close();
}

async function waitForRunShutdown(runDir: string, timeoutMs = LOCK_RELEASE_TIMEOUT_MS): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await isAlive(runDir))) return true;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, LOCK_RELEASE_POLL_MS));
	}
	return !(await isAlive(runDir));
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Start the child pi process for a run in its tmux session. `initialArgs` are only passed on first spawn. */
function launchProcess(descriptor: RunDescriptor, initialArgs: string[] = []): void {
	let launcher = "pi";
	const testLauncher = join(descriptor.cwd, "pi-test.sh");
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
			...(descriptor.launchArgs ?? []),
			...initialArgs,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to create tmux session");
}

function moveToTrash(runDir: string): string {
	mkdirSync(trashRoot(), { recursive: true, mode: 0o700 });
	const target = join(trashRoot(), `${basename(runDir)}.${Date.now()}`);
	renameSync(runDir, target);
	return target;
}

export function trashRoot(): string {
	return join(getRunsDir(), TRASH_DIR);
}

export interface TrashEntry {
	path: string;
	name: string;
	trashedAt: number;
}

export function listTrash(): TrashEntry[] {
	if (!existsSync(trashRoot())) return [];
	const entries: TrashEntry[] = [];
	for (const entry of readdirSync(trashRoot(), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const stamp = Number(entry.name.slice(entry.name.lastIndexOf(".") + 1));
		entries.push({
			path: join(trashRoot(), entry.name),
			name: entry.name,
			trashedAt: Number.isFinite(stamp) ? stamp : 0,
		});
	}
	return entries.sort((a, b) => a.trashedAt - b.trashedAt);
}

/** Delete trash older than the cutoff. Returns the paths removed. */
export function purgeTrash(olderThanDays: number): string[] {
	const cutoff = Date.now() - olderThanDays * DAY_MS;
	const removed: string[] = [];
	for (const entry of listTrash()) {
		if (entry.trashedAt > cutoff) continue;
		rmSync(entry.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		removed.push(entry.path);
	}
	return removed;
}

/** Directories holding a run.json nobody can parse: invisible to every command, so gc names them. */
export function listUnreadableRuns(): string[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const unreadable: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const runDir = join(root, entry.name);
		// No run.json at all means a pre-descriptor layout; leaving those alone is the caller's call.
		if (!existsSync(join(runDir, RUN_FILE))) continue;
		if (!Run.load(runDir)) unreadable.push(entry.name);
	}
	return unreadable;
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
