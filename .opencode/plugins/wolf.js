// OpenWolf OpenCode plugin
// Placed here by: wolf init
// Do not hand-edit — re-run wolf init to update.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

function findWolfDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, '.wolf', 'config.json');
    if (existsSync(candidate)) return join(dir, '.wolf');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function safeRead(filePath, maxLines = 0) {
  try {
    const text = readFileSync(filePath, 'utf-8');
    if (maxLines > 0) return text.split('\n').slice(-maxLines).join('\n');
    return text;
  } catch { return null; }
}

export const WolfPlugin = async (ctx) => {
  const wolfDir = findWolfDir(ctx?.directory ?? process.cwd());
  if (!wolfDir) return {};

  return {
    // Log session start to .wolf/memory.md
    'session.created': async (_input, _output) => {
      const today = new Date().toISOString().slice(0, 10);
      try {
        appendFileSync(join(wolfDir, 'memory.md'), `\n## Session: ${today} (OpenCode)\n`);
      } catch { /* non-fatal */ }
    },

    // Preserve wolf context across session compaction (context window splits)
    'experimental.session.compacting': async (_input, output) => {
      const cerebrum = safeRead(join(wolfDir, 'cerebrum.md'));
      const recentMemory = safeRead(join(wolfDir, 'memory.md'), 40);
      if (cerebrum) output.context.push(`## Wolf Cerebrum (architectural decisions)\n${cerebrum}`);
      if (recentMemory) output.context.push(`## Wolf Memory (recent sessions)\n${recentMemory}`);
    },
  };
};
