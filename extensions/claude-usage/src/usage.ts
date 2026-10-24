import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { get } from "node:https";
import { homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";

// Footer segment showing remaining Claude subscription quota: the 5-hour
// session window and the weekly window, as remaining percentages.
//
// Data comes from the same unofficial endpoint Claude Code's own /status
// command uses (GET api.anthropic.com/api/oauth/usage). The OAuth token is
// read from Claude Code's own login: ~/.claude/.credentials.json (or
// $CLAUDE_CONFIG_DIR) on disk, or the macOS login keychain items under the
// service "Claude Code-credentials" otherwise. The token is sent only to the
// official Anthropic usage endpoint, never logged or persisted.
//
// The login keychain can hold several Claude accounts (and MCP-only items
// without a usage token). Run /claude-account to pick which account the
// footer shows; the choice persists in ~/.config/pi-claude-usage/config.json.
// With no choice saved, the first candidate that returns data wins.

const STATUS_KEY = "claude-usage";
const COMMAND_NAME = "claude-account";
const USAGE_HOST = "api.anthropic.com";
const USAGE_PATH = "/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
// Startup may trust a cache this old without contacting the network.
// During a session every refresh is throttled by MIN_FETCH_INTERVAL_MS only,
// so the footer follows usage within about a minute instead of five.
const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_FETCH_INTERVAL_MS = 60 * 1000;
// Local re-render cadence: keeps the reset countdown live between fetches.
const TICK_INTERVAL_MS = 15 * 1000;
const CANDIDATE_CACHE_TTL_MS = 5 * 60 * 1000;
const STARTUP_REFRESH_DELAY_MS = 2_000;
const PROBE_TIMEOUT_MS = 6_000;
const KEYCHAIN_DUMP_TIMEOUT_MS = 15_000;
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 10_000;

type QuotaWindow = { remaining: number; resetsAt: string | null };
type Snapshot = { fetchedAt: number; session: QuotaWindow | null; weekly: QuotaWindow | null };
type Candidate = { id: string; label: string };

export type ClaudeUsage = {
	activate(ctx: ExtensionContext): Promise<void>;
	deactivate(ctx: ExtensionContext): void;
	poke(ctx: ExtensionContext): Promise<void>;
	runCommand(args: string, ctx: ExtensionContext, sessionActive: boolean): Promise<void>;
};

function configFile(): string {
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "pi-claude-usage", "config.json");
}

function cacheFile(): string {
	const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(base, "pi-claude-usage.json");
}

function credentialsPath(): string {
	return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, Math.round(value)));
}

async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

function tokenFromPayload(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const oauth = (data as Record<string, unknown>).claudeAiOauth;
	if (!oauth || typeof oauth !== "object") return null;
	const record = oauth as Record<string, unknown>;
	if (typeof record.accessToken !== "string" || !record.accessToken) return null;
	if (typeof record.expiresAt === "number" && record.expiresAt < Date.now() + 30_000) return null;
	return record.accessToken;
}

function runBinary(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: timeoutMs, signal }, (error, stdout) => {
			if (error) return resolve(null);
			resolve(stdout);
		});
	});
}

/** Keychain account names holding an item under the exact Claude service. Structure only; password blobs are never read. */
async function keychainAccounts(signal?: AbortSignal): Promise<string[]> {
	if (process.platform !== "darwin") return [];
	const dump = await runBinary("security", ["dump-keychain"], KEYCHAIN_DUMP_TIMEOUT_MS, signal);
	if (!dump) return [];
	const accounts: string[] = [];
	const seen = new Set<string>();
	// Entries are delimited by "keychain:"/"class:" headers. Within an
	// entry the service and account each appear in a named ("svce"/"acct")
	// and a numeric (0x00000007/0x00000008) form; the numeric account form
	// is hex-encoded and only used when the named form is absent.
	for (const entry of dump.split(/^(?:keychain|class): /m)) {
		const service = entry.match(/"(?:svce|0x00000007)"<blob>="([^"]*)"/);
		if (!service || service[1] !== KEYCHAIN_SERVICE) continue;
		const named = entry.match(/"acct"<blob>="([^"]*)"/);
		let account = named?.[1];
		if (!account) {
			const encoded = entry.match(/0x00000008 <blob>=0x([0-9A-Fa-f]+)/);
			if (encoded) {
				try {
					account = Buffer.from(encoded[1], "hex").toString("utf8").replace(/\0/g, "");
				} catch {
					account = undefined;
				}
			}
		}
		if (account && !seen.has(account)) {
			seen.add(account);
			accounts.push(account);
		}
	}
	return accounts;
}

function candidateForId(id: string): Candidate | null {
	if (id === "file") return { id, label: `credentials file (${credentialsPath()})` };
	if (id.startsWith("keychain:")) {
		const account = id.slice("keychain:".length);
		return { id, label: account ? `keychain account "${account}"` : "keychain (default item)" };
	}
	return null;
}

async function tokenForCandidate(id: string, signal?: AbortSignal): Promise<string | null> {
	if (signal?.aborted) return null;
	if (id === "file") return tokenFromPayload(await readJsonFile(credentialsPath()));
	if (!id.startsWith("keychain:")) return null;
	const account = id.slice("keychain:".length);
	const args = ["find-generic-password", "-s", KEYCHAIN_SERVICE];
	if (account) args.push("-a", account);
	args.push("-w");
	const output = await runBinary("security", args, KEYCHAIN_LOOKUP_TIMEOUT_MS, signal);
	if (!output) return null;
	try {
		return tokenFromPayload(JSON.parse(output));
	} catch {
		return null;
	}
}

async function listCandidates(signal?: AbortSignal): Promise<Candidate[]> {
	const candidates: Candidate[] = [];
	const fileData = await readJsonFile(credentialsPath());
	if (tokenFromPayload(fileData)) {
		candidates.push({ id: "file", label: `credentials file (${credentialsPath()})` });
	}
	if (process.platform !== "darwin" || signal?.aborted) return candidates;
	let accounts = await keychainAccounts(signal);
	if (accounts.length === 0 && !signal?.aborted) {
		// Fall back to the lookups Claude Code itself uses when dump parsing finds nothing.
		const direct = await runBinary(
			"security",
			["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
			KEYCHAIN_LOOKUP_TIMEOUT_MS,
			signal,
		);
		if (direct) {
			try {
				if (tokenFromPayload(JSON.parse(direct))) {
					candidates.push({ id: "keychain:", label: "keychain (default item)" });
					return candidates;
				}
			} catch {
				// Not a Claude credential payload.
			}
		}
		if (accounts.length === 0) {
			try {
				const username = userInfo().username;
				if (username) accounts = [username];
			} catch {
				// No username available; keychain candidates stay empty.
			}
		}
	}
	for (const account of accounts) {
		if (signal?.aborted) break;
		const id = account ? `keychain:${account}` : "keychain:";
		if (candidates.some((candidate) => candidate.id === id)) continue;
		const token = await tokenForCandidate(id, signal);
		if (token) candidates.push(candidateForId(id)!);
	}
	return candidates;
}

function fetchUsage(token: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown | null> {
	return new Promise((resolve) => {
		let settled = false;
		let onAbort: (() => void) | undefined;
		const finish = (value: unknown | null) => {
			if (settled) return;
			settled = true;
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		let request: ReturnType<typeof get>;
		try {
			request = get(
				{
					hostname: USAGE_HOST,
					path: USAGE_PATH,
					method: "GET",
					headers: { Authorization: `Bearer ${token}`, "anthropic-beta": BETA_HEADER },
					timeout: timeoutMs,
				},
				(response) => {
					let body = "";
					response.setEncoding("utf8");
					response.on("data", (chunk) => {
						body += chunk;
					});
					response.on("end", () => {
						if (response.statusCode !== 200 || !body) return finish(null);
						try {
							finish(JSON.parse(body));
						} catch {
							finish(null);
						}
					});
					response.on("error", () => finish(null));
				},
			);
		} catch {
			finish(null);
			return;
		}
		onAbort = () => {
			request.destroy();
			finish(null);
		};
		request.on("error", () => finish(null));
		request.on("timeout", () => {
			request.destroy();
			finish(null);
		});
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function pickWindow(data: unknown, kind: "session" | "weekly_all"): QuotaWindow | null {
	if (!data || typeof data !== "object") return null;
	const record = data as Record<string, unknown>;
	const limits = Array.isArray(record.limits) ? record.limits : [];
	for (const entry of limits) {
		if (!entry || typeof entry !== "object") continue;
		const item = entry as Record<string, unknown>;
		if (item.kind !== kind || typeof item.percent !== "number") continue;
		return {
			remaining: clampPercent(100 - item.percent),
			resetsAt: typeof item.resets_at === "string" ? item.resets_at : null,
		};
	}
	const flat = kind === "session" ? record.five_hour : record.seven_day;
	if (!flat || typeof flat !== "object") return null;
	const bucket = flat as Record<string, unknown>;
	if (typeof bucket.utilization !== "number") return null;
	return {
		remaining: clampPercent(100 - bucket.utilization),
		resetsAt: typeof bucket.resets_at === "string" ? bucket.resets_at : null,
	};
}

function toSnapshot(data: unknown, fetchedAt: number): Snapshot | null {
	const snapshot: Snapshot = {
		fetchedAt,
		session: pickWindow(data, "session"),
		weekly: pickWindow(data, "weekly_all"),
	};
	return snapshot.session || snapshot.weekly ? snapshot : null;
}

function formatReset(iso: string | null): string | null {
	if (!iso) return null;
	const target = Date.parse(iso);
	if (!Number.isFinite(target)) return null;
	let minutes = Math.max(0, Math.round((target - Date.now()) / 60_000));
	if (minutes <= 1) return "soon";
	const days = Math.floor(minutes / 1440);
	minutes -= days * 1440;
	const hours = Math.floor(minutes / 60);
	minutes -= hours * 60;
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	return `${minutes}m`;
}

function formatStatus(snapshot: Snapshot): string | null {
	const parts = ["claude"];
	if (snapshot.session) {
		parts.push(`5h:${snapshot.session.remaining}%`);
		const reset = formatReset(snapshot.session.resetsAt);
		if (reset) parts.push(`\u21bb${reset}`);
	}
	if (snapshot.weekly) {
		parts.push(`wk:${snapshot.weekly.remaining}%`);
		const reset = formatReset(snapshot.weekly.resetsAt);
		if (reset) parts.push(`\u21bb${reset}`);
	}
	return parts.length > 1 ? parts.join(" ") : null;
}

function isSnapshot(value: unknown): value is Snapshot {
	if (!value || typeof value !== "object") return false;
	return typeof (value as Record<string, unknown>).fetchedAt === "number";
}

function sessionIdOf(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

export function createClaudeUsage(): ClaudeUsage {
	let snapshots: Record<string, Snapshot> = {};
	let cacheLoaded = false;
	let selectionLoaded = false;
	let selectedId = "auto";
	let lastGoodId: string | undefined;
	let candidateCache: { at: number; candidates: Candidate[] } | undefined;
	let lastAttempt = 0;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let inFlight: AbortController | undefined;
	let generation = 0;
	let active: { sessionId: string; ctx: ExtensionContext } | undefined;
	let failureReported = false;
	let lastStatus: string | undefined;

	function isActive(ctx: ExtensionContext): boolean {
		return active !== undefined && active.sessionId === sessionIdOf(ctx);
	}

	function setStatus(ctx: ExtensionContext, text: string | undefined): void {
		if (text === lastStatus) return;
		lastStatus = text;
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// Session replacement can invalidate the context; the next event refreshes.
			lastStatus = undefined;
		}
	}

	function report(ctx: ExtensionContext, error: unknown): void {
		if (failureReported) return;
		failureReported = true;
		const message = error instanceof Error ? error.message : String(error);
		try {
			ctx.ui.notify(`Claude usage refresh failed: ${message}`, "warning");
		} catch {
			// No UI is available; the footer keeps its last value.
		}
	}

	function cancelTimer(): void {
		if (refreshTimer === undefined) return;
		clearTimeout(refreshTimer);
		refreshTimer = undefined;
	}

	function cancelRefresh(): void {
		cancelTimer();
		stopTicker();
		inFlight?.abort();
		inFlight = undefined;
	}

	async function loadState(): Promise<void> {
		if (cacheLoaded) return;
		cacheLoaded = true;
		const cached = await readJsonFile(cacheFile());
		if (!cached || typeof cached !== "object") return;
		snapshots = Object.fromEntries(
			Object.entries(cached as Record<string, unknown>).filter((entry): entry is [string, Snapshot] =>
				isSnapshot(entry[1]),
			),
		);
	}

	async function saveSnapshots(): Promise<void> {
		try {
			await mkdir(dirname(cacheFile()), { recursive: true });
			await writeFile(cacheFile(), JSON.stringify(snapshots));
		} catch {
			// Cache is best-effort; the footer works without it.
		}
	}

	async function loadSelection(): Promise<string> {
		if (selectionLoaded) return selectedId;
		selectionLoaded = true;
		const config = await readJsonFile(configFile());
		if (config && typeof config === "object") {
			const selected = (config as Record<string, unknown>).selectedId;
			if (typeof selected === "string" && selected) selectedId = selected;
		}
		return selectedId;
	}

	async function saveSelection(id: string): Promise<{ ok: boolean; error?: unknown }> {
		selectedId = id;
		selectionLoaded = true;
		try {
			await mkdir(dirname(configFile()), { recursive: true });
			await writeFile(configFile(), JSON.stringify({ selectedId: id }));
			return { ok: true };
		} catch (error) {
			return { ok: false, error };
		}
	}

	async function persistSelection(ctx: ExtensionContext, id: string): Promise<void> {
		const saved = await saveSelection(id);
		if (saved.ok) return;
		const message = saved.error instanceof Error ? saved.error.message : String(saved.error);
		ctx.ui.notify(
			`Could not save the Claude account choice: ${message}. The choice applies to this session only.`,
			"warning",
		);
	}

	function bestSnapshot(id: string): Snapshot | undefined {
		if (id !== "auto") return snapshots[id];
		if (lastGoodId && snapshots[lastGoodId]) return snapshots[lastGoodId];
		return Object.values(snapshots).reduce<Snapshot | undefined>(
			(best, snapshot) => (!best || snapshot.fetchedAt > best.fetchedAt ? snapshot : best),
			undefined,
		);
	}

	function showCached(ctx: ExtensionContext): void {
		const snapshot = bestSnapshot(selectedId);
		if (snapshot) setStatus(ctx, formatStatus(snapshot) ?? undefined);
	}

	async function getCandidates(signal: AbortSignal): Promise<Candidate[]> {
		const now = Date.now();
		if (candidateCache && now - candidateCache.at < CANDIDATE_CACHE_TTL_MS) return candidateCache.candidates;
		const candidates = await listCandidates(signal);
		if (candidates.length > 0) candidateCache = { at: now, candidates };
		return candidates;
	}

	async function probe(candidate: Candidate, signal?: AbortSignal): Promise<Snapshot | null> {
		const token = await tokenForCandidate(candidate.id, signal);
		if (!token || signal?.aborted) return null;
		const data = await fetchUsage(token, PROBE_TIMEOUT_MS, signal);
		if (!data || signal?.aborted) return null;
		return toSnapshot(data, Date.now());
	}

	/** Resolve the candidate to display: an explicit choice only, otherwise the first that returns data. */
	async function resolveCandidate(
		selection: string,
		signal: AbortSignal,
	): Promise<{ candidate: Candidate; snapshot: Snapshot } | null> {
		const candidates =
			selection === "auto"
				? await getCandidates(signal)
				: [candidateForId(selection)].filter((candidate): candidate is Candidate => candidate !== null);
		if (candidates.length === 0 || signal.aborted) return null;
		const ordered =
			selection === "auto"
				? [...candidates].sort((left, right) => {
						if (left.id === lastGoodId) return -1;
						if (right.id === lastGoodId) return 1;
						return 0;
					})
				: candidates;
		for (const candidate of ordered) {
			if (signal.aborted) return null;
			const snapshot = await probe(candidate, signal);
			if (snapshot) {
				snapshots[candidate.id] = snapshot;
				lastGoodId = candidate.id;
				await saveSnapshots();
				return { candidate, snapshot };
			}
		}
		for (const candidate of ordered) {
			const cached = snapshots[candidate.id];
			if (cached) return { candidate, snapshot: cached };
		}
		return null;
	}

	async function refresh(ctx: ExtensionContext, force: boolean): Promise<void> {
		if (!isActive(ctx)) return;
		const gen = generation;
		cancelTimer();
		const now = Date.now();
		await loadState();
		if (!force && now - lastAttempt < MIN_FETCH_INTERVAL_MS) {
			showCached(ctx);
			return;
		}
		const selection = await loadSelection();
		lastAttempt = now;
		inFlight?.abort();
		const controller = new AbortController();
		inFlight = controller;
		try {
			const resolved = await resolveCandidate(selection, controller.signal);
			if (gen !== generation || !isActive(ctx) || controller.signal.aborted) return;
			setStatus(ctx, resolved ? (formatStatus(resolved.snapshot) ?? undefined) : undefined);
		} finally {
			if (inFlight === controller) inFlight = undefined;
		}
	}

	function resetDue(snapshot: Snapshot | undefined): boolean {
		if (!snapshot) return false;
		return [snapshot.session, snapshot.weekly].some((window) => {
			if (!window?.resetsAt) return false;
			const at = Date.parse(window.resetsAt);
			return Number.isFinite(at) && Date.now() >= at;
		});
	}

	function stopTicker(): void {
		if (tickTimer === undefined) return;
		clearInterval(tickTimer);
		tickTimer = undefined;
	}

	/**
	 * Re-render from the current snapshot on a short cadence so the reset
	 * countdown moves, and fetch once when a window's reset time has passed
	 * (the cached percentage is stale by definition at that point).
	 */
	function startTicker(ctx: ExtensionContext): void {
		stopTicker();
		const gen = generation;
		const timer = setInterval(() => {
			if (gen !== generation || !isActive(ctx)) return;
			showCached(ctx);
			if (resetDue(bestSnapshot(selectedId))) {
				void refresh(ctx, false).catch((error: unknown) => report(ctx, error));
			}
		}, TICK_INTERVAL_MS);
		timer.unref?.();
		tickTimer = timer;
	}

	function scheduleRefresh(ctx: ExtensionContext, delayMs: number): void {
		cancelTimer();
		const gen = generation;
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			if (gen !== generation || !isActive(ctx)) return;
			void refresh(ctx, false).catch((error: unknown) => report(ctx, error));
		}, delayMs);
		refreshTimer.unref?.();
	}

	async function activate(ctx: ExtensionContext): Promise<void> {
		const id = sessionIdOf(ctx);
		if (active?.sessionId === id) {
			active.ctx = ctx;
			return;
		}
		generation++;
		cancelRefresh();
		active = { sessionId: id, ctx };
		// Pi clears extension statuses when a session is replaced, so the first
		// paint of a new session must reach the footer even if the text matches.
		lastStatus = undefined;
		const gen = generation;
		await loadState();
		if (gen !== generation || !isActive(ctx)) return;
		await loadSelection();
		if (gen !== generation || !isActive(ctx)) return;
		const cached = bestSnapshot(selectedId);
		if (cached) setStatus(ctx, formatStatus(cached) ?? undefined);
		startTicker(ctx);
		// A fresh cache needs no startup work. Otherwise refresh after the
		// session has started, so Keychain and network work stay off that path.
		if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;
		scheduleRefresh(ctx, STARTUP_REFRESH_DELAY_MS);
	}

	function deactivate(ctx: ExtensionContext): void {
		generation++;
		active = undefined;
		cancelRefresh();
		setStatus(ctx, undefined);
	}

	async function runCommand(args: string, ctx: ExtensionContext, sessionActive: boolean): Promise<void> {
		await loadState();
		const raw = args.trim();
		if (raw === "auto" || raw === "file" || raw.startsWith("keychain:")) {
			await persistSelection(ctx, raw);
			lastAttempt = 0;
			candidateCache = undefined;
			if (sessionActive && isActive(ctx)) await refresh(ctx, true);
			ctx.ui.notify(
				sessionActive
					? `Claude usage footer now follows: ${raw}`
					: `Saved ${raw}. The footer appears when the session uses a Claude model.`,
				"info",
			);
			return;
		}
		if (raw) {
			ctx.ui.notify(
				`Unknown account "${raw}". Use "auto", "file", or a keychain:<name> id from /${COMMAND_NAME} with no arguments.`,
				"warning",
			);
			return;
		}
		candidateCache = undefined;
		const candidates = await listCandidates();
		if (candidates.length === 0) {
			ctx.ui.notify(
				"No Claude login found (credentials file or login keychain). Sign in with `claude auth login` first.",
				"warning",
			);
			return;
		}
		candidateCache = { at: Date.now(), candidates };
		const live = await Promise.all(
			candidates.map(async (candidate) => ({ candidate, snapshot: await probe(candidate) })),
		);
		for (const { candidate, snapshot } of live) {
			if (snapshot) snapshots[candidate.id] = snapshot;
		}
		await saveSnapshots();
		const options = [
			"auto (first account that returns data)",
			...live.map(({ candidate, snapshot }) => {
				const detail = snapshot?.weekly ? `wk:${snapshot.weekly.remaining}% left` : "unreachable";
				return `${candidate.id} — ${candidate.label} — ${detail}`;
			}),
		];
		const choice = await ctx.ui.select("Claude account for the usage footer", options);
		if (!choice) return;
		const selected = choice === options[0] ? "auto" : (choice.split(" — ")[0] ?? "auto");
		await persistSelection(ctx, selected);
		lastAttempt = 0;
		if (sessionActive && isActive(ctx)) await refresh(ctx, true);
		ctx.ui.notify(
			sessionActive
				? `Claude usage footer now follows: ${selected}`
				: `Saved ${selected}. The footer appears when the session uses a Claude model.`,
			"info",
		);
	}

	return {
		activate,
		deactivate,
		poke: async (ctx) => {
			if (!isActive(ctx)) return;
			await refresh(ctx, false);
		},
		runCommand,
	};
}
