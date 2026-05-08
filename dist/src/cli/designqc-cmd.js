import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import { readJSON } from "../utils/fs-safe.js";
import { DesignQCEngine } from "../designqc/designqc-engine.js";
import { DEFAULT_VIEWPORTS } from "../designqc/designqc-types.js";
export async function designqcCommand(target, opts) {
    const projectRoot = findProjectRoot();
    const wolfDir = path.join(projectRoot, ".wolf");
    const config = readJSON(path.join(wolfDir, "config.json"), {});
    const dc = config.openwolf?.designqc ?? {};
    let viewports = dc.viewports || DEFAULT_VIEWPORTS;
    if (opts?.desktopOnly) {
        viewports = viewports.filter((v) => v.name === "desktop");
        if (viewports.length === 0)
            viewports = [DEFAULT_VIEWPORTS[0]];
    }
    const options = {
        targetFile: target,
        devServerUrl: opts?.url,
        routes: opts?.routes,
        viewports,
        maxScreenshots: dc.max_screenshots || 16,
        chromePath: dc.chrome_path ?? undefined,
        quality: Number(opts?.quality) || 70,
        maxWidth: Number(opts?.maxWidth) || 1200,
    };
    console.log("\n  OpenWolf Design QC — Screenshot Capture\n");
    const engine = new DesignQCEngine(wolfDir, projectRoot, options);
    await engine.capture();
}
//# sourceMappingURL=designqc-cmd.js.map