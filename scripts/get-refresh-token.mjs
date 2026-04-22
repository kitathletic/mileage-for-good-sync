#!/usr/bin/env node
/**
 * get-refresh-token.mjs — one-time helper
 *
 * You only run this ONCE, locally, on your own computer.
 * It prints a Strava authorize URL, opens a tiny local web server on
 * http://localhost:8721, catches the redirect with ?code=..., exchanges
 * the code for a refresh token, and prints it.
 *
 * You then paste that refresh token into GitHub Actions secrets as
 * STRAVA_REFRESH_TOKEN. The token is long-lived and will auto-rotate.
 *
 * Before running:
 *   1. Create a Strava API application at https://www.strava.com/settings/api
 *   2. Set "Authorization Callback Domain" to: localhost
 *   3. Run:
 *        STRAVA_CLIENT_ID=xxx STRAVA_CLIENT_SECRET=yyy \
 *          node scripts/get-refresh-token.mjs
 */

import http from "node:http";

const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET } = process.env;
const PORT = Number(process.env.PORT || 8721);

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
  console.error("Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET first.");
  process.exit(1);
}

const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "read,activity:read_all,profile:read_all";

const authorizeUrl =
  "https://www.strava.com/oauth/authorize" +
  `?client_id=${encodeURIComponent(STRAVA_CLIENT_ID)}` +
  `&response_type=code` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&approval_prompt=force` +
  `&scope=${encodeURIComponent(SCOPE)}`;

console.log("\n==========================================================");
console.log(" STEP 1 — Open this URL in your browser and approve access:");
console.log("----------------------------------------------------------");
console.log(authorizeUrl);
console.log("==========================================================\n");
console.log(`Waiting for Strava to redirect to ${REDIRECT_URI} ...`);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const code = u.searchParams.get("code");
  const err = u.searchParams.get("error");
  if (err) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Strava returned error: ${err}`);
    console.error("Strava returned error:", err);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400);
    res.end("Missing ?code");
    return;
  }

  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });
    if (!tokenRes.ok) throw new Error(`${tokenRes.status} ${await tokenRes.text()}`);
    const body = await tokenRes.json();

    const summary = {
      athlete: body.athlete && {
        id: body.athlete.id,
        firstname: body.athlete.firstname,
        lastname: body.athlete.lastname,
      },
      scope: SCOPE,
      refresh_token: body.refresh_token,
      expires_at: body.expires_at,
    };

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<h1>Done ✓</h1><p>You can close this tab. Check your terminal for the refresh token.</p>`,
    );

    console.log("\n==========================================================");
    console.log(" STEP 2 — Copy the refresh_token below into GitHub Secrets");
    console.log("          as STRAVA_REFRESH_TOKEN:");
    console.log("----------------------------------------------------------");
    console.log(JSON.stringify(summary, null, 2));
    console.log("==========================================================\n");

    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
    console.error("Token exchange failed:", e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  // ready
});
