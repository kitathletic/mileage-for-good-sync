# Step-by-step setup guide

This walks you through every click. Total time: ~25 minutes. No developer experience required — if you can copy/paste and follow buttons, you can do this.

You'll need:
- Your Strava login
- A GitHub account (free — if you don't have one, sign up at <https://github.com/signup>)
- Access to your Shopify admin
- A computer with a terminal (Mac Terminal, or Windows PowerShell)

At the end you'll have a leaderboard on `kitathletic.cc/pages/mileageforgood` that updates every 3 hours automatically.

---

## Part 1 — Create a Strava API application (5 min)

1. Open <https://www.strava.com/settings/api> in your browser. Log in if asked.

2. If this is your first time here, Strava will ask you to "Create & Manage Your App". Fill in:

   | Field | What to enter |
   |---|---|
   | **Application Name** | `Kit Athletic Mileage for Good` |
   | **Category** | `Other` |
   | **Club** | leave blank |
   | **Website** | `https://kitathletic.cc` |
   | **Application Description** | `Live leaderboard sync for our Mileage for Good campaign.` |
   | **Authorization Callback Domain** | `localhost` ← important, this exact word |

3. Upload any image as the logo (a Kit Athletic logo, or anything — Strava requires one).

4. Click **Create**. You'll be taken to a page showing:
   - **Client ID** (a number like `148567`)
   - **Client Secret** (a long string — click "Show" to reveal it)

5. **Leave this tab open.** You'll copy these values into GitHub in Part 3.

---

## Part 2 — Find your Strava club ID (1 min)

1. Open <https://www.strava.com> on a desktop browser (the mobile app link doesn't expose the ID).
2. Go to your **Mileage for Good club** page.
3. Look at the URL in your address bar — it looks like:
   ```
   https://www.strava.com/clubs/1234567
   ```
   The number at the end is your **Club ID**. Write it down.

---

## Part 3 — Get a Strava refresh token (5 min)

A refresh token is a long-lived credential the automation will use to fetch data. You generate it once.

### 3a. Visit the authorize URL

1. Take this URL and replace `YOUR_CLIENT_ID` with the Client ID from Part 1:
   ```
   https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost/exchange&approval_prompt=force&scope=read,activity:read_all,profile:read_all
   ```
2. Paste it into your browser. You'll see a Strava page asking you to authorize your own app.
3. Make sure **all permission checkboxes are ticked**.
4. Click **Authorize**.

### 3b. Copy the `code` from the URL

Strava will redirect to `http://localhost/exchange?state=&code=SOMETHING&scope=...`. Your browser will show **"This site can't be reached"** — that's expected. The part that matters is in the address bar:

```
http://localhost/exchange?state=&code=abc123def456...&scope=read,...
```

**Copy the value after `code=` and before `&scope=`.** That's your authorization code. It's one-time use and expires in minutes — use it right away in step 3c.

### 3c. Exchange the code for a refresh token

Open a terminal:
- **Mac:** Cmd-Space, type "Terminal", hit Enter.
- **Windows:** Start menu, type "PowerShell", hit Enter.

Paste this command, filling in the three values:

```bash
curl -X POST https://www.strava.com/oauth/token \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET \
  -d code=YOUR_AUTHORIZATION_CODE \
  -d grant_type=authorization_code
```

Hit Enter. You'll get back a JSON response like:

```json
{
  "token_type": "Bearer",
  "expires_at": 1745500000,
  "refresh_token": "a1b2c3d4e5f6...",
  "access_token": "x9y8z7w6...",
  "athlete": { "id": 12345, "firstname": "Andrew", ... }
}
```

**Copy the `refresh_token` value.** This is the third thing you need for GitHub.

> If `curl` isn't recognised on Windows, use PowerShell's `Invoke-RestMethod` instead:
> ```powershell
> Invoke-RestMethod -Method Post -Uri https://www.strava.com/oauth/token -Body @{
>   client_id='YOUR_CLIENT_ID'; client_secret='YOUR_CLIENT_SECRET';
>   code='YOUR_AUTHORIZATION_CODE'; grant_type='authorization_code'
> }
> ```

At this point you should have these 4 values written down somewhere safe:
- Client ID
- Client Secret
- Refresh Token
- Club ID

---

## Part 4 — Create the GitHub repo (8 min)

### 4a. Create a new repo

1. Go to <https://github.com/new> (log in if needed).
2. Fill in:
   - **Repository name:** `mileage-for-good-sync`
   - **Description:** `Strava leaderboard sync for Mileage for Good`
   - **Public** ← must be public (so Shopify can fetch the JSON; none of the data is sensitive)
   - Leave "Add a README" **unchecked**
3. Click **Create repository**.

### 4b. Upload the files

You'll see a page with instructions. Ignore them. Instead:

1. Click the **"uploading an existing file"** link (under the "or push an existing repository" section, or click "Add file" → "Upload files" on the repo page).
2. In a separate Finder/Explorer window, open the `mileage-for-good-sync` folder I produced.
3. **Drag every file and folder** into the GitHub upload area. Include:
   - `.github/` folder (and the workflow inside it)
   - `data/` folder
   - `scripts/` folder
   - `.gitignore`
   - `README.md`
   - `SETUP-STEP-BY-STEP.md` (this file)
   - `leaderboard.json`
   - `package.json`
   - `shopify-snippet.liquid`
4. Scroll down. In the commit message box, type `Initial setup`.
5. Click **Commit changes**.

> **Gotcha:** GitHub's web upload sometimes hides the `.github` folder because it starts with a dot. If after upload you don't see a `.github` folder at the top of your repo, drag-and-drop the folder again. You can verify by navigating to `.github/workflows/sync.yml` directly in the URL: `https://github.com/YOUR_USERNAME/mileage-for-good-sync/blob/main/.github/workflows/sync.yml`

### 4c. Add the secrets

1. In your repo, click **Settings** (top menu, far right).
2. In the left sidebar, click **Secrets and variables** → **Actions**.
3. Click the green **New repository secret** button. Add each of these, one at a time:

   | Name (exactly) | Value |
   |---|---|
   | `STRAVA_CLIENT_ID` | your Client ID number |
   | `STRAVA_CLIENT_SECRET` | your Client Secret |
   | `STRAVA_REFRESH_TOKEN` | your Refresh Token |
   | `STRAVA_CLUB_ID` | your Club ID number |

4. (Optional) Click the **Variables** tab (right next to "Secrets" on the same page). If you want a campaign window or specific units, add:

   | Variable name | Example value |
   |---|---|
   | `CAMPAIGN_START_ISO` | `2026-05-01T00:00:00Z` |
   | `CAMPAIGN_END_ISO`   | `2026-07-31T23:59:59Z` |
   | `UNITS` | `km` (or `mi`) |
   | `ACTIVITY_TYPES` | `Run,Ride,Walk,Hike,VirtualRun,VirtualRide` |

   Skip this if you want defaults (all activities, km, no date limit).

### 4d. Trigger the first run

1. In your repo, click the **Actions** tab.
2. If GitHub asks you to enable Actions, click **I understand my workflows, go ahead and enable them**.
3. In the left sidebar click **Sync Strava leaderboard**.
4. Click the **Run workflow** button on the right → **Run workflow** again in the popup.
5. After ~10 seconds the run appears. Click into it.
6. Click the **sync** job → expand the **Run sync script** step.

**If it's green:** congrats, data is flowing. Click back to your repo, open `leaderboard.json`, and you should see athletes in the `rows` array.

**If it's red:** read the error. The most common one is a 401 from Strava — usually means the refresh token is wrong. Re-do Part 3 and update the `STRAVA_REFRESH_TOKEN` secret.

---

## Part 5 — Wire it up to Shopify (5 min)

### 5a. Get your leaderboard.json URL

1. In your GitHub repo, click on `leaderboard.json`.
2. Click the **Raw** button (top right of the file view).
3. The URL in your browser now looks like:
   ```
   https://raw.githubusercontent.com/YOUR_USERNAME/mileage-for-good-sync/main/leaderboard.json
   ```
4. Copy that URL.

### 5b. Paste the snippet into Shopify

1. Open Shopify admin → **Online Store → Pages**.
2. Click into **Mileage for Good**.
3. In the content editor, click the **`</>`** icon (Show HTML).
4. Open `shopify-snippet.liquid` in a text editor (TextEdit, Notepad, VS Code — anything).
5. Find this line near the top of the `<script>` block:
   ```js
   var MFG_LEADERBOARD_URL =
     "https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/YOUR_REPO/main/leaderboard.json";
   ```
6. Replace the placeholder URL with the real one you copied in 5a.
7. **Copy the entire snippet file** (select all → copy).
8. Back in Shopify, paste the snippet where you want the leaderboard to appear. If your current page already has a leaderboard section, paste it just above or below that section — you can delete your old markup after you verify this one works.
9. Click **Save**.

### 5c. Verify on the live site

1. Open <https://kitathletic.cc/pages/mileageforgood#challenge> (hard refresh: Cmd-Shift-R on Mac, Ctrl-F5 on Windows).
2. You should see:
   - A header with a big total km number
   - The leaderboard table populated
   - "Last updated X min ago" footer

If you see **"Leaderboard is syncing — check back soon."** the JS couldn't fetch the JSON. Check:
- Is the `MFG_LEADERBOARD_URL` exactly right? (copy/paste it into a new browser tab — it should show JSON)
- Did the first GitHub Actions run actually finish green?

---

## You're done

From now on:
- Every 3 hours on the hour (UTC), GitHub runs the workflow.
- Each run fetches the latest Strava club activities, adds any new ones to the store, recomputes the leaderboard, and commits it.
- Your Shopify page reads the updated JSON the next time a visitor loads the page.

**Test it's working tomorrow:** go to the Actions tab and confirm the scheduled runs are appearing on their own.

Questions that might come up:
- **"Can I run it manually right now?"** Yes — Actions tab → Run workflow, any time.
- **"Can I change the schedule to every hour?"** Yes — edit `.github/workflows/sync.yml`, change `"0 */3 * * *"` to `"0 * * * *"`, commit.
- **"The leaderboard shows wrong totals / I want to reset it."** Edit `data/activities.json`, replace with `{"activities": {}, "last_synced_at": null}`, commit. Next sync rebuilds.
- **"How do I change the look of the table?"** Edit `shopify-snippet.liquid` in Shopify directly — the `<style>` block at the top controls everything.
