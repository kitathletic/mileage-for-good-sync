#!/usr/bin/env node
/**
 * sync-leaderboard.mjs  (v2 — multi-output, cycle-aware, weekly snapshots)
 *
 * Polls Strava's /clubs/{id}/activities endpoint, deduplicates against a
 * persistent store, and writes multiple JSON files for the page to read:
 *
 *   leaderboard.json     ← cumulative within current cycle (drives donation)
 *   all-time.json        ← cumulative across all cycles since pipeline launch
 *   this-week.json       ← current ISO week (Monday–Sunday, GMT+7)
 *   last-week.json       ← previous ISO week (frozen)
 *   weeks/YYYY-Www.json  ← per-week snapshots (immutable once a week ends)
 *
 * All files share the same shape so the front-end can use one renderer.
 *
 * Why the dedupe dance?
 *   The /clubs/{id}/activities endpoint returns only the ~200 most recent
 *   club activities, with NO dates and NO activity IDs, and only first
 *   name + last initial. To aggregate over a multi-week cycle we have to
 *   poll frequently and accumulate. We bucket each newly-seen activity to
 *   the ISO week of when WE first saw it (in GMT+7), not when it was run.
 *   If the cron is healthy that gap is small enough to be acceptable.
 *
 * Env vars (REQUIRED unless noted):
 *   STRAVA_CLIENT_ID          Strava API app Client ID
 *   STRAVA_CLIENT_SECRET      Strava API app Client Secret
 *   STRAVA_REFRESH_TOKEN      Long-lived refresh token
 *   STRAVA_CLUB_ID            Numeric club ID
 *
 * Env vars (OPTIONAL):
 *   CYCLE_START               YYYY-MM-DD, treated as 00:00 GMT+7. Activities
 *                             first seen before this go into all-time but
 *                             NOT into leaderboard.json (cycle view).
 *                             Default: "2026-04-27"
 *   CYCLE_DAYS                Cycle length in days. Default: 90
 *   ACTIVITY_TYPES            Comma-separated allowlist. Default:
 *                             "Run,TrailRun,VirtualRun,Workout,Walk"
 *   UNITS                     "km" (default) or "mi"
 *   DATA_DIR                  Where to read/write state. Default: "data"
 *   OUTPUT_DIR                Where to write public files. Default: "."
 */
 
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
 
// ---------- config ----------
const {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  STRAVA_REFRESH_TOKEN,
  STRAVA_CLUB_ID,
  CYCLE_START = "2026-04-27",
  CYCLE_DAYS = "90",
  ACTIVITY_TYPES = "Run,TrailRun,VirtualRun,Workout,Walk",
  UNITS = "km",
  DATA_DIR = "data",
  OUTPUT_DIR = ".",
} = process.env;
 
const REQUIRED = {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  STRAVA_REFRESH_TOKEN,
  STRAVA_CLUB_ID,
};
for (const [k, v] of Object.entries(REQUIRED)) {
  if (!v) {
    console.error(`[sync] Missing required env var: ${k}`);
    process.exit(1);
  }
}
 
const UNIT_FACTOR = UNITS === "mi" ? 1 / 1609.344 : 1 / 1000;
const UNIT_LABEL = UNITS === "mi" ? "mi" : "km";
const TYPE_ALLOWLIST = new Set(
  ACTIVITY_TYPES.split(",").map((s) => s.trim()).filter(Boolean),
);
 
const ACTIVITIES_FILE = join(DATA_DIR, "activities.json");
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
 
// Cycle window in UTC (CYCLE_START is 00:00 GMT+7 → subtract 7h to UTC)
const CYCLE_START_MS = Date.parse(`${CYCLE_START}T00:00:00+07:00`);
const CYCLE_END_MS = CYCLE_START_MS + Number(CYCLE_DAYS) * 24 * 60 * 60 * 1000;
 
// ---------- helpers ----------
const log = (...args) => console.log("[sync]", ...args);
 
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}
 
async function writeJsonAtomic(path, data) {
  await mkdir(dirname(path) || ".", { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}
 
/**
 * ISO week of a Date, computed in GMT+7 (Asia/Jakarta).
 * Returns { year, week, key } where key looks like "2026-W18".
 * Standard ISO 8601: weeks start Monday, week containing first Thursday
 * of the year is week 1.
 */
function isoWeekJakarta(dateLike) {
  const ms = (dateLike instanceof Date ? dateLike.getTime() : Date.parse(dateLike))
    + JAKARTA_OFFSET_MS;
  const d = new Date(ms);
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to nearest Thursday
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year, week, key: `${year}-W${String(week).padStart(2, "0")}` };
}
 
function previousWeekKey(weekKey) {
  const [y, w] = weekKey.split("-W").map(Number);
  // Construct any date inside that ISO week, subtract 7 days, recompute.
  // ISO week 1 contains Jan 4 → derive Monday of weekKey.
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const targetMon = new Date(week1Mon);
  targetMon.setUTCDate(week1Mon.getUTCDate() + (w - 1) * 7);
  const prev = new Date(targetMon);
  prev.setUTCDate(targetMon.getUTCDate() - 7);
  return isoWeekJakarta(prev).key;
}
 
function hashActivity(a) {
  // Strava club activities lack id/date, so we hash on stable fields.
  const athlete = `${(a.athlete?.firstname || "").trim()}|${(a.athlete?.lastname || "").trim()}`;
  const payload = [
    athlete.toLowerCase(),
    a.type || "",
    a.sport_type || "",
    Math.round((a.distance || 0) * 10) / 10,
    a.moving_time || 0,
    a.elapsed_time || 0,
    Math.round(a.total_elevation_gain || 0),
    (a.name || "").trim().toLowerCase(),
  ].join("::");
  return createHash("sha256").update(payload).digest("hex").slice(0, 20);
}
 
// ---------- Strava API ----------
async function refreshAccessToken() {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: STRAVA_REFRESH_TOKEN,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).access_token;
}
 
async function fetchClubMeta(accessToken) {
  const res = await fetch(`https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    log(`Club meta fetch failed: ${res.status} (non-fatal, continuing)`);
    return null;
  }
  return res.json();
}
 
async function fetchClubActivities(accessToken) {
  const all = [];
  const seen = new Set();
  const maxPages = 5;
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://www.strava.com/api/v3/clubs/${STRAVA_CLUB_ID}/activities?per_page=200&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(
        `Activities fetch failed (page ${page}): ${res.status} ${await res.text()}`,
      );
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    let newThisPage = 0;
    for (const a of batch) {
      const h = hashActivity(a);
      if (!seen.has(h)) {
        seen.add(h);
        all.push(a);
        newThisPage++;
      }
    }
    if (newThisPage === 0) break;
    if (batch.length < 200) break;
  }
  return all;
}
 
// ---------- aggregation ----------
function aggregate(activities) {
  const byAthlete = new Map();
  for (const a of activities) {
    if (!TYPE_ALLOWLIST.has(a.type) && !TYPE_ALLOWLIST.has(a.sport_type)) continue;
    const key = `${a.athlete_first}|${a.athlete_last}`.toLowerCase();
    let row = byAthlete.get(key);
    if (!row) {
      row = {
        name: [a.athlete_first, a.athlete_last].filter(Boolean).join(" ") || "Anonymous",
        activities: 0,
        distance_m: 0,
        moving_time_s: 0,
        elevation_m: 0,
      };
      byAthlete.set(key, row);
    }
    row.activities += 1;
    row.distance_m += a.distance_m;
    row.moving_time_s += a.moving_time_s;
    row.elevation_m += a.elevation_m;
  }
 
  const rows = [...byAthlete.values()]
    .map((r) => ({
      name: r.name,
      activities: r.activities,
      distance: +(r.distance_m * UNIT_FACTOR).toFixed(2),
      moving_time_s: r.moving_time_s,
      elevation_m: Math.round(r.elevation_m),
    }))
    .sort((a, b) => b.distance - a.distance);
 
  rows.forEach((r, i) => { r.rank = i + 1; });
 
  const totals = rows.reduce(
    (acc, r) => {
      acc.distance += r.distance;
      acc.activities += r.activities;
      acc.moving_time_s += r.moving_time_s;
      acc.elevation_m += r.elevation_m;
      return acc;
    },
    { distance: 0, activities: 0, moving_time_s: 0, elevation_m: 0 },
  );
  totals.distance = +totals.distance.toFixed(2);
 
  return { rows, totals };
}
 
function buildPayload({ generated_at, club, view, range, rows, totals }) {
  return {
    generated_at,
    club: club
      ? { id: club.id, name: club.name, member_count: club.member_count, url: club.url }
      : { id: Number(STRAVA_CLUB_ID) },
    units: UNIT_LABEL,
    view,                  // "cycle" | "all-time" | "this-week" | "last-week" | "week"
    range,                 // { start, end } ISO timestamps for the bucket
    activity_types: [...TYPE_ALLOWLIST],
    totals,
    rows,
  };
}
 
// ---------- main ----------
export async function main() {
  const now = new Date();
  const nowIso = now.toISOString();
  log(`run started at ${nowIso}`);
  log(`cycle: ${CYCLE_START} → +${CYCLE_DAYS}d (window ${new Date(CYCLE_START_MS).toISOString()} to ${new Date(CYCLE_END_MS).toISOString()})`);
  log(`activity types: ${[...TYPE_ALLOWLIST].join(", ")}`);
 
  const accessToken = await refreshAccessToken();
  log("access token refreshed");
 
  const [club, activities] = await Promise.all([
    fetchClubMeta(accessToken),
    fetchClubActivities(accessToken),
  ]);
  log(`fetched ${activities.length} recent club activities from Strava`);
 
  await mkdir(DATA_DIR, { recursive: true });
  const store = await readJson(ACTIVITIES_FILE, { activities: {} });
  if (!store.activities) store.activities = {};
 
  // Backfill week_key on legacy entries that pre-date this script version.
  for (const a of Object.values(store.activities)) {
    if (!a.week_key && a.first_seen_at) {
      a.week_key = isoWeekJakarta(a.first_seen_at).key;
    }
  }
 
  let newCount = 0;
  const currentWeekKey = isoWeekJakarta(now).key;
  for (const a of activities) {
    const h = hashActivity(a);
    if (!store.activities[h]) {
      store.activities[h] = {
        h,
        first_seen_at: nowIso,
        week_key: currentWeekKey,
        athlete_first: (a.athlete?.firstname || "").trim(),
        athlete_last: (a.athlete?.lastname || "").trim(),
        name: a.name || "",
        type: a.type || "",
        sport_type: a.sport_type || a.type || "",
        distance_m: a.distance || 0,
        moving_time_s: a.moving_time || 0,
        elapsed_time_s: a.elapsed_time || 0,
        elevation_m: a.total_elevation_gain || 0,
      };
      newCount++;
    }
  }
  log(`${newCount} new activities added (store now: ${Object.keys(store.activities).length})`);
 
  store.last_synced_at = nowIso;
  store.cycle = { start: CYCLE_START, days: Number(CYCLE_DAYS) };
  await writeJsonAtomic(ACTIVITIES_FILE, store);
 
  // ---------- build the views ----------
  const allActivities = Object.values(store.activities);
  const lastWeekKey = previousWeekKey(currentWeekKey);
 
  const inCycle = allActivities.filter((a) => {
    const t = Date.parse(a.first_seen_at);
    return t >= CYCLE_START_MS && t < CYCLE_END_MS;
  });
  const inThisWeek = allActivities.filter((a) => a.week_key === currentWeekKey);
  const inLastWeek = allActivities.filter((a) => a.week_key === lastWeekKey);
 
  const cycleAgg = aggregate(inCycle);
  const allTimeAgg = aggregate(allActivities);
  const thisWeekAgg = aggregate(inThisWeek);
  const lastWeekAgg = aggregate(inLastWeek);
 
  // leaderboard.json — cycle view (drives the IDR counter on the page)
  await writeJsonAtomic(
    join(OUTPUT_DIR, "leaderboard.json"),
    buildPayload({
      generated_at: nowIso,
      club,
      view: "cycle",
      range: {
        start: new Date(CYCLE_START_MS).toISOString(),
        end: new Date(CYCLE_END_MS).toISOString(),
        cycle_label: `Cycle since ${CYCLE_START}`,
      },
      rows: cycleAgg.rows,
      totals: cycleAgg.totals,
    }),
  );
 
  // all-time.json — never resets
  await writeJsonAtomic(
    join(OUTPUT_DIR, "all-time.json"),
    buildPayload({
      generated_at: nowIso,
      club,
      view: "all-time",
      range: { start: null, end: null, cycle_label: "All-time (since pipeline launch)" },
      rows: allTimeAgg.rows,
      totals: allTimeAgg.totals,
    }),
  );
 
  // this-week.json — current ISO week
  await writeJsonAtomic(
    join(OUTPUT_DIR, "this-week.json"),
    buildPayload({
      generated_at: nowIso,
      club,
      view: "this-week",
      range: { week_key: currentWeekKey },
      rows: thisWeekAgg.rows,
      totals: thisWeekAgg.totals,
    }),
  );
 
  // last-week.json — frozen
  await writeJsonAtomic(
    join(OUTPUT_DIR, "last-week.json"),
    buildPayload({
      generated_at: nowIso,
      club,
      view: "last-week",
      range: { week_key: lastWeekKey },
      rows: lastWeekAgg.rows,
      totals: lastWeekAgg.totals,
    }),
  );
 
  // weeks/{currentWeekKey}.json — snapshot of the current week, kept for history
  await writeJsonAtomic(
    join(OUTPUT_DIR, "weeks", `${currentWeekKey}.json`),
    buildPayload({
      generated_at: nowIso,
      club,
      view: "week",
      range: { week_key: currentWeekKey },
      rows: thisWeekAgg.rows,
      totals: thisWeekAgg.totals,
    }),
  );
 
  // If we just rolled into a new week, also commit last week's final state.
  // (Otherwise last week's snapshot may be one sync stale.)
  await writeJsonAtomic(
    join(OUTPUT_DIR, "weeks", `${lastWeekKey}.json`),
    buildPayload({
      generated_at: nowIso,
      club,
      view: "week",
      range: { week_key: lastWeekKey },
      rows: lastWeekAgg.rows,
      totals: lastWeekAgg.totals,
    }),
  );
 
  log(`wrote leaderboard.json (cycle): ${cycleAgg.rows.length} athletes, ${cycleAgg.totals.distance} ${UNIT_LABEL}`);
  log(`wrote all-time.json: ${allTimeAgg.rows.length} athletes, ${allTimeAgg.totals.distance} ${UNIT_LABEL}`);
  log(`wrote this-week.json (${currentWeekKey}): ${thisWeekAgg.rows.length} athletes, ${thisWeekAgg.totals.distance} ${UNIT_LABEL}`);
  log(`wrote last-week.json (${lastWeekKey}): ${lastWeekAgg.rows.length} athletes, ${lastWeekAgg.totals.distance} ${UNIT_LABEL}`);
}
 
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[sync] FAILED:", err);
    process.exit(1);
  });
}
