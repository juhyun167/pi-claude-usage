/**
 * /claude-usage — show Claude subscription usage limits (5-hour session, weekly).
 * Named claude-usage rather than usage: many Pi packages register /usage, and
 * duplicate command names make Pi rename both (/usage:1, /usage:2).
 * Calls the bundled claude-usage skill script in-process, so no model tokens are
 * spent and no shell (bash, PowerShell) is needed on any platform.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore: plain JS module shared with the skill, no type declarations
import { run, UsageError } from "../skills/claude-usage/scripts/usage.mjs";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("claude-usage", {
		description: "Show Claude plan usage limits (5-hour session, weekly)",
		getArgumentCompletions: (prefix) =>
			"--json".startsWith(prefix) ? [{ value: "--json", label: "--json" }] : null,
		handler: async (args, ctx) => {
			const json = args.trim() === "--json";
			let result: { output: string; note: string };
			try {
				result = await run({ json, color: !json });
			} catch (e) {
				// Pi prefixes error notices with "Error: " itself
				ctx.ui.notify(e instanceof UsageError ? e.message : String(e), "error");
				return;
			}
			// The note is non-fatal (e.g. "showing data from 7m ago"); color it
			// explicitly, since it follows the output's last color reset
			const note = result.note.trim();
			const dimNote = note ? `\n\x1b[38;5;244m  ${note}\x1b[39m` : "";
			ctx.ui.notify(result.output.trimEnd() + dimNote, "info");
		},
	});
}
