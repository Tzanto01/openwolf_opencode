/**
 * wolf migrate — Migrate an existing openwolf (Claude Code) installation
 * to openwolf-opencode (OpenCode native).
 *
 * Safe to run on any project that has .wolf/ — whether it was set up with
 * the original cytostack/openwolf or any derivative.
 *
 * What it does:
 *   1. Backs up all user data to .wolf/backups/migration-TIMESTAMP/
 *   2. Removes old Claude Code hook scripts from .wolf/hooks/
 *   3. Strips wolf hook entries from .claude/settings.json (preserves other hooks)
 *   4. Removes .claude/rules/openwolf.md
 *   5. Strips the OpenWolf snippet from CLAUDE.md (preserves user content)
 *   6. Installs AGENTS.md, opencode.json, and .opencode/plugins/wolf.js
 *   7. Updates .wolf/OPENWOLF.md and config.json to the current version
 *
 * Never touches: cerebrum.md, memory.md, anatomy.md, buglog.json,
 *                token-ledger.json, identity.md, cron-manifest.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { findProjectRoot } from "../scanner/project-root.js";
import { readJSON, writeJSON, readText, writeText, appendText } from "../utils/fs-safe.js";
import { ensureDir } from "../utils/paths.js";
import { assignProjectPorts, projectPorts } from "../utils/ports.js";
import { isOldOpenwolfInstalled, uninstallOldOpenwolf, WOLF_GITIGNORE_BLOCK, WOLF_GITIGNORE_SENTINEL, WOLF_AGENTS_SENTINEL, } from "../utils/detect.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Files that contain user data — preserved and backed up, never modified
const USER_DATA_FILES = [
    "cerebrum.md",
    "memory.md",
    "anatomy.md",
    "buglog.json",
    "token-ledger.json",
    "cron-manifest.json",
    "cron-state.json",
    "identity.md",
    "suggestions.json",
    "designqc-report.json",
];
// Old Claude Code hook script filenames
const OLD_HOOK_FILES = [
    "session-start.js",
    "pre-read.js",
    "pre-write.js",
    "post-read.js",
    "post-write.js",
    "stop.js",
    "shared.js",
    "package.json",
];
export async function migrateCommand() {
    const projectRoot = findProjectRoot();
    const wolfDir = path.join(projectRoot, ".wolf");
    if (!fs.existsSync(wolfDir)) {
        console.log("No .wolf/ directory found in this project.");
        console.log("This project has not been initialized with openwolf.");
        console.log("Run: wolf init");
        return;
    }
    console.log(`Migrating: ${projectRoot}`);
    console.log("");
    // ── 1. Backup user data ──────────────────────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    const backupDir = path.join(wolfDir, "backups", `migration-${timestamp}`);
    ensureDir(backupDir);
    let backedUp = 0;
    for (const file of USER_DATA_FILES) {
        const src = path.join(wolfDir, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(backupDir, file));
            backedUp++;
        }
    }
    console.log(`  ✓ Backed up ${backedUp} user data files → .wolf/backups/migration-${timestamp}/`);
    // ── 2. Remove old hook scripts ───────────────────────────────────────
    const hooksDir = path.join(wolfDir, "hooks");
    let removedHooks = 0;
    if (fs.existsSync(hooksDir)) {
        for (const f of OLD_HOOK_FILES) {
            const p = path.join(hooksDir, f);
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                removedHooks++;
            }
        }
        // Remove the hooks dir itself if now empty
        try {
            const remaining = fs.readdirSync(hooksDir);
            if (remaining.length === 0)
                fs.rmdirSync(hooksDir);
        }
        catch { /* non-fatal */ }
    }
    if (removedHooks > 0) {
        console.log(`  ✓ Removed ${removedHooks} old hook scripts from .wolf/hooks/`);
    }
    else {
        console.log("  ○ No old hook scripts found");
    }
    // ── 3a. Remove wolf entries from .git/hooks/ ─────────────────────────
    const gitHooksDir = path.join(projectRoot, ".git", "hooks");
    if (fs.existsSync(gitHooksDir)) {
        const gitHookFiles = fs.readdirSync(gitHooksDir).filter((f) => !f.endsWith(".sample"));
        let removedGitHooks = 0;
        for (const hookFile of gitHookFiles) {
            const hookPath = path.join(gitHooksDir, hookFile);
            try {
                const content = fs.readFileSync(hookPath, "utf-8");
                if (content.includes(".wolf/hooks/")) {
                    fs.unlinkSync(hookPath);
                    removedGitHooks++;
                }
            }
            catch { /* non-fatal */ }
        }
        if (removedGitHooks > 0) {
            console.log(`  ✓ Removed ${removedGitHooks} wolf git hook(s) from .git/hooks/`);
        }
    }
    // ── 3. Strip wolf hooks from .claude/settings.json ───────────────────
    const claudeSettingsPath = path.join(projectRoot, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
        try {
            const settings = readJSON(claudeSettingsPath, {});
            const hooks = settings.hooks;
            if (hooks) {
                let stripped = false;
                for (const event of Object.keys(hooks)) {
                    const before = hooks[event].length;
                    hooks[event] = hooks[event].filter((entry) => !entry.hooks?.some((h) => h.command?.includes(".wolf/hooks/")));
                    if (hooks[event].length !== before)
                        stripped = true;
                    if (hooks[event].length === 0)
                        delete hooks[event];
                }
                if (Object.keys(hooks).length === 0)
                    delete settings.hooks;
                writeJSON(claudeSettingsPath, settings);
                if (stripped) {
                    console.log("  ✓ Removed wolf hooks from .claude/settings.json (non-wolf hooks preserved)");
                }
            }
        }
        catch {
            console.log("  ⚠ Could not parse .claude/settings.json — left unchanged");
        }
    }
    // ── 4. Remove .claude/rules/openwolf.md ─────────────────────────────
    const claudeRulesPath = path.join(projectRoot, ".claude", "rules", "openwolf.md");
    if (fs.existsSync(claudeRulesPath)) {
        fs.unlinkSync(claudeRulesPath);
        console.log("  ✓ Removed .claude/rules/openwolf.md");
    }
    // ── 5. Strip wolf snippet from CLAUDE.md ────────────────────────────
    const claudeMdPath = path.join(projectRoot, "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) {
        const content = readText(claudeMdPath);
        if (content.includes("OpenWolf")) {
            // Strip the known snippet patterns:
            // Pattern A: "# OpenWolf\n\n@.wolf/OPENWOLF.md\n\nThis project..." block
            // Pattern B: any block that looks like the openwolf snippet, followed by user content
            let stripped = content;
            // Remove the snippet line block (starts at # OpenWolf, ends before --- or next # header or EOF)
            stripped = stripped.replace(/^# OpenWolf\n[\s\S]*?(?=\n---\n|\n# |\n## )/m, "");
            // Fallback: remove the snippet if the above didn't match (no following content)
            if (stripped.includes("OpenWolf")) {
                stripped = stripped.replace(/^# OpenWolf\n[\s\S]*/m, "");
            }
            stripped = stripped.replace(/^\n+/, "").trimEnd();
            if (stripped !== content.trimEnd()) {
                if (stripped.length === 0) {
                    // File was only the snippet — delete it
                    fs.unlinkSync(claudeMdPath);
                    console.log("  ✓ Removed CLAUDE.md (contained only the OpenWolf snippet)");
                }
                else {
                    writeText(claudeMdPath, stripped + "\n");
                    console.log("  ✓ Stripped OpenWolf snippet from CLAUDE.md (user content preserved)");
                }
            }
        }
    }
    // ── 6. Install OpenCode integration ─────────────────────────────────
    const templatesDir = findTemplatesDir();
    // AGENTS.md — never overwrite; append wolf section if sentinel is absent
    const agentsMdPath = path.join(projectRoot, "AGENTS.md");
    if (!fs.existsSync(agentsMdPath)) {
        const content = readTemplateContent("agents.md", templatesDir);
        writeText(agentsMdPath, content + "\n");
        console.log("  ✓ Created AGENTS.md");
    }
    else {
        const existing = readText(agentsMdPath);
        if (!existing.includes(WOLF_AGENTS_SENTINEL)) {
            const section = readTemplateContent("agents.md", templatesDir);
            appendText(agentsMdPath, `\n${section}\n`);
            console.log("  ✓ Appended OpenWolf section to existing AGENTS.md");
        }
        else {
            console.log("  ○ AGENTS.md already contains wolf section — not modified");
        }
    }
    // opencode.json — create or merge instructions
    const opencodePath = path.join(projectRoot, "opencode.json");
    const wolfInstructions = [".wolf/cerebrum.md", ".wolf/memory.md", ".wolf/anatomy.md"];
    if (fs.existsSync(opencodePath)) {
        try {
            const existing = readJSON(opencodePath, {});
            const current = Array.isArray(existing.instructions)
                ? existing.instructions
                : [];
            existing.instructions = [...new Set([...wolfInstructions, ...current])];
            writeJSON(opencodePath, existing);
            console.log("  ✓ Merged wolf instructions into existing opencode.json");
        }
        catch {
            console.log("  ⚠ opencode.json exists but is invalid JSON — left unchanged");
        }
    }
    else {
        const tpl = readTemplateContent("opencode.json", templatesDir);
        writeText(opencodePath, tpl);
        console.log("  ✓ Created opencode.json");
    }
    // .opencode/plugins/wolf.js — always update
    const pluginsDir = path.join(projectRoot, ".opencode", "plugins");
    ensureDir(pluginsDir);
    const pluginSrc = path.join(templatesDir, "wolf-plugin.js");
    const pluginDest = path.join(pluginsDir, "wolf.js");
    if (fs.existsSync(pluginSrc)) {
        fs.copyFileSync(pluginSrc, pluginDest);
        console.log("  ✓ Installed .opencode/plugins/wolf.js");
    }
    // .gitignore — add wolf runtime/generated entries (only once)
    const gitignorePath = path.join(projectRoot, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
        const existing = readText(gitignorePath);
        if (!existing.includes(WOLF_GITIGNORE_SENTINEL)) {
            appendText(gitignorePath, WOLF_GITIGNORE_BLOCK);
        }
    }
    else {
        writeText(gitignorePath, WOLF_GITIGNORE_BLOCK.trimStart());
    }
    // ── 7. Update wolf protocol files (safe to overwrite) ───────────────
    const protocolFiles = ["OPENWOLF.md", "config.json", "reframe-frameworks.md"];
    let updatedProtocol = 0;
    for (const file of protocolFiles) {
        const src = path.join(templatesDir, file);
        const dest = path.join(wolfDir, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            updatedProtocol++;
        }
    }
    if (updatedProtocol > 0) {
        console.log(`  ✓ Updated ${updatedProtocol} wolf protocol files (OPENWOLF.md, config.json)`);
    }
    // ── 8. Assign project-specific ports ─────────────────────────────────
    assignProjectPorts(wolfDir, projectRoot);
    const ports = projectPorts(projectRoot);
    console.log(`  ✓ Assigned project-specific ports (daemon: ${ports.daemon}, dashboard: ${ports.dashboard})`);
    // ── Summary ──────────────────────────────────────────────────────────
    console.log("");
    console.log("  Migration complete.");
    console.log(`  User data preserved: cerebrum.md, memory.md, anatomy.md, buglog.json`);
    console.log("");
    console.log("  Next steps:");
    console.log("    wolf status          Verify OpenCode integration");
    console.log("    wolf daemon start    Restart the background daemon");
    // Offer to uninstall old openwolf as the final cleanup step
    if (isOldOpenwolfInstalled()) {
        console.log("");
        console.log("  Old openwolf package detected. Removing it now is safe — migration is complete.");
        if (!process.stdin.isTTY) {
            console.log("  Non-interactive mode: remove it manually when ready:");
            console.log("    npm uninstall -g openwolf");
        }
        else {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await rl.question("  Auto-remove openwolf now? [Y/n]: ");
            rl.close();
            if (answer.trim().toLowerCase() !== "n") {
                if (uninstallOldOpenwolf()) {
                    console.log("  ✓ Removed old openwolf.");
                }
                else {
                    console.log("  ✗ Auto-removal failed. Remove it manually:");
                    console.log("      npm uninstall -g openwolf");
                }
            }
            else {
                console.log("  Skipping. Remove it later with: npm uninstall -g openwolf");
            }
        }
    }
    console.log("");
}
// ── Helpers ──────────────────────────────────────────────────────────────
function findTemplatesDir() {
    const candidates = [
        path.resolve(__dirname, "..", "..", "..", "src", "templates"),
        path.resolve(__dirname, "..", "..", "src", "templates"),
        path.resolve(__dirname, "..", "templates"),
        path.resolve(__dirname, "templates"),
    ];
    for (const dir of candidates) {
        if (fs.existsSync(dir))
            return dir;
    }
    return candidates[0];
}
function readTemplateContent(filename, templatesDir) {
    const filePath = path.join(templatesDir, filename);
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8");
    }
    // Minimal embedded fallbacks
    if (filename === "agents.md") {
        return [
            "<!-- openwolf-start -->",
            "## OpenWolf Memory",
            "",
            "This project uses OpenWolf for persistent AI memory. Read these files at the start of every session:",
            "",
            "- `.wolf/cerebrum.md` — architectural decisions, patterns, hard-won learnings. **Read this first.**",
            "- `.wolf/memory.md` — rolling session log; check the last 20 lines for open threads.",
            "- `.wolf/anatomy.md` — auto-generated file index; check here before reading any project file.",
            "- `.wolf/buglog.json` — known bugs; check for open entries relevant to your task.",
            "",
            "**End of session:** append to `.wolf/memory.md`, update `.wolf/cerebrum.md` for any architectural decisions.",
            "<!-- openwolf-end -->",
        ].join("\n");
    }
    if (filename === "opencode.json") {
        return JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            instructions: [".wolf/cerebrum.md", ".wolf/memory.md", ".wolf/anatomy.md"],
        }, null, 2);
    }
    return "";
}
//# sourceMappingURL=migrate-cmd.js.map