#!/usr/bin/env node
/**
 * sync-leaderboard.mjs
 *
 * Polls the Strava club activities endpoint, deduplicates activities
 * against a persistent store, and writes a leaderboard.json ready for
 * the Shopify page to render.
 *
 * Why the dedupe dance?
 *   Strava's /clubs/{id}/activities endpoint returns only the ~200 most
 *   recent club activities, with NO dates and NO activity IDs, and only
 *   first name + last-initial for the athlete. To aggregate over a
 *   multi-week campaign we have to poll frequently and accumulate.
 *
 * Env vars (all required unless noted):
 *   STRAVA_CLIENT_ID          Strava API app Client ID
 *   STRAVA_CLIENT_SECRET      Strava API app Client Secret
 *   STRAVA_REFRESH_TOKEN      Long-lived refresh token (see get-refresh-token.mjs)
 *   STRAVA_CLUB_ID            Numeric club ID (e.g. 123456)
 *   CAMPAIGN_START_ISO        Optional. Activities first seen before this
 *                             ISO timestamp are kept in the store but
 *                             excluded from leaderboard totals.
 *   CAMPAIGN_END_ISO          Optional. Same idea, upper bound.
 *   UNITS                     "km" (default) or "mi"
 *   ACTIVITY_TYPES            Comma-separated allowlist of Strava types to
 *                             count, e.g. "Run,Ride,Walk". Default: all.
 *   DATA_DIR                  Where to read/write state. Default: ./data
 *   OUTPUT_PATH               Where to write leaderboard.json. Default: ./leaderboard.json
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------- config ----------
const {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  STRAVA_REFRESH_TOKEN,
  STRAVA_CLUB_ID,
  CAMPAIGN_START_ISO,
  CAMPAIGN_END_ISO,
  UNITS = "km",
  ACTIVITY_TYPES,
  DATA_DIR = "data",
  OUTPUT_PATH = "leaderboard.json",
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
const TYPE_ALLOWLIST = ACTIVITY_TYPES
  ? new Set(ACTIVITY_TYPES.split(",").map((s) => s.trim()).filter(Boolean))
  : null;

const ACTIVITIES_FILE = join(DATA_DIR, "activities.json");

// ---------- helpers ----------
const log = (...args) => console.log("[sync]", ...args);

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
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

function hashActivity(a) {
  // Strava club activities lack id/date, so we build a stable hash from
  // fields that (together) uniquely identify a given activity.
  const athlete = `${(a.athlete?.firstname || "").trim()}|${(a.athlete?.lastname || "").trim()}`;
  const payload = [
    athlete.toLowerCase(),
    a.type || "",
    a.sport_type || "",
    Math.round((a.distance || 0) * 10) / 10, // round to 0.1m
    a.moving_time || 0,
    a.elapsed_time || 0,
    Math.round(a.total_elevation_gain || 0),
    (a.name || "").trim().toLowerCase(),
  ].join("::");
  return createHash("sha256").update(payload).digest("hex").slice(0, 20);
}

function athleteKey(a) {
  return `${(a.athlete?.firstname || "").trim()} ${(a.athlete?.lastname || "").trim()}`
    .trim()
    .toLowerCase();
}

function athleteDisplay(a) {
  const f = (a.athlete?.firstname || "").trim();
  const l = (a.athlete?.lastname || "").trim();
  return [f, l].filter(Boolean).join(" ") || "Anonymous";
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
  const body = await res.json();
  return body.access_token;
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
  // Strava caps at the most recent ~200 regardless of pagination, but we
  // still page through to be safe against future changes.
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
    if (newThisPage === 0) break; // Strava is returning duplicates — stop.
    if (batch.length < 200) break;
  }
  return all;
}

// ---------- main ----------
export async function main() {
  const now = new Date().toISOString();
  log(`run started at ${now}`);

  const accessToken = await refreshAccessToken();
  log("access token refreshed");

  const [club, activities] = await Promise.all([
    fetchClubMeta(accessToken),
    fetchClubActivities(accessToken),
  ]);
  log(`fetched ${activities.length} recent club activities`);

  await mkdir(DATA_DIR, { recursive: true });
  const store = await readJson(ACTIVITIES_FILE, { activities: {} });
  if (!store.activities) store.activities = {};

  let newCount = 0;
  for (const a of activities) {
    const h = hashActivity(a);
    if (!store.activities[h]) {
      store.activities[h] = {
        h,
        first_seen_at: now,
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
  log(`${newCount} new activities added to store (total: ${Object.keys(store.activities).length})`);

  store.last_synced_at = now;
  await writeJsonAtomic(ACTIVITIES_FILE, store);

  // ---------- build leaderboard ----------
  const startMs = CAMPAIGN_START_ISO ? Date.parse(CAMPAIGN_START_ISO) : -Infinity;
  const endMs = CAMPAIGN_END_ISO ? Date.parse(CAMPAIGN_END_ISO) : Infinity;

  const byAthlete = new Map();
  for (const a of Object.values(store.activities)) {
    const seen = Date.parse(a.first_seen_at);
    if (seen < startMs || seen > endMs) continue;
    if (TYPE_ALLOWLIST && !TYPE_ALLOWLIST.has(a.type) && !TYPE_ALLOWLIST.has(a.sport_type)) continue;

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

  const total = rows.reduce(
    (acc, r) => {
      acc.distance += r.distance;
      acc.activities += r.activities;
      acc.moving_time_s += r.moving_time_s;
      acc.elevation_m += r.elevation_m;
      return acc;
    },
    { distance: 0, activities: 0, moving_time_s: 0, elevation_m: 0 },
  );
  total.distance = +total.distance.toFixed(2);

  const payload = {
    generated_at: now,
    club: club
      ? { id: club.id, name: club.name, member_count: club.member_count, url: club.url }
      : { id: Number(STRAVA_CLUB_ID) },
    units: UNIT_LABEL,
    campaign: {
      start: CAMPAIGN_START_ISO || null,
      end: CAMPAIGN_END_ISO || null,
    },
    totals: total,
    rows,
  };

  await writeJsonAtomic(OUTPUT_PATH, payload);
  log(`wrote ${OUTPUT_PATH} (${rows.length} athletes, ${total.distance} ${UNIT_LABEL} total)`);
}

// Run only when invoked directly (not when imported in tests).
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[sync] FAILED:", err);
    process.exit(1);
  });
}
