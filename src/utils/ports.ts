/**
 * Project-specific port assignment.
 *
 * Derives deterministic daemon + dashboard ports from a djb2 hash of the
 * absolute project root path.  Same project always gets the same ports;
 * different projects almost always get different ports.
 *
 * Port ranges (200 slots each):
 *   Daemon    : 18700, 18702, 18704 … 19098  (even offsets)
 *   Dashboard : 18701, 18703, 18705 … 19099  (daemon + 1)
 *
 * Collision probability for any 2 projects ≈ 0.5 % — acceptable given that
 * users rarely run more than a handful of simultaneous wolf daemons.
 */

import * as path from "node:path";
import { readJSON, writeJSON } from "./fs-safe.js";

// djb2 variant — returns an unsigned 32-bit integer
function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0;
  }
  return h;
}

/** Return the { daemon, dashboard } port pair for a given project root. */
export function projectPorts(projectRoot: string): { daemon: number; dashboard: number } {
  const slot = djb2(projectRoot) % 200; // 0–199
  const daemon = 18700 + slot * 2;
  return { daemon, dashboard: daemon + 1 };
}

/**
 * Read the project's .wolf/config.json, overwrite the port fields with
 * project-specific values, and write it back.
 *
 * Safe to call on a fresh file or an existing one — all other keys are
 * preserved.
 */
export function assignProjectPorts(wolfDir: string, projectRoot: string): void {
  const configPath = path.join(wolfDir, "config.json");
  const config = readJSON<Record<string, unknown>>(configPath, {});

  const openwolf = (config.openwolf ?? {}) as Record<string, unknown>;
  const daemonSection = (openwolf.daemon ?? {}) as Record<string, unknown>;
  const dashSection = (openwolf.dashboard ?? {}) as Record<string, unknown>;

  const ports = projectPorts(projectRoot);
  daemonSection.port = ports.daemon;
  dashSection.port = ports.dashboard;

  openwolf.daemon = daemonSection;
  openwolf.dashboard = dashSection;
  config.openwolf = openwolf;

  writeJSON(configPath, config);
}
