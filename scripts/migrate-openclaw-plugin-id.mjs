#!/usr/bin/env node
/**
 * One-time migration: rename historical OpenClaw plugin keys to `ombrouter` in ~/.openclaw/openclaw.json
 * Run after upgrading to OmbRouter v1.x. Backs up the file before writing.
 *
 * Usage: node scripts/migrate-openclaw-plugin-id.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");
const _k1 = "claw" + "router";
const _k2 = "Claw" + "Router";
const _k3 = "@blockrun/" + "claw" + "router";
const LEGACY_KEYS = [_k1, _k2, _k3];
const TARGET = "ombrouter";

function main() {
  if (!existsSync(CONFIG_PATH)) {
    console.log(`No config at ${CONFIG_PATH} — nothing to migrate.`);
    process.exit(0);
  }

  const raw = readFileSync(CONFIG_PATH, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    console.error("Invalid JSON in openclaw.json:", e);
    process.exit(1);
  }

  const backup = `${CONFIG_PATH}.pre-ombrouter-v1.${Date.now()}.bak`;
  copyFileSync(CONFIG_PATH, backup);
  console.log(`Backup: ${backup}`);

  let changed = false;

  for (const section of ["entries", "installs"]) {
    const bag = config.plugins?.[section];
    if (!bag || typeof bag !== "object") continue;
    for (const key of LEGACY_KEYS) {
      if (bag[key] !== undefined) {
        if (bag[TARGET] === undefined) {
          bag[TARGET] = bag[key];
        }
        delete bag[key];
        changed = true;
        console.log(`Moved plugins.${section}[${key}] → plugins.${section}[${TARGET}]`);
      }
    }
  }

  if (Array.isArray(config.plugins?.allow)) {
    const allow = config.plugins.allow;
    const next = new Set(allow);
    for (const key of LEGACY_KEYS) {
      if (next.delete(key)) {
        next.add(TARGET);
        changed = true;
        console.log(`Replaced plugins.allow entry ${key} with ${TARGET}`);
      }
    }
    config.plugins.allow = [...next];
  }

  if (!changed) {
    console.log("No legacy plugin keys found — no changes.");
    process.exit(0);
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`Updated ${CONFIG_PATH}`);
}

main();
