import { WOLF_AGENTS_SENTINEL, WOLF_AGENTS_SKIP_MARKER } from "./detect.js";
const OPENWOLF_POINTER = ".wolf/OPENWOLF.md";
const OPENWOLF_INCLUDE = "@.wolf/OPENWOLF.md";
const POINTER_SCAN_LINES = 40;
export function reconcileAgentsContent(existing, agentsSection) {
    if (existing.includes(WOLF_AGENTS_SENTINEL)) {
        return { action: "skip-existing", content: existing };
    }
    if (existing.includes(WOLF_AGENTS_SKIP_MARKER)) {
        return { action: "skip-opt-out", content: existing };
    }
    if (hasOpenWolfPointer(existing)) {
        return { action: "skip-openwolf-pointer", content: existing };
    }
    return {
        action: "append",
        content: appendAgentsSection(existing, agentsSection),
    };
}
function appendAgentsSection(existing, agentsSection) {
    if (!existing.trim()) {
        return `${agentsSection}\n`;
    }
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${agentsSection}\n`;
}
function hasOpenWolfPointer(content) {
    const lines = content.split("\n").slice(0, POINTER_SCAN_LINES).map((line) => line.replace(/\r$/, ""));
    let inFence = false;
    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence)
            continue;
        const trimmed = line.trim();
        if (trimmed === OPENWOLF_INCLUDE) {
            return true;
        }
        if (line.includes(OPENWOLF_POINTER)) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=agents-injector.js.map