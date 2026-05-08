/**
 * Detection and removal of the original `openwolf` (Claude Code) package.
 *
 * openwolf-opencode is a drop-in replacement. Having both installed
 * simultaneously serves no purpose and causes PATH confusion.
 */

import { execSync } from "node:child_process";

/** Returns true if the original `openwolf` binary is resolvable on PATH. */
export function isOldOpenwolfInstalled(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where openwolf" : "which openwolf";
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to uninstall `openwolf` globally.
 * Tries npm → pnpm → yarn in order.
 * Returns true if one of them succeeded.
 */
export function uninstallOldOpenwolf(): boolean {
  const commands: string[] = [
    "npm uninstall -g openwolf",
    "pnpm remove -g openwolf",
    "yarn global remove openwolf",
  ];
  for (const cmd of commands) {
    try {
      execSync(cmd, { stdio: "ignore" });
      return true;
    } catch { /* try next manager */ }
  }
  return false;
}

/**
 * Lines to append to .gitignore so only project-knowledge files are tracked.
 *
 * Committed (important):
 *   .wolf/cerebrum.md, memory.md, anatomy.md, buglog.json, config.json,
 *   OPENWOLF.md, identity.md, cron-manifest.json, reframe-frameworks.md,
 *   token-ledger.json, AGENTS.md, opencode.json, .opencode/plugins/wolf.js
 *
 * Ignored (runtime / generated / ephemeral):
 *   daemon.log, cron-state.json, designqc-report.json, suggestions.json,
 *   backups/, hooks/ (legacy Claude Code scripts + session state)
 */
export const WOLF_GITIGNORE_BLOCK = `
# OpenWolf — runtime & generated files (do not commit)
.wolf/daemon.log
.wolf/cron-state.json
.wolf/designqc-report.json
.wolf/suggestions.json
.wolf/backups/
.wolf/hooks/
`;

/** Sentinel: first meaningful line of the block used to detect existing entries. */
export const WOLF_GITIGNORE_SENTINEL = "# OpenWolf — runtime & generated files";

/**
 * Sentinel embedded in AGENTS.md to detect whether the wolf memory section
 * is already present.  Also used as the opening tag of the section itself.
 *
 * Strategy:
 *   - If AGENTS.md doesn't exist → create it with the wolf section (the sentinel is inside).
 *   - If AGENTS.md exists but lacks the sentinel → append the wolf section non-destructively.
 *   - If AGENTS.md exists and contains the sentinel → leave the file completely untouched.
 *
 * This means AGENTS.md is safe for any team to use as a shared agent rules file;
 * wolf simply adds its own clearly-delimited block without clobbering existing content.
 */
export const WOLF_AGENTS_SENTINEL = "<!-- openwolf-start -->";
