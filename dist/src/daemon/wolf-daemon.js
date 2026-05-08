import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { findProjectRoot } from "../scanner/project-root.js";
import { readJSON, writeJSON } from "../utils/fs-safe.js";
import { Logger } from "../utils/logger.js";
import { CronEngine } from "./cron-engine.js";
import { startFileWatcher } from "./file-watcher.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Prefer explicit OPENWOLF_PROJECT_ROOT env (set by CLI commands) over cwd detection
const projectRoot = process.env.OPENWOLF_PROJECT_ROOT || findProjectRoot();
const wolfDir = path.join(projectRoot, ".wolf");
const config = readJSON(path.join(wolfDir, "config.json"), {
    openwolf: {
        daemon: { port: 18790, log_level: "info" },
        dashboard: { enabled: true, port: 18791 },
        cron: { enabled: true, heartbeat_interval_minutes: 30 },
    },
});
const logger = new Logger(path.join(wolfDir, "daemon.log"), config.openwolf.daemon.log_level);
const startTime = Date.now();
const wsClients = new Set();
// Express server
const app = express();
app.use(express.json());
// Serve dashboard static files
// In dist: dist/src/daemon/wolf-daemon.js → ../../../dist/dashboard/
const dashboardDir = path.resolve(__dirname, "..", "..", "..", "dist", "dashboard");
if (fs.existsSync(dashboardDir)) {
    app.use(express.static(dashboardDir));
}
// Detect project metadata
function detectProjectMeta() {
    let name = path.basename(projectRoot);
    let description = "";
    // Try package.json
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
        if (pkg.name)
            name = pkg.name;
        if (pkg.description)
            description = pkg.description;
    }
    catch { }
    // Try Cargo.toml for name if not found
    if (name === path.basename(projectRoot)) {
        try {
            const cargo = fs.readFileSync(path.join(projectRoot, "Cargo.toml"), "utf-8");
            const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
            if (nameMatch)
                name = nameMatch[1];
        }
        catch { }
    }
    // If no description, try cerebrum.md project description
    if (!description) {
        try {
            const cerebrum = fs.readFileSync(path.join(wolfDir, "cerebrum.md"), "utf-8");
            const descMatch = cerebrum.match(/\*\*Project:\*\*\s*(.+)/);
            if (descMatch)
                description = descMatch[1].trim();
        }
        catch { }
    }
    // If still no description, try README first paragraph
    if (!description) {
        for (const readme of ["README.md", "readme.md", "README.rst"]) {
            try {
                const content = fs.readFileSync(path.join(projectRoot, readme), "utf-8");
                const lines = content.split("\n");
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("!") && !trimmed.startsWith("=") && !trimmed.startsWith("-") && !trimmed.startsWith("<") && !trimmed.startsWith("[") && !trimmed.startsWith("```") && trimmed.length > 10) {
                        description = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
                        break;
                    }
                }
                if (description)
                    break;
            }
            catch { }
        }
    }
    return { name, description };
}
const projectMeta = detectProjectMeta();
// API routes
app.get("/api/health", (_req, res) => {
    const cronState = readJSON(path.join(wolfDir, "cron-state.json"), { engine_status: "unknown", last_heartbeat: null, dead_letter_queue: [] });
    const cronManifest = readJSON(path.join(wolfDir, "cron-manifest.json"), { tasks: [] });
    const taskCount = Array.isArray(cronManifest.tasks) ? cronManifest.tasks.length : 0;
    res.json({
        status: "healthy",
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        last_heartbeat: cronState.last_heartbeat,
        tasks: taskCount,
        dead_letters: cronState.dead_letter_queue.length,
    });
});
app.get("/api/project", (_req, res) => {
    res.json({
        name: projectMeta.name,
        description: projectMeta.description,
        root: projectRoot,
    });
});
app.get("/api/files", (_req, res) => {
    const files = {};
    const wolfFiles = [
        "OPENWOLF.md", "identity.md", "cerebrum.md", "memory.md", "anatomy.md",
        "config.json", "token-ledger.json", "buglog.json",
        "cron-manifest.json", "cron-state.json",
        "designqc-report.json",
    ];
    for (const file of wolfFiles) {
        try {
            files[file] = fs.readFileSync(path.join(wolfDir, file), "utf-8");
        }
        catch {
            files[file] = "";
        }
    }
    // Also try suggestions.json
    try {
        files["suggestions.json"] = fs.readFileSync(path.join(wolfDir, "suggestions.json"), "utf-8");
    }
    catch {
        files["suggestions.json"] = "";
    }
    res.json(files);
});
app.get("/api/designqc-report", (_req, res) => {
    const report = readJSON(path.join(wolfDir, "designqc-report.json"), null);
    res.json(report);
});
// Trigger a cron task by ID
app.post("/api/cron/run/:taskId", (req, res) => {
    const { taskId } = req.params;
    if (!cronEngine) {
        res.status(503).json({ error: "Cron engine not running" });
        return;
    }
    cronEngine.runTask(taskId).then(() => {
        res.json({ status: "ok", task_id: taskId });
    }).catch((err) => {
        res.status(500).json({ error: String(err) });
    });
});
// SPA fallback
app.get("/{*path}", (_req, res) => {
    const indexPath = path.join(dashboardDir, "index.html");
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    }
    else {
        res.status(404).json({ error: "Dashboard not built. Run: pnpm build:dashboard" });
    }
});
// Start HTTP server
const port = config.openwolf.dashboard.port;
const server = app.listen(port, () => {
    logger.info(`Dashboard server listening on port ${port}`);
});
// WebSocket server
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
    wsClients.add(ws);
    logger.info("WebSocket client connected");
    ws.on("message", (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleDashboardCommand(msg);
        }
        catch {
            logger.warn("Invalid WebSocket message received");
        }
    });
    ws.on("close", () => {
        wsClients.delete(ws);
    });
    // Send initial state
    broadcast({ type: "daemon_started", timestamp: new Date().toISOString() });
});
function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of wsClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    }
}
function handleDashboardCommand(msg) {
    switch (msg.type) {
        case "trigger_task":
            if (msg.task_id && cronEngine) {
                cronEngine.runTask(msg.task_id).catch((err) => {
                    logger.error(`Manual task trigger failed: ${err}`);
                });
            }
            break;
        case "retry_dead_letter":
            if (msg.task_id) {
                const statePath = path.join(wolfDir, "cron-state.json");
                const state = readJSON(statePath, {
                    dead_letter_queue: [],
                });
                state.dead_letter_queue = state.dead_letter_queue.filter((d) => d.task_id !== msg.task_id);
                writeJSON(statePath, state);
            }
            break;
        case "force_scan":
            if (cronEngine) {
                cronEngine.runTask("anatomy-rescan").catch((err) => {
                    logger.error(`Force scan failed: ${err}`);
                });
            }
            break;
        case "request_full_state":
            // Send all files
            try {
                const files = {};
                const wolfFiles = [
                    "OPENWOLF.md", "identity.md", "cerebrum.md", "memory.md", "anatomy.md",
                    "config.json", "token-ledger.json", "buglog.json",
                    "cron-manifest.json", "cron-state.json",
                    "designqc-report.json",
                ];
                for (const file of wolfFiles) {
                    try {
                        files[file] = fs.readFileSync(path.join(wolfDir, file), "utf-8");
                    }
                    catch {
                        files[file] = "";
                    }
                }
                broadcast({ type: "full_state", files, timestamp: new Date().toISOString() });
            }
            catch (err) {
                logger.error(`Full state request failed: ${err}`);
            }
            break;
    }
}
// Cron engine
let cronEngine = null;
if (config.openwolf.cron.enabled) {
    cronEngine = new CronEngine(wolfDir, projectRoot, logger, broadcast);
    cronEngine.start();
}
// File watcher
startFileWatcher(wolfDir, logger, broadcast);
// Health heartbeat
const heartbeatInterval = config.openwolf.cron.heartbeat_interval_minutes * 60 * 1000;
const heartbeatTimer = setInterval(() => {
    const statePath = path.join(wolfDir, "cron-state.json");
    const state = readJSON(statePath, {});
    state.last_heartbeat = new Date().toISOString();
    writeJSON(statePath, state);
    broadcast({ type: "health", status: "healthy", uptime: Math.floor((Date.now() - startTime) / 1000) });
}, heartbeatInterval);
// Update cron-state to running
const cronStatePath = path.join(wolfDir, "cron-state.json");
const cronState = readJSON(cronStatePath, {});
cronState.engine_status = "running";
cronState.last_heartbeat = new Date().toISOString();
writeJSON(cronStatePath, cronState);
logger.info("OpenWolf daemon started");
// Graceful shutdown
function shutdown() {
    logger.info("Daemon shutting down...");
    broadcast({ type: "daemon_stopping", timestamp: new Date().toISOString() });
    clearInterval(heartbeatTimer);
    if (cronEngine)
        cronEngine.stop();
    const state = readJSON(cronStatePath, {});
    state.engine_status = "stopped";
    writeJSON(cronStatePath, state);
    for (const client of wsClients) {
        client.close();
    }
    wsClients.clear();
    server.close(() => {
        logger.info("Daemon stopped");
        process.exit(0);
    });
    // Force exit after 5s
    setTimeout(() => process.exit(0), 5000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
//# sourceMappingURL=wolf-daemon.js.map