import * as fs from "node:fs";
import * as path from "node:path";
import cron from "node-cron";
import { readJSON, writeJSON, readText, writeText, appendText } from "../utils/fs-safe.js";
import { scanProject } from "../scanner/anatomy-scanner.js";
import { detectWaste } from "../tracker/waste-detector.js";
import type { Logger } from "../utils/logger.js";

interface CronAction {
  type: string;
  params?: Record<string, unknown>;
}

interface CronTask {
  id: string;
  name: string;
  schedule: string;
  description: string;
  action: CronAction;
  retry: { max_attempts: number; backoff: string; base_delay_seconds: number };
  failsafe: { on_failure: string; dead_letter?: boolean; alert_after_consecutive_failures?: number };
  enabled: boolean;
}

interface CronManifest {
  version: number;
  tasks: CronTask[];
}

interface ExecutionEntry {
  task_id: string;
  status: "success" | "failed";
  timestamp: string;
  duration_ms: number;
  error?: string;
}

interface CronState {
  last_heartbeat: string | null;
  engine_status: string;
  execution_log: ExecutionEntry[];
  dead_letter_queue: Array<{ task_id: string; error: string; timestamp: string; attempts: number }>;
  upcoming: unknown[];
}

export class CronEngine {
  private wolfDir: string;
  private projectRoot: string;
  private logger: Logger;
  private broadcast: (msg: unknown) => void;
  private scheduledTasks: cron.ScheduledTask[] = [];
  private failureCounts = new Map<string, number>();

  constructor(
    wolfDir: string,
    projectRoot: string,
    logger: Logger,
    broadcast: (msg: unknown) => void
  ) {
    this.wolfDir = wolfDir;
    this.projectRoot = projectRoot;
    this.logger = logger;
    this.broadcast = broadcast;
  }

  start(): void {
    const manifest = this.readManifest();
    for (const task of manifest.tasks) {
      if (!task.enabled) continue;
      if (!cron.validate(task.schedule)) {
        this.logger.warn(`Invalid cron schedule for ${task.id}: ${task.schedule}`);
        continue;
      }
      const scheduled = cron.schedule(task.schedule, () => {
        this.executeTask(task).catch((err) => {
          this.logger.error(`Task ${task.id} failed: ${err}`);
        });
      });
      this.scheduledTasks.push(scheduled);
      this.logger.info(`Scheduled task: ${task.name} (${task.schedule})`);
    }
  }

  stop(): void {
    for (const task of this.scheduledTasks) {
      task.stop();
    }
    this.scheduledTasks = [];
  }

  async runTask(taskId: string): Promise<void> {
    const manifest = this.readManifest();
    const task = manifest.tasks.find((t) => t.id === taskId);
    if (!task) {
      this.logger.warn(`Task not found: ${taskId}`);
      return;
    }
    await this.executeTask(task);
  }

  private readManifest(): CronManifest {
    return readJSON<CronManifest>(
      path.join(this.wolfDir, "cron-manifest.json"),
      { version: 1, tasks: [] }
    );
  }

  private readState(): CronState {
    return readJSON<CronState>(
      path.join(this.wolfDir, "cron-state.json"),
      { last_heartbeat: null, engine_status: "running", execution_log: [], dead_letter_queue: [], upcoming: [] }
    );
  }

  private writeState(state: CronState): void {
    writeJSON(path.join(this.wolfDir, "cron-state.json"), state);
  }

  private async executeTask(task: CronTask): Promise<void> {
    const startTime = Date.now();
    this.logger.info(`Executing task: ${task.name}`);

    try {
      await this.runAction(task.action);
      const duration = Date.now() - startTime;

      // Log success
      const state = this.readState();
      state.execution_log.push({
        task_id: task.id,
        status: "success",
        timestamp: new Date().toISOString(),
        duration_ms: duration,
      });
      // Keep last 100 entries
      if (state.execution_log.length > 100) {
        state.execution_log = state.execution_log.slice(-100);
      }
      this.writeState(state);

      this.failureCounts.set(task.id, 0);
      this.broadcast({
        type: "cron_executed",
        task_id: task.id,
        status: "success",
        duration_ms: duration,
      });
      this.logger.info(`Task ${task.name} completed in ${duration}ms`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      const failures = (this.failureCounts.get(task.id) ?? 0) + 1;
      this.failureCounts.set(task.id, failures);

      this.logger.error(`Task ${task.name} failed (attempt ${failures}): ${errorMsg}`);

      if (failures < task.retry.max_attempts) {
        // Retry with backoff
        const delay = this.calculateDelay(task.retry.backoff, task.retry.base_delay_seconds, failures);
        this.logger.info(`Retrying ${task.name} in ${delay}ms`);
        setTimeout(() => {
          this.executeTask(task).catch(() => {});
        }, delay);
      } else {
        // Dead letter or skip
        const state = this.readState();
        state.execution_log.push({
          task_id: task.id,
          status: "failed",
          timestamp: new Date().toISOString(),
          duration_ms: duration,
          error: errorMsg,
        });

        if (task.failsafe.dead_letter) {
          state.dead_letter_queue.push({
            task_id: task.id,
            error: errorMsg,
            timestamp: new Date().toISOString(),
            attempts: failures,
          });
        }

        this.writeState(state);
        this.failureCounts.set(task.id, 0);
      }

      this.broadcast({
        type: "cron_executed",
        task_id: task.id,
        status: "failed",
        duration_ms: duration,
      });
    }
  }

  private calculateDelay(backoff: string, baseSec: number, attempt: number): number {
    const baseMs = baseSec * 1000;
    switch (backoff) {
      case "exponential":
        return baseMs * Math.pow(2, attempt - 1);
      case "linear":
        return baseMs * attempt;
      default:
        return 0;
    }
  }

  private async runAction(action: CronAction): Promise<void> {
    switch (action.type) {
      case "scan_project":
        scanProject(this.wolfDir, this.projectRoot);
        break;

      case "consolidate_memory":
        this.consolidateMemory(action.params?.older_than_days as number ?? 7);
        break;

      case "generate_token_report":
        this.generateTokenReport();
        break;

      case "ai_task":
        await this.runAiTask(action.params as { prompt: string; context_files: string[] });
        break;

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  private consolidateMemory(olderThanDays: number): void {
    const memoryPath = path.join(this.wolfDir, "memory.md");
    const content = readText(memoryPath);
    if (!content) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const lines = content.split("\n");
    const result: string[] = [];
    let inOldSession = false;
    let oldSessionLines: string[] = [];
    let currentSessionDate: Date | null = null;

    for (const line of lines) {
      const sessionMatch = line.match(/^## Session: (\d{4}-\d{2}-\d{2})/);
      if (sessionMatch) {
        // Flush previous old session
        if (inOldSession && oldSessionLines.length > 0) {
          const actionCount = oldSessionLines.filter((l) => l.startsWith("|") && !l.startsWith("|--") && !l.startsWith("| Time")).length;
          result.push(`> Consolidated session (${actionCount} actions)`);
          result.push("");
        }

        currentSessionDate = new Date(sessionMatch[1]);
        if (currentSessionDate < cutoff) {
          inOldSession = true;
          oldSessionLines = [];
          result.push(line); // Keep the header
        } else {
          inOldSession = false;
          result.push(line);
        }
        continue;
      }

      if (inOldSession) {
        oldSessionLines.push(line);
      } else {
        result.push(line);
      }
    }

    // Flush last old session
    if (inOldSession && oldSessionLines.length > 0) {
      const actionCount = oldSessionLines.filter((l) => l.startsWith("|") && !l.startsWith("|--") && !l.startsWith("| Time")).length;
      result.push(`> Consolidated session (${actionCount} actions)`);
      result.push("");
    }

    writeText(memoryPath, result.join("\n"));
  }

  private generateTokenReport(): void {
    const flags = detectWaste(this.wolfDir);
    const ledgerPath = path.join(this.wolfDir, "token-ledger.json");
    const ledger = readJSON<Record<string, unknown>>(ledgerPath, {});
    (ledger as { waste_flags: unknown[] }).waste_flags = flags;
    (ledger as { optimization_report: { last_generated: string; patterns: unknown[] } }).optimization_report = {
      last_generated: new Date().toISOString(),
      patterns: flags.map((f) => f.pattern),
    };
    writeJSON(ledgerPath, ledger);
  }

  private async runAiTask(params: { prompt: string; context_files: string[] }): Promise<void> {
    // Build context — with path traversal protection
    const projectRootResolved = path.resolve(this.projectRoot);
    const contextParts: string[] = [];
    for (const file of params.context_files) {
      const filePath = path.resolve(this.projectRoot, file);
      if (!filePath.startsWith(projectRootResolved + path.sep)) {
        this.logger.warn(`Skipping context file outside project root: ${file}`);
        continue;
      }
      try {
        contextParts.push(`--- ${file} ---\n${fs.readFileSync(filePath, "utf-8")}`);
      } catch {
        contextParts.push(`--- ${file} --- (not found)`);
      }
    }
    const fullPrompt = `${params.prompt}\n\n---\nContext:\n${contextParts.join("\n\n")}`;

    // Read provider config from .wolf/config.json
    const config = readJSON<Record<string, unknown>>(
      path.join(this.wolfDir, "config.json"), {}
    );
    const cronConfig = (config as any)?.openwolf?.cron ?? {};
    const providers: Array<{ type: string; priority: number }> =
      cronConfig.providers ?? [{ type: "openai_api", priority: 1 }];
    const sorted = [...providers].sort((a, b) => a.priority - b.priority);

    let lastError: Error | null = null;
    for (const provider of sorted) {
      try {
        const result = await this.callProvider(provider.type, fullPrompt);
        await this.handleAiResult(result);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(`Provider ${provider.type} failed: ${lastError.message}. Trying next...`);
      }
    }
    throw lastError ?? new Error("All AI providers failed");
  }

  private async callProvider(type: string, prompt: string): Promise<string> {
    switch (type) {
      case "openai_api": {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("OPENAI_API_KEY not set");
        const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          const text = await res.text();
          if (res.status === 429) throw new Error(`rate_limited: ${text}`);
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        const data = (await res.json()) as { choices: [{ message: { content: string } }] };
        return data.choices[0].message.content;
      }
      case "anthropic_api": {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
        const model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-20241022";
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          const text = await res.text();
          if (res.status === 429) throw new Error(`rate_limited: ${text}`);
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        const data = (await res.json()) as { content: [{ text: string }] };
        return data.content[0].text;
      }
      case "openrouter_api": {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
        const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          const text = await res.text();
          if (res.status === 429) throw new Error(`rate_limited: ${text}`);
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        const data = (await res.json()) as { choices: [{ message: { content: string } }] };
        return data.choices[0].message.content;
      }
      default:
        throw new Error(`Unknown provider type: ${type}`);
    }
  }

  private async handleAiResult(result: string): Promise<void> {
    const text = result.replace(/\r\n/g, "\n").trim();
    // Strip markdown fences if present
    const fenceMatch = text.match(/```[\w]*\n([\s\S]*?)\n```/);
    const clean = fenceMatch ? fenceMatch[1].trim() : text;
    try {
      const parsed = JSON.parse(clean);
      writeJSON(path.join(this.wolfDir, "suggestions.json"), {
        generated_at: new Date().toISOString(),
        ...parsed,
      });
    } catch {
      if (clean.includes("## User Preferences") || clean.includes("## Key Learnings") || clean.includes("# Cerebrum")) {
        writeText(path.join(this.wolfDir, "cerebrum.md"), clean);
      }
    }
  }
}
