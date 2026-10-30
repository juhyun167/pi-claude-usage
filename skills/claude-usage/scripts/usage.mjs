#!/usr/bin/env node
// Show Claude subscription usage limits (5-hour session, weekly) for the
// Anthropic account Pi is logged into.
// Usage: node usage.mjs [--json] [--color] [--input FILE]
//   --input FILE  render a saved --json response instead of calling the API
//
// Plain Node (>= 22, which Pi itself requires), no other dependencies, so it runs
// the same on Windows, macOS and Linux. The /claude-usage extension imports run().
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL_S = 60;

export class UsageError extends Error {}

// The endpoint is rate limited: reuse a response younger than 60s, and fall back
// to an older cached one (with a note) if a request fails.
function cachePath() {
	const user = process.getuid?.() ?? os.userInfo().username.replace(/[^\w.-]/g, "_");
	return path.join(os.tmpdir(), `claude-usage-cache-${user}.json`);
}

/** Cached body and its age in seconds, or null if there is no non-empty cache. */
function readCache(file) {
	try {
		const st = fs.statSync(file);
		if (st.size === 0) return null;
		return { body: fs.readFileSync(file, "utf8"), age: (Date.now() - st.mtimeMs) / 1000 };
	} catch {
		return null;
	}
}

/** Windows: full path of `name` on PATH (honoring PATHEXT), or null. */
function whichWin(name) {
	const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
		.filter((e) => /^\.(com|exe|bat|cmd)$/i.test(e)); // what cmd.exe can run
	for (const dir of (process.env.PATH || "").split(";").filter(Boolean)) {
		for (const ext of exts) {
			const file = path.join(dir.replace(/^"|"$/g, ""), name + ext.toLowerCase());
			if (fs.existsSync(file)) return file;
		}
	}
	return null;
}

function getToken() {
	const args = ["auth", "print-bearer-token", "--provider", "anthropic"];
	let cmd = "pi";
	let cmdArgs = args;
	let shell = false;
	if (process.platform === "win32") {
		const pi = whichWin("pi");
		if (!pi) return Promise.reject(new UsageError("pi is required"));
		// npm installs `pi` as a .cmd shim, which Node only runs through a shell.
		// The command line is constant, so the shell adds no injection risk.
		if (!/\.(exe|com)$/i.test(pi)) {
			cmd = `"${pi}" ${args.join(" ")}`;
			cmdArgs = [];
			shell = true;
		} else cmd = pi;
	}
	return new Promise((resolve, reject) => {
		execFile(cmd, cmdArgs, { shell, timeout: 10_000, windowsHide: true }, (err, stdout) => {
			const token = String(stdout).trim();
			if (err || !token) {
				reject(new UsageError(
					err?.code === "ENOENT"
						? "pi is required"
						: "Pi has no Anthropic OAuth login. Sign in with a Claude Pro/Max subscription (/login).",
				));
			} else resolve(token);
		});
	});
}

/** Fetches the usage response, writes it to the cache and returns the body. */
async function fetchUsage(file) {
	const token = await getToken();
	let res;
	try {
		res = await fetch(ENDPOINT, {
			headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		throw new UsageError("Couldn't reach api.anthropic.com.");
	}
	const body = await res.text().catch(() => "");
	switch (res.status) {
		case 200:
			fs.writeFileSync(file, body, { mode: 0o600 });
			return body;
		case 401:
		case 403:
			throw new UsageError("Anthropic rejected the login. Sign in again (/login).");
		case 429:
			throw new UsageError("Rate limited by Anthropic. Try again in a minute.");
		default:
			throw new UsageError(`Request failed (HTTP ${res.status}).`);
	}
}

// ---------------------------------------------------------------------------
// Rendering. --color: mid-tone ANSI 256 colors, readable on light and dark themes.
// Every segment sets its own color, because a host may wrap the output in its own color.

export function render(data, { color = false } = {}) {
	const c = (s, n) => (color ? `\x1b[38;5;${n}m${s}\x1b[39m` : s);
	const plain = (s) => (color ? `\x1b[39m${s}` : s); // terminal default fg
	const dim = (s) => c(s, 244);
	const level = (p) => (p >= 80 ? 167 : p >= 50 ? 172 : 71);
	const pct = (v) => Math.max(Math.round(v ?? 0), 0);
	const isSet = (v) => v !== null && v !== undefined && v !== false;
	const or = (v, d) => (isSet(v) ? v : d);

	const ts = (s) => {
		if (!isSet(s)) return null;
		const t = Date.parse(s);
		return Number.isNaN(t) ? null : t / 1000;
	};
	const rel = (t) => {
		if (t === null) return "";
		const s = t - Date.now() / 1000;
		const two = (a, ua, b, ub) => `${a}${ua}` + (b > 0 ? ` ${b}${ub}` : "");
		if (s <= 0) return "(resets now)";
		if (s < 60) return "(resets in <1m)";
		if (s < 3600) return `(resets in ${Math.floor(s / 60)}m)`;
		if (s < 86400) return `(resets in ${two(Math.floor(s / 3600), "h", Math.floor((s % 3600) / 60), "m")})`;
		return `(resets in ${two(Math.floor(s / 86400), "d", Math.floor((s % 86400) / 3600), "h")})`;
	};
	const bar = (p) => {
		const n = Math.min(Math.floor(p / 5), 20);
		return c("█".repeat(n), level(p)) + dim("░".repeat(20 - n));
	};
	// amounts are in minor units (cents): 21548 with 2 decimals -> "215.48"
	const money = (v, d) => {
		v = Math.round(or(v, 0));
		const m = Math.round(10 ** d);
		if (d === 0) return `${v}`;
		return `${Math.floor(v / m)}.${String(v % m).padStart(d, "0")}`;
	};
	const name = (l) => {
		if (l.kind === "session") return "5-hour session";
		if (l.kind === "weekly_all") return "Weekly (all models)";
		if (l.kind === "weekly_scoped") return `Weekly (${or(l.scope?.model?.display_name, "model")})`;
		const k = String(or(l.kind, "limit")).replaceAll("_", " ");
		return k.slice(0, 1).toUpperCase() + k.slice(1);
	};

	const rows = (data.limits ?? []).map((l) => ({
		label: name(l),
		p: pct(l.percent),
		detail: rel(ts(l.resets_at)),
		tag: !isSet(l.severity) || l.severity === "normal" ? null : l.severity,
	}));
	const extra = data.extra_usage;
	if (extra?.is_enabled === true) {
		const d = or(extra.decimal_places, 2);
		const cur = or(extra.currency, "");
		const limit = or(extra.monthly_limit, 0);
		rows.push({
			label: "Extra usage",
			p: limit > 0 ? pct(or(extra.utilization, (100 * or(extra.used_credits, 0)) / limit)) : null,
			detail: limit > 0
				? `(${money(extra.used_credits, d)} / ${money(extra.monthly_limit, d)} ${cur})`
				: `(${money(extra.used_credits, d)} ${cur} used, no limit)`,
			tag: extra.spend_limit_reached === true ? "limit reached" : null,
		});
	}

	const w = Math.max(0, ...rows.map((r) => r.label.length));
	const lines = [c("Claude plan usage", 68)];
	if (rows.length === 0) lines.push(dim("  No limits reported."));
	for (const r of rows) {
		lines.push(
			plain(`  ${r.label.padEnd(w + 4)}`) +
				(r.p === null ? "" : `${bar(r.p)} ${c(`${String(r.p).padStart(3).slice(-3)}%`, level(r.p))} `) +
				dim(r.detail) +
				(r.tag ? `  ${c(`[${r.tag}]`, 167)}` : ""),
		);
	}
	const breakdown = (data.seven_day_breakdown?.rows ?? []).filter((r) => r.percent > 0);
	if (breakdown.length > 0) {
		lines.push(dim("  Weekly breakdown: ") + dim(breakdown.map((r) => `${r.display_name} ${r.percent}%`).join(", ")));
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------

/**
 * Returns the formatted output and an optional non-fatal note (e.g. stale cache).
 * Throws UsageError with a readable message on failure.
 */
export async function run({ json = false, color = false, input } = {}) {
	let body;
	let note = "";
	if (input) {
		try {
			body = fs.readFileSync(input, "utf8");
		} catch (e) {
			throw new UsageError(`can't read ${input}: ${e.message}`);
		}
	} else {
		const file = cachePath();
		const cached = readCache(file);
		if (cached && cached.age < CACHE_TTL_S) {
			body = cached.body;
		} else {
			try {
				body = await fetchUsage(file);
			} catch (e) {
				if (!(e instanceof UsageError) || !cached) throw e;
				note = `note: ${e.message} Showing data from ${Math.floor(cached.age / 60)}m ago.`;
				body = cached.body;
			}
		}
	}

	let data;
	try {
		data = JSON.parse(body);
	} catch {
		throw new UsageError("The usage response isn't valid JSON.");
	}
	return { output: json ? JSON.stringify(data, null, 2) : render(data, { color }), note };
}

function parseArgs(argv) {
	const opts = { json: false, color: false, input: undefined };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") opts.json = true;
		else if (a === "--color") opts.color = true;
		else if (a === "--input") {
			opts.input = argv[++i];
			if (!opts.input) throw new UsageError("--input needs a file");
		} else return null;
	}
	return opts;
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (e) {
		console.error(`error: ${e.message}`);
		process.exit(1);
	}
	if (!opts) {
		console.error("usage: usage.mjs [--json] [--color] [--input FILE]");
		process.exit(2);
	}
	try {
		const { output, note } = await run(opts);
		if (note) console.error(note);
		process.stdout.write(output + "\n");
	} catch (e) {
		console.error(`error: ${e instanceof UsageError ? e.message : e}`);
		process.exit(1);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
