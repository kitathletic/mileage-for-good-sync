# Mileage for Good — live Strava leaderboard

A tiny, free pipeline that keeps the leaderboard on
`https://kitathletic.cc/pages/mileageforgood` in sync with your Strava club.

```
┌────────────┐   every 3h   ┌──────────────────┐   commits JSON    ┌────────────────────┐
│ GitHub     │ ───────────▶ │ Node sync script │ ────────────────▶ │ leaderboard.json   │
│ Actions    │   (cron)     │ (Strava API)     │                   │ (in this repo)     │
└────────────┘              └──────────────────┘                   └─────────┬──────────┘
                                                                             │ fetched on page load
                                                                             ▼
                                                                   ┌────────────────────┐
                                                                   │ Shopify page       │
                                                                   │ (Custom Liquid JS) │
                                                                   └────────────────────┘
```

Total cost: **£0**. Everything runs on GitHub's free tier.

---

## Why this shape

Strava's `/clubs/{id}/activities` endpoint is intentionally limited:
it returns only the ~200 most recent activities, with no dates, no
activity IDs, and only first name + last initial. That makes a single
"fetch and show" call useless for a multi-week campaign.

The sync script solves this by polling frequently and **accumulating**
activities into `data/activities.json`, deduped by a stable hash of
`athlete + type + distance + times + elevation`. The cumulative result
is written to `leaderboard.json`, which the Shopify page fetches
directly.

---

## Setup (one-time, ~15 minutes)

### 1. Create a Strava API application

1. Log into Strava **as a member of the Mileage for Good club** (the
   owner account is fine).
2. Go to <https://www.strava.com/settings/api>.
3. Fill in:
   - **Application Name:** `Kit Athletic Mileage for Good`
   - **Category:** Other
   - **Website:** `https://kitathletic.cc`
   - **Authorization Callback Domain:** `localhost`
4. Save. You'll see a **Client ID** and **Client Secret** — keep this
   tab open.

### 2. Find your Strava club ID

Open your club on strava.com (not the app link). The URL will look
like `https://www.strava.com/clubs/1234567`. The number at the end is
your `STRAVA_CLUB_ID`.

> The mobile app link (`strava.app.link/...`) does not expose the ID
> directly. Open the club in a desktop browser instead.

### 3. Get a refresh token (one-time)

On your own computer (needs Node.js 20+):

```bash
cd mileage-for-good-sync
STRAVA_CLIENT_ID=xxxxx \
STRAVA_CLIENT_SECRET=yyyyy \
  npm run token
```

This prints an authorize URL. Open it, approve access, and the
terminal will print a `refresh_token`. Copy it.

### 4. Create a GitHub repo

1. Create a new **public** repo, e.g. `kitathletic/mileage-for-good-sync`.
   (Public is required so `raw.githubusercontent.com` serves the JSON
   without an auth token. The leaderboard data is already public on
   Strava and on your Shopify page, so there's nothing sensitive here.)
2. Upload **everything in this folder** to the repo (drag-and-drop the
   files into the GitHub web UI, or `git push` from the command line).

### 5. Add the secrets and variables

In the GitHub repo:

**Settings → Secrets and variables → Actions → New repository secret**
| Name | Value |
|---|---|
| `STRAVA_CLIENT_ID` | from step 1 |
| `STRAVA_CLIENT_SECRET` | from step 1 |
| `STRAVA_REFRESH_TOKEN` | from step 3 |
| `STRAVA_CLUB_ID` | from step 2 |

**Settings → Secrets and variables → Actions → Variables tab → New variable**
(these are optional — skip any you don't need)
| Name | Example | Meaning |
|---|---|---|
| `CAMPAIGN_START_ISO` | `2026-05-01T00:00:00Z` | only count activities first seen after this |
| `CAMPAIGN_END_ISO`   | `2026-07-31T23:59:59Z` | only count activities first seen before this |
| `UNITS`              | `km` or `mi` | display units (default: `km`) |
| `ACTIVITY_TYPES`     | `Run,Ride,Walk,Hike` | allowlist; default is all types |

### 6. Trigger the first run

**Actions** tab → **Sync Strava leaderboard** → **Run workflow**.

If it's green, check the repo root — you should see an updated
`leaderboard.json`. If it's red, click into the run to see the error.

### 7. Wire up the Shopify page

1. Open `shopify-snippet.liquid` from this folder.
2. At the top of the `<script>` block, replace:
   ```js
   var MFG_LEADERBOARD_URL =
     "https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/YOUR_REPO/main/leaderboard.json";
   ```
   with the actual raw URL for your repo. You can find it by opening
   `leaderboard.json` in the GitHub web UI and clicking **Raw**.
3. Shopify admin → **Online Store → Pages → Mileage for Good**.
4. In the rich text editor, click the `</>` (Show HTML) button.
5. Paste the entire snippet where you want the leaderboard to appear.
6. Save.

Refresh <https://kitathletic.cc/pages/mileageforgood#challenge> — the
leaderboard should populate within a second or two.

> The Shopify page caches JS/CSS pretty aggressively. If you don't see
> updates, hard-refresh (Cmd-Shift-R / Ctrl-Shift-F5) or bump a query
> string on the `MFG_LEADERBOARD_URL`.

---

## Bootstrapping tip: seeding the campaign

Because Strava doesn't return activity dates, the script uses the time
**it first saw** each activity as the effective timestamp. That means:

- Activities that happened before your first sync run but are still in
  Strava's last-200 window when you run it **will be counted**.
- Activities older than that window are invisible to the API and can't
  be recovered.

So the safest bootstrap is:

1. Complete setup the day **before** your campaign starts.
2. Trigger the first run manually.
3. Set `CAMPAIGN_START_ISO` to your official start time — everything
   seen before that gets excluded from the leaderboard (but still
   stored for audit).

---

## Operations

- **Manual run:** Actions tab → workflow → Run workflow.
- **Logs:** each run is kept under Actions for 90 days.
- **Refresh token expired?** Re-run step 3 and update the secret.
- **Reset the leaderboard:** delete `data/activities.json` (or just
  empty the `activities` object) and commit. Next sync rebuilds from
  whatever is currently in Strava's window.
- **Change the schedule:** edit the cron expression in
  `.github/workflows/sync.yml`. `"0 */1 * * *"` is hourly. Don't go
  below 15 min — Strava rate limits and GitHub Actions minimum cron
  spacing both make it pointless.

---

## File map

```
mileage-for-good-sync/
├── README.md                        ← you are here
├── package.json
├── .gitignore
├── leaderboard.json                 ← output, regenerated every run
├── data/
│   └── activities.json              ← persistent dedup store
├── scripts/
│   ├── sync-leaderboard.mjs         ← the thing the cron runs
│   └── get-refresh-token.mjs        ← one-time OAuth helper
├── .github/
│   └── workflows/
│       └── sync.yml                 ← GitHub Actions cron
└── shopify-snippet.liquid           ← paste into Shopify page
```

---

## Known limits (be honest with your audience)

- **Display names are first name + last initial only** — that's all
  Strava's club API gives us.
- **Private activities are not counted** — Strava excludes them from
  the club feed.
- **Polling misses:** if someone logs >200 activities club-wide in 3h
  (unlikely for most clubs), the earliest ones may be missed.
- **No real-time updates.** Refresh happens every 3h on GitHub's cron,
  which itself can run a few minutes late.

If any of these become a problem, the next step up is to have each
participant OAuth individually — then we can call `/athlete/activities`
per member with real dates. Ask and I'll draft that version.
