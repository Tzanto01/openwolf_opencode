export interface AnatomyEntry {
  file: string;
  description: string;
  tokens: number;
  section: string;
}

export interface MemorySession {
  date: string;
  time: string;
  entries: Array<{ time: string; action: string; files: string; outcome: string; tokens: string }>;
}

export interface CerebrumData {
  preferences: string[];
  learnings: string[];
  doNotRepeat: Array<{ date: string; text: string }>;
  decisions: string[];
  lastUpdated: string;
}

export function parseAnatomy(content: string): { entries: AnatomyEntry[]; metadata: { files: number; hits: number; misses: number } } {
  const entries: AnatomyEntry[] = [];
  let currentSection = "";
  let files = 0, hits = 0, misses = 0;

  for (const line of content.split("\n")) {
    const metaMatch = line.match(/Files:\s*(\d+).*hits:\s*(\d+).*Misses:\s*(\d+)/i);
    if (metaMatch) {
      files = parseInt(metaMatch[1]);
      hits = parseInt(metaMatch[2]);
      misses = parseInt(metaMatch[3]);
    }

    const sectionMatch = line.match(/^## (.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    const entryMatch = line.match(/^- `([^`]+)`(?:\s+—\s+(.+?))?\s*\(~(\d+)\s+tok\)$/);
    if (entryMatch && currentSection) {
      entries.push({
        file: entryMatch[1],
        description: entryMatch[2] || "",
        tokens: parseInt(entryMatch[3]),
        section: currentSection,
      });
    }
  }

  return { entries, metadata: { files, hits, misses } };
}

export function parseMemory(content: string): MemorySession[] {
  const sessions: MemorySession[] = [];
  let current: MemorySession | null = null;
  const dateCellPattern = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?$/;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const sessionMatch = line.match(/^## Session: (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
    if (sessionMatch) {
      if (current) sessions.push(current);
      current = { date: sessionMatch[1], time: sessionMatch[2], entries: [] };
      continue;
    }

    // Current OpenWolf memory format:
    // ## YYYY-MM-DD
    // - free-form entry text
    const dateHeaderMatch = line.match(/^## (\d{4}-\d{2}-\d{2})\s*$/);
    if (dateHeaderMatch) {
      if (current) sessions.push(current);
      current = { date: dateHeaderMatch[1], time: "", entries: [] };
      continue;
    }

    const isSeparator = /^\|\s*:?-{3,}/.test(line);
    const isHeaderRow = /^\|\s*(date|time)\b/i.test(line);
    if (line.startsWith("|") && !isSeparator && !isHeaderRow) {
      const inner = line.replace(/^\|/, "").replace(/\|\s*$/, "");
      const parts = inner.split("|").map(s => s.trim());
      const dateCellMatch = parts[0]?.match(dateCellPattern);

      // Compressed milestone format:
      // | 2026-05-11 [HH:MM] | Action | Files | Result | Tokens |
      if (dateCellMatch && parts.length >= 4) {
        const nextDate = dateCellMatch[1];
        const nextTime = dateCellMatch[2] || "";

        if (!current || current.date !== nextDate || current.time !== nextTime) {
          if (current) sessions.push(current);
          current = { date: nextDate, time: nextTime, entries: [] };
        }

        current.entries.push({
          time: nextTime,
          action: parts[1],
          files: parts[2],
          outcome: parts[3],
          tokens: parts[4] || "",
        });
        continue;
      }

      if (current && parts.length >= 4) {
        current.entries.push({
          time: parts[0],
          action: parts[1],
          files: parts[2],
          outcome: parts[3],
          tokens: parts[4] || "",
        });
      }
      continue;
    }

    if (current) {
      const bulletMatch = line.match(/^[-*]\s+(.+)/);
      if (bulletMatch) {
        current.entries.push({
          time: "",
          action: bulletMatch[1].trim(),
          files: "",
          outcome: "",
          tokens: "",
        });
      }
    }
  }

  if (current) sessions.push(current);
  return sessions.reverse(); // newest first
}

export function parseCerebrum(content: string): CerebrumData {
  const data: CerebrumData = { preferences: [], learnings: [], doNotRepeat: [], decisions: [], lastUpdated: "" };

  const lastUpdatedMatch = content.match(/Last updated:\s*(.+)/);
  if (lastUpdatedMatch) data.lastUpdated = lastUpdatedMatch[1].trim();

  const sections = content.split(/^## /m).slice(1);
  for (const section of sections) {
    const [title, ...rest] = section.split("\n");
    const items = rest
      .filter(l => l.trim().startsWith("-") || l.trim().startsWith("["))
      .map(l => l.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean)
      .filter(l => !l.startsWith("<!--"));

    if (title.includes("User Preferences")) {
      data.preferences = items;
    } else if (title.includes("Key Learnings")) {
      data.learnings = items;
    } else if (title.includes("Do-Not-Repeat")) {
      data.doNotRepeat = items.map(item => {
        const dateMatch = item.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)/);
        return dateMatch
          ? { date: dateMatch[1], text: dateMatch[2] }
          : { date: "", text: item };
      });
    } else if (title.includes("Decision Log")) {
      data.decisions = items;
    }
  }

  return data;
}
