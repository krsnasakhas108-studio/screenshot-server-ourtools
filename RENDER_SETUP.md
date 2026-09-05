# Render Dashboard Settings

These are manual settings in the Render dashboard — nothing in this repo can set them for you. Apply them under your service's **Settings** tab.

## Why this matters

The server was returning HTTP 500 on every screenshot request. The root cause: Puppeteer's Chrome gets downloaded into a cache directory at build time, but at runtime `puppeteer.executablePath()` (via `.puppeteerrc.cjs`) was looking for it in a location that, on Render, ended up being a different path than where it was actually installed — so every browser launch failed with "Could not find Chrome," which the server correctly caught and turned into a 500. This was reproduced and confirmed locally: `puppeteer.executablePath()` throws with an explicit "your cache path is incorrectly configured" message pointing at the mismatched path, and setting `PUPPETEER_CACHE_DIR` to the correct absolute path fixes it immediately.

The fix has two parts, and **both must be set** — one alone isn't enough:

## 1. Build Command

```
npm install && npx puppeteer browsers install chrome
```

Don't rely on the `postinstall` npm script alone (it's still there as a local-dev convenience, and as a second attempt) — some CI/build systems skip lifecycle scripts, or run them in a working directory where `.puppeteerrc.cjs` isn't picked up the same way. Making the browser install an explicit step of the Build Command guarantees it always runs, in the same environment, right before the app starts.

## 2. Start Command

```
node server.js
```

(No change from before — the fix is entirely in how/where the browser gets installed and found, not in how the server starts.)

## 3. Environment Variables

Add this in **Settings → Environment**:

| Key | Value |
|---|---|
| `PUPPETEER_CACHE_DIR` | `/opt/render/project/src/.cache/puppeteer` |

This is the important one. It forces both the Build Command's `npx puppeteer browsers install chrome` step and the running server's `puppeteer.executablePath()` lookup to use the exact same absolute path, eliminating the mismatch that caused the 500s. `/opt/render/project/src` is Render's standard project root for a Node web service — don't change that part unless Render's own dashboard shows a different root for your service (check the "Root Directory" setting if you're unsure).

## 4. Node Version

Already pinned in `package.json` via `"engines": { "node": "20.x" }` — Render reads this automatically. No dashboard setting needed, but if you ever see a different Node version in the deploy logs, check **Settings → Environment → NODE_VERSION** isn't overriding it.

## 5. Instance Type

The code now reuses a single browser instance across requests (previously it launched a brand-new Chrome process per request, which is slow and memory-heavy). This should meaningfully help stability on the free tier, but Puppeteer + Chrome is still memory-hungry — if you keep seeing crashes/restarts in the Render logs under real traffic, an upgrade from the free 512MB instance to the next tier up is the most likely fix, not another code change.

## After deploying

Check these two things:

1. **Deploy logs** during the build should show Chrome actually being downloaded (`npx puppeteer browsers install chrome` output, several hundred MB).
2. **`GET /health`** should return `{"status":"ok","browserConnected":true,...}` once the service is live. If `browserConnected` is ever `false`, check the logs for a "Chrome not found" or launch error — it means the cache directory still isn't lining up, and the `PUPPETEER_CACHE_DIR` value above is the first thing to double check.
