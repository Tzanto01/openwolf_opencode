import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { execSync, execFileSync } from "node:child_process";
import { findProjectRoot } from "../scanner/project-root.js";
import { scanProject } from "../scanner/anatomy-scanner.js";
import { readJSON, writeJSON, readText, writeText, appendText } from "../utils/fs-safe.js";
import { ensureDir } from "../utils/paths.js";
import { isWindows } from "../utils/platform.js";
import { registerProject } from "./registry.js";
import { assignProjectPorts } from "../utils/ports.js";
import {
  isOldOpenwolfInstalled,
  uninstallOldOpenwolf,
  WOLF_GITIGNORE_BLOCK,
  WOLF_GITIGNORE_SENTINEL,
  WOLF_AGENTS_SENTINEL,
} from "../utils/detect.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json
function getVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

// Files that are safe to overwrite on upgrade (config/protocol, not user data)
const ALWAYS_OVERWRITE = [
  "OPENWOLF.md",
  "config.json",
  "reframe-frameworks.md",
];

// Files that contain user/session data — only create if missing, never overwrite
const CREATE_IF_MISSING = [
  "identity.md",
  "cerebrum.md",
  "memory.md",
  "anatomy.md",
  "token-ledger.json",
  "buglog.json",
  "cron-manifest.json",
  "cron-state.json",
  "designqc-report.json",
  "suggestions.json",
];

export async function initCommand(): Promise<void> {
  // Check Node.js version
  const nodeVersion = parseInt(process.version.slice(1), 10);
  if (nodeVersion < 20) {
    console.error(`Node.js 20+ required. Current: ${process.version}`);
    process.exit(1);
  }

  // ── Old openwolf detection ────────────────────────────────────────────
  // openwolf-opencode is a full replacement. Having both installed simultaneously
  // causes PATH confusion and serves no purpose.
  if (isOldOpenwolfInstalled()) {
    console.log("⚠  Old openwolf package detected on PATH.");
    console.log("   openwolf-opencode is a full replacement — having both installed");
    console.log("   causes confusion and serves no purpose.");
    console.log("");

    if (!process.stdin.isTTY) {
      // Non-interactive (CI / piped) — skip prompt, continue without removing
      console.log("   Non-interactive mode: skipping auto-removal.");
      console.log("   Remove it manually when ready: npm uninstall -g openwolf");
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("   Auto-remove openwolf now? [Y/n]: ");
      rl.close();

      if (answer.trim().toLowerCase() !== "n") {
        if (uninstallOldOpenwolf()) {
          console.log("  ✓ Removed old openwolf.");
        } else {
          console.log("  ✗ Auto-removal failed. Remove it manually:");
          console.log("      npm uninstall -g openwolf");
          console.log("  Continuing init...");
        }
      } else {
        console.log("   Skipping. Remove it later with: npm uninstall -g openwolf");
      }
    }
    console.log("");
  }

  // Detect project root
  const projectRoot = findProjectRoot();
  console.log(`Project root: ${projectRoot}`);

  const wolfDir = path.join(projectRoot, ".wolf");
  const isUpgrade = fs.existsSync(wolfDir);

  const version = getVersion();

  if (isUpgrade) {
    console.log(`Upgrading OpenWolf to v${version}...`);
  }

  // Create .wolf/ directory
  ensureDir(wolfDir);

  // Find templates directory
  const actualTemplatesDir = findTemplatesDir();

  // --- Template files ---
  let createdCount = 0;
  let skippedCount = 0;

  for (const file of ALWAYS_OVERWRITE) {
    writeTemplateFile(actualTemplatesDir, wolfDir, file);
    createdCount++;
  }

  for (const file of CREATE_IF_MISSING) {
    const destPath = path.join(wolfDir, file);
    if (fs.existsSync(destPath)) {
      skippedCount++;
    } else {
      writeTemplateFile(actualTemplatesDir, wolfDir, file);
      createdCount++;
    }
  }

  // Assign project-specific daemon/dashboard ports (deterministic hash of project root).
  // This overwrites the template defaults (18790/18791) so concurrent projects don't
  // collide on the same port.
  assignProjectPorts(wolfDir, projectRoot);

  // --- Cerebrum: seed project info only if fresh ---
  if (!isUpgrade) {
    seedCerebrum(wolfDir, projectRoot);
    seedIdentity(wolfDir, projectRoot);
  }

  // --- Token ledger: set created_at only if empty ---
  const ledgerPath = path.join(wolfDir, "token-ledger.json");
  const ledger = readJSON<Record<string, unknown>>(ledgerPath, {});
  if (!ledger.created_at) {
    ledger.created_at = new Date().toISOString();
    writeJSON(ledgerPath, ledger);
  }

  // --- AGENTS.md: create if missing, or append wolf section if sentinel absent ---
  // Never overwrite existing content — other agents/frameworks may share this file.
  const agentsMdPath = path.join(projectRoot, "AGENTS.md");
  const agentsSection = readTemplateContent("agents.md", actualTemplatesDir);
  if (!fs.existsSync(agentsMdPath)) {
    writeText(agentsMdPath, agentsSection + "\n");
    console.log("  ✓ Created AGENTS.md");
  } else {
    const existing = readText(agentsMdPath);
    if (!existing.includes(WOLF_AGENTS_SENTINEL)) {
      appendText(agentsMdPath, `\n${agentsSection}\n`);
      console.log("  ✓ Appended OpenWolf section to existing AGENTS.md");
    }
    // else: wolf section already present — leave the file untouched
  }

  // --- opencode.json: create or merge ---
  const opencodePath = path.join(projectRoot, "opencode.json");
  const wolfInstructions = [".wolf/cerebrum.md", ".wolf/memory.md", ".wolf/anatomy.md"];
  if (fs.existsSync(opencodePath)) {
    try {
      const existing = readJSON<Record<string, unknown>>(opencodePath, {});
      const currentInstructions: string[] = Array.isArray(existing.instructions)
        ? (existing.instructions as string[])
        : [];
      const merged = [...new Set([...wolfInstructions, ...currentInstructions])];
      existing.instructions = merged;
      writeJSON(opencodePath, existing);
    } catch {
      // File exists but is invalid JSON — leave it alone
    }
  } else {
    const template = readTemplateContent("opencode.json", actualTemplatesDir);
    writeText(opencodePath, template);
  }

  // --- OpenCode plugin: always update (bug fixes) ---
  const opencodePluginsDir = path.join(projectRoot, ".opencode", "plugins");
  ensureDir(opencodePluginsDir);
  const pluginSrc = path.join(actualTemplatesDir, "wolf-plugin.js");
  const pluginDest = path.join(opencodePluginsDir, "wolf.js");
  if (fs.existsSync(pluginSrc)) {
    fs.copyFileSync(pluginSrc, pluginDest);
  }

  // --- .git/hooks: remove any stale wolf pre-commit hooks from old openwolf ---
  const gitHooksDir = path.join(projectRoot, ".git", "hooks");
  if (fs.existsSync(gitHooksDir)) {
    const gitHookFiles = fs.readdirSync(gitHooksDir).filter((f) => !f.endsWith(".sample"));
    for (const hookFile of gitHookFiles) {
      const hookPath = path.join(gitHooksDir, hookFile);
      try {
        const content = fs.readFileSync(hookPath, "utf-8");
        if (content.includes(".wolf/hooks/")) {
          fs.unlinkSync(hookPath);
          console.log(`  ✓ Removed stale wolf git hook: .git/hooks/${hookFile}`);
        }
      } catch { /* non-fatal */ }
    }
  }

  // --- .gitignore: add wolf runtime/generated entries (only once) ---
  // Only project-knowledge files are committed; ephemeral runtime files are ignored.
  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const existing = readText(gitignorePath);
    if (!existing.includes(WOLF_GITIGNORE_SENTINEL)) {
      appendText(gitignorePath, WOLF_GITIGNORE_BLOCK);
    }
  } else {
    writeText(gitignorePath, WOLF_GITIGNORE_BLOCK.trimStart());
  }

  // --- Anatomy scan: only on fresh init ---
  let fileCount = 0;
  if (!isUpgrade) {
    try {
      fileCount = scanProject(wolfDir, projectRoot);
    } catch {
      console.log("  Anatomy scan deferred — will run on first session.");
    }
  } else {
    // On upgrade, read existing count
    try {
      const anatomyContent = readText(path.join(wolfDir, "anatomy.md"));
      const m = anatomyContent.match(/Files:\s*(\d+)/);
      fileCount = m ? parseInt(m[1], 10) : 0;
    } catch {
      fileCount = 0;
    }
  }

  // --- Daemon ---
  let daemonStatus = "start manually with: openwolf daemon start";
  try {
    const pm2Cmd = isWindows() ? "where pm2" : "which pm2";
    execSync(pm2Cmd, { stdio: "ignore" });
    const name = `openwolf-${path.basename(projectRoot)}`;
    // Resolve daemon script relative to openwolf's install dir, not the target project
    const daemonScript = path.resolve(__dirname, "..", "daemon", "wolf-daemon.js");
    try {
      execSync(
        `pm2 start "${daemonScript}" --name "${name}" --cwd "${projectRoot}"`,
        { stdio: "ignore", env: { ...process.env, OPENWOLF_PROJECT_ROOT: projectRoot } }
      );
      execSync("pm2 save", { stdio: "ignore" });
      daemonStatus = "running via pm2";
    } catch {
      daemonStatus = "pm2 found but daemon start failed. Try: openwolf daemon start";
    }
  } catch {
    daemonStatus = "pm2 not found. Install with: pnpm add -g pm2";
  }

  // --- Register in central registry (skip if this IS the openwolf source repo) ---
  try {
    const projectName = detectProjectName(projectRoot);
    if (projectName === "openwolf-opencode") {
      // Don't register the openwolf dev repo — it would get updated by `openwolf update`
    } else {
      registerProject(projectRoot, projectName, version);
    }
  } catch {
    // Non-fatal — registry is a convenience feature
  }

  // --- Summary ---
  console.log("");
  if (isUpgrade) {
    console.log(`  ✓ OpenWolf upgraded to v${version}`);
    console.log(`  ✓ All .wolf data preserved (${skippedCount} files: cerebrum, memory, anatomy, buglog, ledger)`);
    console.log(`  ✓ OpenCode plugin updated (.opencode/plugins/wolf.js)`);
    console.log(`  ✓ ${createdCount} config files updated`);
    console.log(`  ✓ Anatomy: ${fileCount} files tracked (unchanged)`);
  } else {
    console.log(`  ✓ OpenWolf v${version} initialized`);
    console.log(`  ✓ .wolf/ created with ${createdCount} files`);
    console.log(`  ✓ AGENTS.md created`);
    console.log(`  ✓ opencode.json configured`);
    console.log(`  ✓ OpenCode plugin installed (.opencode/plugins/wolf.js)`);
    console.log(`  ✓ Anatomy scan: ${fileCount} files indexed`);
  }
  console.log(`  ✓ Daemon: ${daemonStatus}`);
  console.log("");
  console.log("  You're ready. Just use your AI agent as normal — OpenWolf is watching.");
  console.log("");
}

// ─── Helpers ─────────────────────────────────────────────────

function findTemplatesDir(): string {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "src", "templates"),
    path.resolve(__dirname, "..", "..", "src", "templates"),
    path.resolve(__dirname, "..", "templates"),
    path.resolve(__dirname, "templates"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0]; // fallback — generateTemplate will handle missing files
}

function writeTemplateFile(templatesDir: string, wolfDir: string, file: string): void {
  const srcPath = path.join(templatesDir, file);
  const destPath = path.join(wolfDir, file);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
  } else {
    generateTemplate(destPath, file);
  }
}

function readTemplateContent(filename: string, templatesDir: string): string {
  const filePath = path.join(templatesDir, filename);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf-8");
  }
  return getEmbeddedTemplate(filename);
}

function getEmbeddedTemplate(filename: string): string {
  const templates: Record<string, string> = {
    "agents.md": [
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
    ].join("\n"),
    "opencode.json": JSON.stringify({ instructions: [".wolf/cerebrum.md", ".wolf/memory.md", ".wolf/anatomy.md"] }, null, 2),
  };
  return templates[filename] ?? "";
}

function generateTemplate(destPath: string, file: string): void {
  const templates: Record<string, string> = {
    "OPENWOLF.md": `# OpenWolf Operating Protocol\n\nYou are working in an OpenWolf-managed project. These rules apply every turn.\n\n## File Navigation\n\n1. Check \`.wolf/anatomy.md\` BEFORE reading any file.\n2. If the description is sufficient, do NOT read the full file.\n3. If a file is not in anatomy.md, search with Grep/Glob.\n\n## Code Generation\n\n1. Read \`.wolf/cerebrum.md\` and respect every entry.\n2. Check \`## Do-Not-Repeat\` section.\n\n## After Actions\n\n1. Append to \`.wolf/memory.md\`.\n2. After file changes: update \`.wolf/anatomy.md\`.\n\n## Token Discipline\n\n- Never re-read a file already read this session.\n- Prefer anatomy.md descriptions over full reads.\n`,
    "identity.md": `# Identity\n\n- **Name:** Wolf\n- **Role:** AI development assistant for this project\n- **Tone:** Direct, concise, technically precise\n`,
    "cerebrum.md": `# Cerebrum\n\n> OpenWolf's learning memory.\n\n## User Preferences\n\n## Key Learnings\n\n## Do-Not-Repeat\n\n## Decision Log\n`,
    "memory.md": `# Memory\n\n> Chronological action log.\n`,
    "anatomy.md": `# anatomy.md\n\n> Project structure index. Pending initial scan.\n`,
    "config.json": JSON.stringify({
      version: 1,
      openwolf: {
        enabled: true,
        anatomy: { auto_scan_on_init: true, rescan_interval_hours: 6, max_description_length: 100, max_files: 500, exclude_patterns: ["node_modules", ".git", "dist", "build", ".wolf", ".next", ".nuxt", "coverage", "__pycache__", ".cache", "target", ".vscode", ".idea", ".turbo", ".vercel", ".netlify", ".output", "*.min.js", "*.min.css"] },
        token_audit: { enabled: true, report_frequency: "weekly", waste_threshold_percent: 15, chars_per_token_code: 3.5, chars_per_token_prose: 4.0 },
        cron: { enabled: true, max_retry_attempts: 3, dead_letter_enabled: true, heartbeat_interval_minutes: 30, providers: [{ type: "openai_api", priority: 1 }, { type: "anthropic_api", priority: 2 }, { type: "openrouter_api", priority: 3 }], fallback_on_rate_limit: true },
        memory: { consolidation_after_days: 7, max_entries_before_consolidation: 200 },
        cerebrum: { max_tokens: 2000, reflection_frequency: "weekly" },
        daemon: { port: 18790, log_level: "info" },
        dashboard: { enabled: true, port: 18791 },
        designqc: { enabled: true, viewports: [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 375, height: 812 }], max_screenshots: 6, chrome_path: null },
      },
    }, null, 2),
    "token-ledger.json": JSON.stringify({ version: 1, created_at: "", lifetime: { total_tokens_estimated: 0, total_reads: 0, total_writes: 0, total_sessions: 0, anatomy_hits: 0, anatomy_misses: 0, repeated_reads_blocked: 0, estimated_savings_vs_bare_cli: 0 }, sessions: [], daemon_usage: [], waste_flags: [], optimization_report: { last_generated: null, patterns: [] } }, null, 2),
    "buglog.json": JSON.stringify({ version: 1, bugs: [] }, null, 2),
    "cron-manifest.json": JSON.stringify({ version: 1, tasks: [] }, null, 2),
    "cron-state.json": JSON.stringify({ last_heartbeat: null, engine_status: "initialized", execution_log: [], dead_letter_queue: [], upcoming: [] }, null, 2),
    "designqc-report.json": JSON.stringify({ captured_at: null, captures: [], total_size_kb: 0, estimated_tokens: 0 }, null, 2),
    "suggestions.json": JSON.stringify({ suggestions: [], generated_at: null }, null, 2),
  };

  const content = templates[file] ?? "";
  fs.writeFileSync(destPath, content, "utf-8");
}

function seedCerebrum(wolfDir: string, projectRoot: string): void {
  const projectName = detectProjectName(projectRoot);
  const projectDescription = detectProjectDescription(projectRoot);
  if (!projectName && !projectDescription) return;

  const cerebrumPath = path.join(wolfDir, "cerebrum.md");
  let cerebrum = readText(cerebrumPath);
  const projectInfo = [
    `- **Project:** ${projectName || path.basename(projectRoot)}`,
    projectDescription ? `- **Description:** ${projectDescription}` : "",
  ].filter(Boolean).join("\n");

  // Insert after ## Key Learnings section
  cerebrum = cerebrum.replace(
    /## Key Learnings\n\n<!-- Project-specific conventions discovered during development\. -->/,
    `## Key Learnings\n\n${projectInfo}`
  );
  // Fallback: if the comment wasn't found (embedded template), try simpler pattern
  if (!cerebrum.includes("**Project:**")) {
    cerebrum = cerebrum.replace(
      /## Key Learnings\n/,
      `## Key Learnings\n\n${projectInfo}\n`
    );
  }
  cerebrum = cerebrum.replace(/Last updated: —/, `Last updated: ${new Date().toISOString().slice(0, 10)}`);
  writeText(cerebrumPath, cerebrum);
}

function seedIdentity(wolfDir: string, projectRoot: string): void {
  const projectName = detectProjectName(projectRoot);
  if (!projectName) return;

  const identityPath = path.join(wolfDir, "identity.md");
  let content = readText(identityPath);
  content = content.replace(/\*\*Name:\*\* Wolf/, `**Name:** ${projectName}`);
  content = content.replace(
    /\*\*Role:\*\* AI development assistant for this project/,
    `**Role:** AI development assistant for ${projectName}`
  );
  writeText(identityPath, content);
}

function detectProjectName(projectRoot: string): string {
  // Try package.json
  const pkgPath = path.join(projectRoot, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (pkg.name) return pkg.name;
  } catch {}
  // Try Cargo.toml
  try {
    const cargo = fs.readFileSync(path.join(projectRoot, "Cargo.toml"), "utf-8");
    const m = cargo.match(/^name\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  } catch {}
  // Try pyproject.toml
  try {
    const py = fs.readFileSync(path.join(projectRoot, "pyproject.toml"), "utf-8");
    const m = py.match(/^name\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  } catch {}
  return path.basename(projectRoot);
}

function detectProjectDescription(projectRoot: string): string {
  // Try package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
    if (pkg.description) return pkg.description;
  } catch {}
  // Try README first line/paragraph
  for (const readme of ["README.md", "readme.md", "README.rst", "README.txt"]) {
    try {
      const content = fs.readFileSync(path.join(projectRoot, readme), "utf-8");
      const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("=") && !l.startsWith("-") && !l.startsWith("!["));
      if (lines.length > 0) return lines[0].trim().slice(0, 200);
    } catch {}
  }
  return "";
}
