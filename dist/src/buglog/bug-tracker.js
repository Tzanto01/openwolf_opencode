import * as path from "node:path";
import { readJSON, writeJSON } from "../utils/fs-safe.js";
export function getBugLogPath(wolfDir) {
    return path.join(wolfDir, "buglog.json");
}
export function readBugLog(wolfDir) {
    const bugLog = readJSON(getBugLogPath(wolfDir), { version: 1, bugs: [] });
    return {
        ...bugLog,
        bugs: (bugLog.bugs || []).map(normalizeBugEntry),
    };
}
export function logBug(wolfDir, bug) {
    const bugLog = readBugLog(wolfDir);
    const now = new Date().toISOString();
    // Check for near-duplicate (score > 0.8)
    const similar = findSimilarBugs(wolfDir, bug.error_message);
    if (similar.length > 0 && similar[0].score > 0.8) {
        const existing = bugLog.bugs.find((b) => b.id === similar[0].bug.id);
        if (existing) {
            existing.occurrences++;
            existing.last_seen = now;
            existing.status = existing.status ?? "open";
            existing.resolved_at = existing.status === "resolved" ? existing.resolved_at ?? now : null;
            writeJSON(getBugLogPath(wolfDir), bugLog);
            return;
        }
    }
    const id = `bug-${String(bugLog.bugs.length + 1).padStart(3, "0")}`;
    bugLog.bugs.push({
        id,
        timestamp: now,
        error_message: bug.error_message,
        file: bug.file,
        line: bug.line,
        root_cause: bug.root_cause,
        fix: bug.fix,
        tags: bug.tags,
        related_bugs: [],
        occurrences: 1,
        last_seen: now,
        status: "open",
        resolved_at: null,
    });
    writeJSON(getBugLogPath(wolfDir), bugLog);
}
export function resolveBug(wolfDir, bugId, resolvedAt = new Date().toISOString()) {
    const bugLog = readBugLog(wolfDir);
    const bug = bugLog.bugs.find((entry) => entry.id === bugId);
    if (!bug)
        return false;
    bug.status = "resolved";
    bug.resolved_at = resolvedAt;
    bug.last_seen = resolvedAt;
    writeJSON(getBugLogPath(wolfDir), bugLog);
    return true;
}
function normalize(text) {
    return text.toLowerCase().replace(/\d+/g, "N").replace(/[^\w\s]/g, " ").trim();
}
function tokenize(text) {
    return new Set(normalize(text).split(/\s+/).filter((w) => w.length > 2));
}
function jaccardSimilarity(a, b) {
    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    return union.size === 0 ? 0 : intersection.size / union.size;
}
export function findSimilarBugs(wolfDir, errorMessage) {
    const bugLog = readBugLog(wolfDir);
    const normalizedInput = normalize(errorMessage);
    const inputTokens = tokenize(errorMessage);
    const results = [];
    for (const bug of bugLog.bugs) {
        let score = 0;
        // Exact substring match
        if (normalize(bug.error_message).includes(normalizedInput) ||
            normalizedInput.includes(normalize(bug.error_message))) {
            score += 1.0;
        }
        // Word overlap (jaccard)
        const bugTokens = tokenize(bug.error_message);
        score += jaccardSimilarity(inputTokens, bugTokens) * 0.5;
        if (score > 0.3) {
            results.push({ bug, score });
        }
    }
    results.sort((a, b) => b.score - a.score);
    return results;
}
export function searchBugs(wolfDir, term) {
    const bugLog = readBugLog(wolfDir);
    const lower = term.toLowerCase();
    return bugLog.bugs.filter((b) => b.error_message.toLowerCase().includes(lower) ||
        b.root_cause.toLowerCase().includes(lower) ||
        b.fix.toLowerCase().includes(lower) ||
        b.tags.some((t) => t.toLowerCase().includes(lower)) ||
        b.file.toLowerCase().includes(lower));
}
function normalizeBugEntry(bug) {
    const status = bug.status === "resolved" ? "resolved" : "open";
    return {
        ...bug,
        status,
        resolved_at: status === "resolved" ? bug.resolved_at ?? bug.last_seen : null,
    };
}
//# sourceMappingURL=bug-tracker.js.map