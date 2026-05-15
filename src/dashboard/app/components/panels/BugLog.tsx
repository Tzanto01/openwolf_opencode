import React, { useState } from "react";
import type { WolfData } from "../../hooks/useWolfData.js";
import { StatusBadge } from "../shared/StatusBadge.js";

type BugStatusFilter = "all" | "open" | "resolved";

function getBugStatus(bug: any): "open" | "resolved" {
  return bug.status === "resolved" ? "resolved" : "open";
}

export function BugLog({ data }: { data: WolfData }) {
  const { buglog } = data;
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<BugStatusFilter>("all");

  const normalizedBugs = [...buglog.bugs].map((bug: any) => ({
    ...bug,
    status: getBugStatus(bug),
    resolved_at: bug.status === "resolved" ? bug.resolved_at ?? bug.last_seen ?? bug.timestamp ?? null : null,
  })).sort((a: any, b: any) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return String(b.last_seen || b.timestamp || "").localeCompare(String(a.last_seen || a.timestamp || ""));
  });

  const filtered = normalizedBugs.filter((b: any) => {
    const matchesStatus = statusFilter === "all" || b.status === statusFilter;
    const matchesSearch = !search ||
      b.error_message.toLowerCase().includes(search.toLowerCase()) ||
      b.root_cause.toLowerCase().includes(search.toLowerCase()) ||
      b.fix.toLowerCase().includes(search.toLowerCase()) ||
      b.tags.some((t: string) => t.toLowerCase().includes(search.toLowerCase()));
    return matchesStatus && matchesSearch;
  });

  const openCount = normalizedBugs.filter((bug: any) => bug.status === "open").length;
  const resolvedCount = normalizedBugs.length - openCount;

  if (buglog.bugs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="text-4xl mb-3">🐛</div>
        <h3 className="font-medium mb-1" style={{ color: "var(--text-secondary)" }}>No bugs logged yet</h3>
        <p className="text-sm max-w-sm" style={{ color: "var(--text-muted)" }}>
          When you encounter and fix bugs, they'll appear here for future reference.
        </p>
      </div>
    );
  }

  const allTags = normalizedBugs.flatMap((b: any) => b.tags);
  const tagCounts = new Map<string, number>();
  for (const tag of allTags) {
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <input type="text" placeholder="Search bugs..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] rounded-lg px-3 py-2 text-sm focus:outline-none"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
        />
        <span className="text-sm" style={{ color: "var(--text-faint)" }}>{normalizedBugs.length} bugs logged</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {([
          ["all", `All (${normalizedBugs.length})`],
          ["open", `Open (${openCount})`],
          ["resolved", `Resolved (${resolvedCount})`],
        ] as const).map(([value, label]) => {
          const isActive = statusFilter === value;
          return (
            <button key={value} onClick={() => setStatusFilter(value)}
              className="px-3 py-1.5 text-xs rounded-full"
              style={{
                background: isActive ? "var(--bg-surface-hover)" : "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                color: isActive ? "var(--text-primary)" : "var(--text-muted)",
              }}
            >{label}</button>
          );
        })}
      </div>

      {topTags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {topTags.map(([tag, count]) => (
            <button key={tag} onClick={() => setSearch(tag)}
              className="px-2 py-1 text-xs rounded-full"
              style={{ background: "var(--bg-surface-hover)", border: "1px solid var(--border-subtle)", color: "var(--text-muted)" }}
            >{tag} ({count})</button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((bug: any) => {
          const isExpanded = expandedId === bug.id;
          return (
            <div key={bug.id} className="rounded-xl overflow-hidden" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", opacity: bug.status === "resolved" ? 0.82 : 1 }}>
              <button onClick={() => setExpandedId(isExpanded ? null : bug.id)}
                className="w-full flex items-start gap-3 px-5 py-3 transition-colors text-left"
                onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-surface-hover)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <span className="text-sm mt-0.5" style={{ color: "var(--text-faint)" }}>{isExpanded ? "▼" : "▶"}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate" style={{ color: "var(--text-primary)" }}>{bug.error_message}</p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs" style={{ color: "var(--text-faint)" }}>{bug.file}</span>
                    <span className="text-xs" style={{ color: "var(--text-faint)" }}>{bug.timestamp?.slice(0, 10)}</span>
                    <StatusBadge status={bug.status} />
                  </div>
                </div>
                {bug.occurrences > 1 && (
                  <span className="shrink-0 px-2 py-0.5 rounded-full text-xs" style={{ background: "var(--warning-subtle)", color: "var(--warning)" }}>
                    Seen {bug.occurrences}x
                  </span>
                )}
              </button>
              {isExpanded && (
                <div className="px-5 py-4 space-y-3" style={{ borderTop: "1px solid var(--border)" }}>
                  <div>
                    <p className="text-xs uppercase mb-1" style={{ color: "var(--text-faint)" }}>Error Message</p>
                    <pre className="text-sm rounded-lg p-3 overflow-x-auto font-mono" style={{ color: "var(--danger)", background: "var(--danger-subtle)" }}>{bug.error_message}</pre>
                  </div>
                  <div>
                    <p className="text-xs uppercase mb-1" style={{ color: "var(--text-faint)" }}>Root Cause</p>
                    <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{bug.root_cause}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase mb-1" style={{ color: "var(--text-faint)" }}>Fix</p>
                    <pre className="text-sm rounded-lg p-3 overflow-x-auto font-mono" style={{ color: "var(--accent)", background: "var(--accent-subtle)" }}>{bug.fix}</pre>
                  </div>
                  {bug.status === "resolved" && bug.resolved_at && (
                    <div>
                      <p className="text-xs uppercase mb-1" style={{ color: "var(--text-faint)" }}>Resolved</p>
                      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{String(bug.resolved_at).slice(0, 10)}</p>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {bug.tags.map((tag: string) => (
                      <span key={tag} className="px-2 py-0.5 text-xs rounded-full" style={{ background: "var(--bg-surface-hover)", border: "1px solid var(--border-subtle)", color: "var(--text-muted)" }}>{tag}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
