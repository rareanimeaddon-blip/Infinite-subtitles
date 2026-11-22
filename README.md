# Infinite Streams Subtitles

A Stremio-compatible subtitle addon for **Nuvio** and **Stremio**. It searches
SubDL, Wyzie and OpenSubtitles and returns ranked English subtitles, best
first — including the pre-synced Sunsync subtitles for The Matrix, Project
Hail Mary, Inception and Breaking Bad S1E1.

It supports the **Infinite Streams** plugin: it provides subtitles for the
same titles the plugin plays (movies, series and anime, by IMDb id). Install
it alongside the plugin in Nuvio and the subtitles appear in the player's
subtitle list — this is the addon path, which works in stock Nuvio (provider
subtitles attached by a plugin do not display in the stock app).

## How it works

- **Manifest:** `GET /manifest.json` — resources `["subtitles"]`, types
  `movie`, `series`, `anime`, id prefix `tt`.
- **Subtitles:** `GET /subtitles/:type/:id.json`
  (e.g. `/subtitles/movie/tt12042730.json`,
  `/subtitles/series/tt0903747:1:1.json`).
- **Sources, in order:** Sunsync pre-synced (4 titles) → SubDL (direct
  `.srt` via `unpack_files`, api key stripped) → Wyzie (direct
  `sub.wyzie.io` links) → OpenSubtitles mirror (no key).
- **Ranking:** best first by format (srt/vtt), non-HI, release quality
  (BluRay/WEB-DL, 1080p/2160p) and source. Deduplicated by URL, capped at
  30. For series, SubDL/Wyzie results are filtered to the requested
  episode (SxxEyy), so season packs and other seasons never rank.
- **Cache:** 1 hour in-memory per title, so repeat requests don't burn
  provider quota.
- **No keys in the code:** keys come from environment variables only.

## Deploy

### Vercel (free, no card, never sleeps)

1. Sign up at https://vercel.com (free Hobby plan, no card).
2. **Add New → Project → Import Git Repository** → pick
   `rareanimeaddon-blip/Infinite-subtitles`.
3. Leave the settings as they are and click **Deploy**.
4. You get a link like `https://infinite-subtitles.vercel.app`.
   Open it, enter your keys on the landing page, and you get your
   personal manifest link to paste in Nuvio / Stremio.

Vercel runs the addon as a serverless function (`api/index.js`, via the
rewrite in `vercel.json`), so it never sleeps and costs nothing on the
free plan (100,000 requests/day). No environment variables needed.

### Northflank / Render (plain Node server)

Runs the same code as a long-running server (`node server.js`).
Northflank's free Sandbox is always-on; Render's free tier sleeps
after 15 minutes idle. No environment variables needed.

## Run locally

```bash
npm start
# Landing page: http://localhost:3000/
# Manifest: http://localhost:3000/manifest.json
```

## How users set up their own API keys

Each user sets up their own keys — nothing is stored on the server:

1. Open the landing page (`/`).
2. Enter their own SubDL and Wyzie API keys (free keys from
   https://subdl.com and https://wyzie.io).
3. The page gives them a personal manifest link:
   `https://<host>/<config>/manifest.json` — the keys are encoded in
   the link itself.
4. They paste that link into Nuvio / Stremio under Addons.

Keep the manifest link private: it contains the keys, and anyone with
it can use them. The plain `/manifest.json` (no config) works too, but
only with OpenSubtitles + pre-synced subtitles — no SubDL or Wyzie.

## Environment variables (optional server-side fallback)

| Variable | Required | Notes |
|---|---|---|
| `SUBDL_API_KEY` | no | Host operator's key, used when a request has no config key |
| `SUBDL_API_KEY2` | no | Second key, tried if the first fails |
| `WYZIE_API_KEY` | no | Host operator's key |
| `WYZIE_API_KEY2` | no | Second key, tried if the first fails |
| `PORT` | no | Default `3000` |

## Deploy

### Render (free)

1. Push this repo to GitHub.
2. In Render, **New → Web Service**, pick the repo.
3. Runtime: **Node**. Build command: `npm install`. Start command:
   `npm start`.
4. Add the four environment variables above.
5. Deploy. Your manifest URL is
   `https://<your-service>.onrender.com/manifest.json`.

Note: Render's free tier sleeps after inactivity, so the first subtitle
request after a while can be slow. If that bothers you, use a host
without sleep (e.g. Vercel serverless or a small VPS).

### Any Node host / VPS

```bash
git clone <this repo>
cd infinite-streams-subtitles
npm install
SUBDL_API_KEY=... SUBDL_API_KEY2=... WYZIE_API_KEY=... WYZIE_API_KEY2=... npm start
```

## Install in Nuvio / Stremio

1. Copy your manifest URL: `https://<your-host>/manifest.json`.
2. Nuvio: **Addons → Add addon → paste the URL → Install**.
3. Stremio: **Addons → search / paste the URL**.
4. Play any title (including via the Infinite Streams plugin) and open
   the subtitle list — the addon's subtitles appear there, best first.

## Test

```bash
# needs the keys in the environment (or edit test-local.js to load them)
node test-local.js
```

`test-local.js` loads keys from the secret gist (in-memory only, never
logged) and checks the manifest plus Matrix, Project Hail Mary, Breaking
Bad S1E1, Inception and Stranger Things S1E1.

## Files

- `server.js` — HTTP server, manifest + subtitles endpoints.
- `engine.js` — shared subtitle engine (providers, ranking, dedup, cache).
- `test-local.js` — local test (keys from gist, never logged).
