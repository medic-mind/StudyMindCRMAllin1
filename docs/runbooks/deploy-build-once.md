# Runbook — Build-once deploys (GitHub Actions → GHCR → Railway)

**Goal:** stop Railway rebuilding the whole app on every deploy. GitHub Actions
builds the Docker image once (with reliable caching), pushes it to the GitHub
Container Registry (GHCR), and Railway just **pulls** the finished image.

This is safe to adopt gradually. Phase 1 changes nothing about how Railway
deploys today; Phase 2 is the switch, and you can revert it in one click.

---

## Phase 1 — publish images (already done in code)

The workflow `.github/workflows/deploy-image.yml` builds and pushes an image to
`ghcr.io/medic-mind/studymindcrmallin1` on every push to `main`. Railway keeps
building from the `Dockerfile` for now — this phase is purely additive.

**Verify it works:**
1. Push any change to `main` (or re-run the workflow from the Actions tab).
2. GitHub → the repo → **Actions** → **Build & publish deploy image** → confirm
   it goes green.
3. GitHub → the repo → **Packages** (right sidebar) → you should see a
   `studymindcrmallin1` container package with a `latest` tag and a `sha-…` tag.

Do not proceed to Phase 2 until you see the package published.

---

## Phase 2 — point Railway at the image

You need three things: a GHCR pull token (so Railway can pull a private image),
a Railway token (so CI can trigger the redeploy), and the service ID.

### 2a. Give Railway permission to pull the image

The package is private by default. Either:

- **Simplest:** GitHub → the repo → Packages → `studymindcrmallin1` → **Package
  settings** → **Change visibility** → Public. (The image holds compiled app
  code, no secrets — those are injected by Railway at runtime — but if you'd
  rather keep it private, use the token option below instead.)
- **Private:** create a GitHub **Personal Access Token (classic)** with the
  `read:packages` scope (GitHub → Settings → Developer settings → Tokens
  (classic)). You'll paste it into Railway in the next step.

### 2b. Switch the Railway `web` service to the image

Railway → your project → the **web** service → **Settings** → **Source**:
1. Change source to **Docker Image**.
2. Image: `ghcr.io/medic-mind/studymindcrmallin1:latest`
3. If the package is private, add the registry credentials: username = your
   GitHub username, password = the `read:packages` PAT from 2a.
4. Leave the **Start Command** and **Healthcheck** as they are
   (`sh scripts/deploy/start-web.sh`, `/api/health`). The image already runs
   migrations + seed + `next start` on boot, so nothing else changes.

> Keep the DATABASE_URL and all other environment variables exactly as they are
> — they're injected at runtime and are unaffected by where the image is built.

### 2c. Let CI trigger the redeploy on each push

Railway caches the `:latest` digest for hours and will **not** auto-pull a new
image, so CI has to nudge it.

1. Railway → the **web** service → **Settings** → copy the **Service ID**
   (a `…-…-…` UUID).
2. Railway → project → **Settings** → **Tokens** → create a **Project Token**
   for the environment you deploy (e.g. `production`). Copy it.
3. GitHub → the repo → **Settings** → **Secrets and variables** → **Actions**:
   - **New repository secret**: name `RAILWAY_TOKEN`, value = the project token.
   - **Variables** tab → **New repository variable**: name `RAILWAY_SERVICE_ID`,
     value = the Service ID from step 1.

Once `RAILWAY_TOKEN` exists, the workflow's final step runs `railway redeploy`
after each successful image push, and Railway pulls + boots the new image.

---

## Rollback (instant)

If a deploy misbehaves after switching: Railway → **web** → **Settings** →
**Source** → change back to the repo/**Dockerfile**. Railway builds from the
`Dockerfile` again exactly as before. Nothing in the repo needs reverting.

---

## What this buys you

- The ~4-min `next build` runs on GitHub's fast runners with persistent layer
  caching, not on Railway's Metal builder cold every time.
- Railway deploy becomes a pull of a slim (~160 MB `.next`, no build cache)
  image plus the normal boot — seconds, not minutes.
- The build is decoupled from the deploy, so a Railway restart never rebuilds.

## Follow-ups (once Phase 2 is stable)

- Add a BuildKit cache mount for `.next/cache` in the Dockerfile to make the CI
  `next build` incremental too (safe once Railway no longer builds the
  Dockerfile — Railway's Metal builder rejects cache-mount ids, GHA does not).
- Gate the image publish on the CI test job once the `@studymind/ai` test suite
  is green again, so a red build can't ship.
