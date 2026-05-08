import * as fs from "node:fs";
import * as path from "node:path";
import { watch } from "chokidar";
export function startFileWatcher(wolfDir, logger, broadcast) {
    const watcher = watch(wolfDir, {
        ignoreInitial: true,
        ignored: [
            "**/hooks/_session.json",
            "**/*.tmp",
            "**/daemon.log",
        ],
        persistent: true,
        awaitWriteFinish: {
            stabilityThreshold: 500,
            pollInterval: 100,
        },
    });
    watcher.on("change", (filePath) => {
        const relativePath = path.relative(wolfDir, filePath);
        const fileName = path.basename(filePath);
        logger.debug(`File changed: ${relativePath}`);
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            broadcast({
                type: "file_changed",
                file: relativePath,
                content,
                timestamp: new Date().toISOString(),
            });
        }
        catch {
            // File might be in process of being written
        }
        // Hot-reload config
        if (fileName === "config.json") {
            logger.info("Config changed — hot-reload not fully implemented yet");
        }
        // Hot-reload cron manifest
        if (fileName === "cron-manifest.json") {
            logger.info("Cron manifest changed — restart daemon to apply");
        }
    });
    watcher.on("add", (filePath) => {
        const relativePath = path.relative(wolfDir, filePath);
        logger.debug(`File added: ${relativePath}`);
    });
    watcher.on("unlink", (filePath) => {
        const relativePath = path.relative(wolfDir, filePath);
        logger.debug(`File removed: ${relativePath}`);
    });
    logger.info("File watcher started on .wolf/");
}
//# sourceMappingURL=file-watcher.js.map