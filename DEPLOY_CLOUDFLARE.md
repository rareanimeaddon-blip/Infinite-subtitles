# Deploy to Cloudflare Workers (free, no card, never sleeps)

Live: https://infinite-subtitles.teghvirsingh-work.workers.dev
Worker name: infinite-subtitles
Account: teghvirsingh.work@gmail.com (ff88fa5b128f90579393fceabcd439fd)

## Files
- `worker.js` — self-contained ES module (engine + handler). No Node APIs.
- `wrangler.toml` — name/main/compatibility_date/workers_dev.

## Re-deploy after editing worker.js
Use the Cloudflare connector (`/opt/hatch/bin/cloudflare execute`) with the
multipart upload (PUT /accounts/<id>/workers/scripts/infinite-subtitles),
metadata `{ main_module: "worker.js", compatibility_date: "2025-01-01", workers_dev: true }`.
Then enable the workers.dev route if it 404s:
POST /accounts/<id>/workers/scripts/infinite-subtitles/subdomain { enabled: true }.

Or with wrangler (needs a Cloudflare API token):
  npx wrangler deploy
