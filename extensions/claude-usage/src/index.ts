import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_FETCH_INTERVAL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 6000;

type QuotaWindow = { remaining: number; resetsAt: string | null };
type Snapshot = { fetchedAt: number; session: QuotaWindow | null; weekly: QuotaWindow | null };
type Candidate = { id: string; label: string };
type UI = {
	setStatus: (key: string, value: string | undefined) => void;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
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

function runBinary(command: string, args: string[], timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: timeoutMs }, (error, stdout) => {
			if (error) return resolve(null);
			resolve(stdout);
		});
	});
}

/** Keychain account names holding an item under the exact Claude service. Structure only; password blobs are never read. */
async function keychainAccounts(): Promise<string[]> {
	if (process.platform !== "darwin") return [];
	const dump = await runBinary("security", ["dump-keychain"], 15_000);
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

async function tokenForCandidate(id: string): Promise<string | null> {
	if (id === "file") return tokenFromPayload(await readJsonFile(credentialsPath()));
	if (id.startsWith("keychain:")) {
		const account = id.slice("keychain:".length);
		const output = await runBinary(
			"security",
			["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
			10_000,
		);
		if (!output) return null;
		try {
			return tokenFromPayload(JSON.parse(output));
		} catch {
			return null;
		}
	}
	return null;
}

async function listCandidates(): Promise<Candidate[]> {
	const candidates: Candidate[] = [];
	const fileData = await readJsonFile(credentialsPath());
	if (tokenFromPayload(fileData)) {
		candidates.push({ id: "file", label: `credentials file (${credentialsPath()})` });
	}
	let accounts = await keychainAccounts();
	if (accounts.length === 0 && process.platform === "darwin") {
		// Fall back to the lookups Claude Code itself uses when dump parsing finds nothing.
		const direct = await runBinary("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], 10_000);
		if (direct) {
			try {
				if (tokenFromPayload(JSON.parse(direct))) accounts = [""];
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
		const id = account ? `keychain:${account}` : "keychain:";
		if (candidates.some((candidate) => candidate.id === id)) continue;
		const token = await tokenForCandidate(id);
		if (token) candidates.push({ id, label: account ? `keychain account "${account}"` : "keychain (default item)" });
	}
	return candidates;
}

function fetchUsage(token: string, timeoutMs: number): Promise<unknown | null> {
	return new Promise((resolve) => {
		const request = get(
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
					if (response.statusCode !== 200 || !body) return resolve(null);
					try {
						resolve(JSON.parse(body));
					} catch {
						resolve(null);
					}
				});
			},
		);
		request.on("error", () => resolve(null));
		request.on("timeout", () => {
			request.destroy();
			resolve(null);
		});
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
	if (snapshot.session) parts.push(`5h:${snapshot.session.remaining}%`);
	if (snapshot.weekly) {
		parts.push(`wk:${snapshot.weekly.remaining}%`);
		const reset = formatReset(snapshot.weekly.resetsAt);
		if (reset) parts.push(`\u21bb${reset}`);
	}
	return parts.length > 1 ? parts.join(" ") : null;
}

export default function (pi: ExtensionAPI) {
	let inFlight: Promise<void> | null = null;
	let lastAttempt = 0;
	let snapshots: Record<string, Snapshot> = {};
	let cacheLoaded = false;

	async function loadState(): Promise<void> {
		if (cacheLoaded) return;
		cacheLoaded = true;
		const cached = await readJsonFile(cacheFile());
		if (cached && typeof cached === "object") snapshots = cached as Record<string, Snapshot>;
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
		const config = await readJsonFile(configFile());
		if (config && typeof config === "object") {
			const selected = (config as Record<string, unknown>).selectedId;
			if (typeof selected === "string" && selected) return selected;
		}
		return "auto";
	}

	async function saveSelection(selectedId: string): Promise<void> {
		try {
			await mkdir(dirname(configFile()), { recursive: true });
			await writeFile(configFile(), JSON.stringify({ selectedId }));
		} catch {
			// Selection persists best-effort; the footer keeps working in auto mode.
		}
	}

	async function probe(candidate: Candidate): Promise<Snapshot | null> {
		const token = await tokenForCandidate(candidate.id);
		if (!token) return null;
		const data = await fetchUsage(token, PROBE_TIMEOUT_MS);
		return data ? toSnapshot(data, Date.now()) : null;
	}

	/** Resolve the candidate to display: saved choice first, otherwise the first that returns data. */
	async function resolveCandidate(): Promise<{ candidate: Candidate; snapshot: Snapshot } | null> {
		const candidates = await listCandidates();
		if (candidates.length === 0) return null;
		const selectedId = await loadSelection();
		const ordered =
			selectedId === "auto"
				? candidates
				: [
						...candidates.filter((candidate) => candidate.id === selectedId),
						...candidates.filter((candidate) => candidate.id !== selectedId),
					];
		for (const candidate of ordered) {
			const cached = snapshots[candidate.id];
			if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
				return { candidate, snapshot: cached };
			}
		}
		for (const candidate of ordered) {
			const snapshot = await probe(candidate);
			if (snapshot) {
				snapshots[candidate.id] = snapshot;
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

	async function refresh(ui: UI): Promise<void> {
		await loadState();
		const now = Date.now();
		if (now - lastAttempt < MIN_FETCH_INTERVAL_MS && snapshots) {
			const selectedId = await loadSelection();
			const cached = snapshots[selectedId] ?? Object.values(snapshots)[0];
			if (cached) {
				const text = formatStatus(cached);
				try {
					ui.setStatus(STATUS_KEY, text ?? undefined);
				} catch {
					// Stale context after session replacement; next event refreshes.
				}
			}
			return;
		}
		lastAttempt = now;
		const resolved = await resolveCandidate();
		try {
			ui.setStatus(STATUS_KEY, resolved ? (formatStatus(resolved.snapshot) ?? undefined) : undefined);
		} catch {
			// Stale context after session replacement; next event refreshes.
		}
	}

	const schedule = (ctx: { mode: string; ui: UI }) => {
		if (ctx.mode !== "tui") return;
		if (!inFlight) {
			inFlight = refresh(ctx.ui).finally(() => {
				inFlight = null;
			});
		}
	};

	pi.on("session_start", (_event, ctx) => schedule(ctx as { mode: string; ui: UI }));
	pi.on("agent_end", (_event, ctx) => schedule(ctx as { mode: string; ui: UI }));

	pi.registerCommand(COMMAND_NAME, {
		description: "Choose which Claude account the usage footer shows (5h + weekly remaining)",
		handler: async (args, ctx) => {
			const ui = ctx.ui as UI;
			const raw = args.trim();
			if (raw === "auto" || raw.startsWith("keychain:") || raw === "file") {
				await saveSelection(raw);
				await refresh(ui);
				ui.notify?.(`Claude usage footer now follows: ${raw}`, "info");
				return;
			}
			if (raw) {
				ui.notify?.(`Unknown account "${raw}". Use "auto", "file", or a keychain:<name> id from /${COMMAND_NAME} with no arguments.`, "warning");
				return;
			}
			const candidates = await listCandidates();
			if (candidates.length === 0) {
				ui.notify?.("No Claude login found (credentials file or login keychain). Sign in with `claude auth login` first.", "warning");
				return;
			}
			const live = await Promise.all(
				candidates.map(async (candidate) => ({ candidate, snapshot: await probe(candidate) })),
			);
			const options = [
				"auto (first account that returns data)",
				...live.map(({ candidate, snapshot }) => {
					const detail = snapshot?.weekly ? `wk:${snapshot.weekly.remaining}% left` : "unreachable";
					return `${candidate.id} — ${candidate.label} — ${detail}`;
				}),
			];
			if (typeof ui.select !== "function") {
				ui.notify?.(`Claude accounts:\n${options.join("\n")}`, "info");
				return;
			}
			const choice = await ui.select("Claude account for the usage footer", options);
			if (!choice) return;
			const selectedId = choice === options[0] ? "auto" : choice.split(" — ")[0] ?? "auto";
			await saveSelection(selectedId);
			await refresh(ui);
			ui.notify?.(`Claude usage footer now follows: ${selectedId}`, "info");
		},
	});
}
