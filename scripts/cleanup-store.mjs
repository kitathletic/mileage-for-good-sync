#!/usr/bin/env node
/**
 * cleanup-store.mjs — one-shot fix for the patch-transition contamination.
 *
 * Strava's club activities endpoint returns no dates. When sync-leaderboard.mjs
 * first runs against an empty store, it tags every activity Strava returns
 * (the rolling last ~200) with first_seen_at = NOW. That's a problem at cycle
 * launch because Strava's rolling feed still contains last week's activities,
 * which get incorrectly counted into the new cycle.
 *
 * This script rewrites every existing entry's first_seen_at and week_key
 * to dummy past values so the cycle / this-week / last-week filters exclude
 * them. The activities themselves stay in the store, so all-time totals
 * remain accurate (the all-time view doesn't filter by date).
 *
 * Run this ONCE after the initial sync. Going forward, only newly-discovered
 * activities get a current first_seen_at, and they'll correctly populate
 * cycle / this-week / last-week views.
 */
 
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
 
const PATH = "data/activities.json";
const PRE_CYCLE_DATE = "2024-01-01T00:00:00.000Z";
const PRE_CYCLE_WEEK = "2024-W01";
 
const raw = await readFile(PATH, "utf8");
const store = JSON.parse(raw);
if (!store.activities) {
  console.error("[cleanup] store has no activities object — nothing to do");
  process.exit(0);
}
 
let count = 0;
for (const a of Object.values(store.activities)) {
  a.first_seen_at = PRE_CYCLE_DATE;
  a.week_key = PRE_CYCLE_WEEK;
  count++;
}
 
store.cleanup_applied_at = new Date().toISOString();
 
await mkdir(dirname(PATH) || ".", { recursive: true });
const tmp = `${PATH}.tmp`;
await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
await rename(tmp, PATH);
 
console.log(`[cleanup] reset first_seen_at + week_key on ${count} entries`);
console.log(`[cleanup] store written to ${PATH}`);
