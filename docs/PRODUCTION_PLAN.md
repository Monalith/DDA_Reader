# MotoRaceLaps / DDA Lab — Production Launch Plan

Owner: Eren (solo) · Written: 2026-10-16 · Scope: `motoracelaps.com` (landing + `/lab/`) and `dda.kitchenonstage.com` (to become staging)

## 1. Türkçe özet

1. **Neredeyiz:** Ürün çalışıyor ve canlıda (motoracelaps.com + /lab/), 771 vitest testi (768 geçiyor, 3 sim kalibrasyon testi kırmızı), 64 pytest, 8 Playwright e2e dosyası var.
2. Altyapı tek bir $4/ay 512 MB droplet: nginx + uvicorn (`dda-lab`, 200 MB) + cloudflared. Yedek, izleme ve CI **hiç yok**.
3. Giriş (Google + e-posta kodu) ve kullanım istatistikleri şu anda yazılıyor (`bridge/auth.py`, `bridge/stats.py` henüz iskelet).
4. **Açılışı engelleyenler:** güvenlik başlıkları/HSTS yok, gzip yok (1,9 MB JS sıkıştırılmadan gidiyor), CORS `*`, rate limit yok, gizlilik politikası/şartlar yok (Google login e-posta saklayacak → GDPR/KVKK).
5. Ayrıca: git remote URL'sinde gömülü GitHub token var (repo herkese açık, token'ı hemen iptal et), 136 commit push edilmemiş, LICENSE dosyası yok ama sitede "MIT" yazıyor.
6. **Faz 1 — Sağlamlaştırma (~2 gün, ~16 saat):** nginx başlıkları + gzip + rate limit, sırların döndürülmesi, auth sertleştirme, SQLite yedeği DO Spaces'a + geri yükleme provası, UptimeRobot + Sentry.
7. **Faz 2 — Süreç (~1,5 gün, ~12 saat):** GitHub Actions CI, staging (dda.kitchenonstage.com), yasal sayfalar + çerez/analitik onayı, veri silme yolu, droplet 1 GB'a yükseltme.
8. **Faz 3 — Pazarlama öncesi cila (~2 gün, ~14 saat):** Lighthouse bütçesi, OG görseli, hata sınırı (ErrorBoundary) UX'i, geri bildirim linki, durum sayfası, onboarding turu.
9. Toplam ≈ 42 saat tek kişi işi; maliyet $4/ay'dan ≈ $12/ay'a çıkar (1 GB droplet + Spaces + DO yedekleri; izleme ücretsiz katmanda).
10. İlk 90 günde izlenecekler: haftalık aktif kullanıcı, açılan dosya sayısı, simülatör kullanımı, 4. hafta tutma oranı.

---

## 2. Current state audit

Evidence gathered 2026-10-16 from the repo (read-only) and live `curl` checks.

| Area | Status | Evidence |
|---|---|---|
| Hosting | 🟡 | Single droplet kos-web (fra1, 512 MB, $4/mo) shared with the KOS marketing site. `deploy_lab.sh` rsyncs `viewer_lab/` + `bridge/` and restarts systemd `dda-lab` (uvicorn :8777, MemoryMax 200 MB). No swap/upgrade plan. pip install runs on the box at every deploy (RAM spike risk). |
| TLS | 🟡 | Let's Encrypt cert valid 2026-10-09 → 2027-01-07 (issuer YE2); HTTP→HTTPS 301 works. Served over **HTTP/1.1 only** (no `http2`). No HSTS. |
| Security headers | 🔴 | `curl -I https://motoracelaps.com/` returns only `Server: nginx/1.24.0 (Ubuntu)` (version leak). No CSP, X-Content-Type-Options, Referrer-Policy, frame-ancestors, Permissions-Policy. |
| CORS | 🔴 | `dda_lab_bridge.py` ~L311: `allow_origins=["*"]`, comment says "bound to 127.0.0.1 only" — true for desktop, false behind nginx. Live preflight from `Origin: https://evil.example` → `access-control-allow-origin: *`, methods incl. PUT/DELETE. |
| Rate limiting | 🔴 | None in nginx or FastAPI. `PUT /corridors/{key}` is token-gated (`DDA_CORRIDOR_TOKEN`) + size-capped (413); `/analyze-schema` upload and the upcoming `/api/auth/*` (e-mail code → Resend cost/abuse) and `/api/stats/events` are not limited. |
| Auth | 🟡 | `bridge/auth.py` (72 lines) is a contract with TODOs: signed `session` cookie (itsdangerous), state cookie, `ADMIN_EMAILS`, `require_admin`, `/lab/`→`/login` redirect. `otp_codes` table has `attempts`. Being implemented now — needs hardening review before launch. |
| Secrets | 🔴 | Secrets in a systemd drop-in on the droplet (no inventory, no rotation). **Local git remote `mine` embeds a `gho_` GitHub token in the URL** and the repo `github.com/Monalith/DDA_Reader` is public (HTTP 200) — token must be revoked. Memory notes say KOS keys from public history were never rotated. |
| Data / privacy | 🟡 | Files are parsed in-browser (landing `#privacy` section states this). Server stores corridors (`corridors/*.json`), schema images, and soon `users` (e-mail, name, avatar), `otp_codes`, `usage_events` (user_id/anon_id/props) in SQLite (`bridge/db.py`). No privacy policy, terms, cookie note, retention rule, or deletion path. |
| Observability | 🔴 | `/health` exists (`{"ok":true,"claude":false}`) but **HEAD /health → 405** (many uptime checkers default to HEAD). No uptime monitor, no error tracking, logs only in journald, no logrotate policy for nginx review. |
| Backups | 🔴 | None. `/opt/dda-lab/dda_lab.db` + corridors live on one disk; droplet backups not enabled. |
| CI/CD | 🔴 | No `.github/` directory. Manual `./deploy_lab.sh` / `./deploy_site.sh` from the Mac. `main` is **136 commits ahead of origin** (unpushed). 3 vitest tests currently fail (`simFitRider.test.ts` ×2, `simLapTimeSerres.test.ts` ×1). |
| Staging | 🔴 | `dda.kitchenonstage.com` serves the same `/opt/dda-lab` process as production (same DB) — not a staging. |
| Performance | 🔴 | Main bundle `index-*.js` = **1.88 MB, served without gzip/brotli** (`Content-Length: 1883604`, no `Content-Encoding`). Assets do get `max-age=31536000, immutable`; `/lab/` HTML `no-cache` (correct). maplibre worker 500 KB. |
| Legal | 🔴 | No privacy policy / terms / imprint pages. Landing says "open source (MIT)" but repo has **no LICENSE file**. "Ducati" trademark used in product copy → add a non-affiliation disclaimer. |
| Product polish | 🟡 | 20 UI modules, guide (`src/guide/MATH_GUIDE.md`), example Serres laps, video sync. No React ErrorBoundary found in `dda_lab/src`. `src/analytics/` empty (stats client pending). |
| SEO | 🟢 | Title, description, OG/Twitter tags, JSON-LD, `robots.txt`, `sitemap.xml` (200). OG image reuses a screenshot (`img/app-examples.jpg`) rather than a 1200×630 card. |
| Docs / support | 🟡 | `README.md` (desktop-tool oriented, references `slowfastguy/DDA_Reader`), `docs/MATH_GUIDE.md`, specs under `docs/superpowers/specs/`. No contact/feedback channel, no FAQ, no status page. |

---

## 3. Launch blockers (must-do before public launch)

Order = suggested execution order. Effort is focused hours for one person.

### B1. Revoke leaked token, push, add LICENSE — 1 h
- **Why:** a live GitHub token in a remote URL leaks via shell history, backups, screenshots; the repo is public. Unpushed commits = single point of failure on the Mac Mini.
- **Steps:**
  ```bash
  # revoke at github.com/settings/tokens (or `gh auth refresh`), then:
  git remote set-url mine https://github.com/Monalith/DDA_Reader.git
  gh auth login   # or a credential helper: git config --global credential.helper osxkeychain
  git push mine main
  # add LICENSE (MIT, "Copyright (c) 2026 Eren Uyanık"), fix README clone URL
  ```
- **Acceptance:** `git remote -v` shows no credentials; `git status -sb` not "ahead"; `LICENSE` exists on GitHub.

### B2. nginx: HTTP/2, HSTS, security headers, gzip, hide version — 2 h
- **Why:** 🔴 headers + 1.9 MB uncompressed JS (≈ 550 KB gzipped → ~3× faster first load on mobile).
- **Steps** (`/etc/nginx/sites-available/motoracelaps`, keep a `.bak`):
  ```nginx
  server_tokens off;                                  # in http{} (nginx.conf)
  listen 443 ssl; http2 on;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;   # add `preload` only after 4 weeks clean
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Content-Security-Policy-Report-Only "default-src 'self'; img-src 'self' data: blob: https:; connect-src 'self' https:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com" always;
  gzip on; gzip_vary on; gzip_comp_level 5; gzip_min_length 1024;
  gzip_types text/css application/javascript application/json image/svg+xml text/plain application/geo+json;
  ```
  Satellite tiles / map styles need their hosts in `img-src`/`connect-src` — run CSP as **Report-Only for 1 week**, read the console, then enforce. Note: `add_header` in a `location` block drops server-level headers → put them in a shared `snippets/security.conf` and `include` it in each location that adds headers.
  `nginx -t && systemctl reload nginx`
- **Acceptance:** `curl -sI --compressed https://motoracelaps.com/lab/assets/index-*.js | grep -i content-encoding` → `gzip`; `curl -sI https://motoracelaps.com/ | grep -i strict-transport`; securityheaders.com grade ≥ A; `curl -sI --http2 …` → `HTTP/2`.

### B3. Lock down CORS and add rate limits — 2 h
- **Why:** `*` CORS on a cookie-auth API is a foot-gun; e-mail codes cost money and can be abused for spam/enumeration.
- **Steps:**
  - `dda_lab_bridge.py`: `allow_origins = os.environ.get("ALLOWED_ORIGINS","*").split(",")`; on the server set `ALLOWED_ORIGINS=https://motoracelaps.com,https://dda.kitchenonstage.com`. Desktop/portable keeps `*` (127.0.0.1 only).
  - nginx (`http{}`):
    ```nginx
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=auth:10m rate=5r/m;
    limit_req_status 429;
    location /api/auth/ { limit_req zone=auth burst=5 nodelay; proxy_pass http://127.0.0.1:8777; }
    location ~ ^/(api|corridors|analyze-schema) { limit_req zone=api burst=30 nodelay; client_max_body_size 12m; proxy_pass http://127.0.0.1:8777; }
    ```
  - App-level (in `bridge/auth.py`): max 3 codes / e-mail / 15 min, max 5 attempts per code (column exists), code TTL 10 min, constant-time compare, same response whether or not the e-mail exists.
  - `bridge/stats.py`: cap batch ≤ 50 events, body ≤ 16 KB, drop unknown event names.
- **Acceptance:** `for i in $(seq 20); do curl -s -o /dev/null -w "%{http_code} " -X POST https://motoracelaps.com/api/auth/email/start -d '{}'; done` shows `429`s; evil-origin preflight no longer returns `*`; pytest covers OTP attempt limit.

### B4. Auth hardening review (after agents A/B land) — 3 h
- **Why:** session cookies + OAuth are the only real attack surface.
- **Checklist:**
  - [ ] Session cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`, `Max-Age` ≤ 30 days, signed with `SESSION_SECRET` (≥ 32 random bytes, `openssl rand -base64 48`); fail to start if auth enabled and secret short.
  - [ ] Session payload carries `uid` + `iat` + a per-user `session_version`; bump it on logout-everywhere / role change / deletion → old cookies rejected (rotation).
  - [ ] New session value issued at every login (no fixation); OAuth `state` cookie single-use, 10 min, compared constant-time; verify Google `id_token` `aud`, `iss`, `exp`, `email_verified`.
  - [ ] CSRF on every state-changing POST/PUT/DELETE: SameSite=Lax + require `Origin`/`Referer` ∈ `ALLOWED_ORIGINS` (small middleware) — or a double-submit `X-CSRF-Token` header from `src/auth/client.ts`.
  - [ ] Redirect after login only to relative paths (no open redirect via `?next=`).
  - [ ] `ADMIN_EMAILS` compared lower-cased; `/api/stats/summary` returns 403 for non-admin (pytest).
  - [ ] Logs never print codes, cookies, or tokens.
- **Acceptance:** pytest cases for tampered cookie, expired cookie, bumped session_version, missing Origin on POST → 403; manual Google login on staging.

### B5. Secrets inventory and rotation — 1.5 h
- **Why:** secrets live untracked in a systemd drop-in; some KOS-era keys are known-exposed.
- **Steps:**
  1. Move to `/etc/dda-lab/env` (`chmod 600`, root-owned), referenced by `EnvironmentFile=` in `/etc/systemd/system/dda-lab.service.d/override.conf`; delete inline `Environment=` lines.
  2. Inventory table in the private `PROJECT.md` (not the repo): `SESSION_SECRET, GOOGLE_CLIENT_ID/SECRET, RESEND_API_KEY, MAIL_FROM, DDA_CORRIDOR_TOKEN, SENTRY_DSN, SPACES_KEY/SECRET` — owner, where used, last rotated.
  3. Generate fresh `SESSION_SECRET` and `DDA_CORRIDOR_TOKEN`; create a **dedicated** Google OAuth client and Resend key for MotoRaceLaps (do not share KOS ones); restrict Resend key to "sending" scope and verify the `motoracelaps.com` domain (SPF/DKIM/DMARC in GoDaddy DNS).
  4. Rotation cadence: every 6 months or immediately on suspicion; `systemctl daemon-reload && systemctl restart dda-lab`.
- **Acceptance:** `systemctl show dda-lab -p Environment` shows nothing secret; `ls -l /etc/dda-lab/env` → `-rw------- root`; `grep -rE "gho_|re_[A-Za-z0-9]{10}" .` in the repo → empty.

### B6. Nightly backup of SQLite + corridors to DO Spaces, with restore drill — 3 h
- **Why:** user accounts and saved track models exist on one disk only.
- **Steps:**
  1. Create Space `motoracelaps-backups` (fra1, private) + a scoped access key; enable a lifecycle rule (expire > 30 days).
  2. `apt install sqlite3 rclone`; `rclone config` → remote `spaces` (provider DigitalOcean, endpoint `fra1.digitaloceanspaces.com`).
  3. `/usr/local/bin/dda-backup.sh`:
     ```bash
     #!/bin/bash
     set -euo pipefail
     TS=$(date -u +%Y%m%dT%H%M%SZ); T=/var/backups/dda; mkdir -p $T
     sqlite3 /opt/dda-lab/dda_lab.db ".backup '$T/dda_lab-$TS.db'"     # online-safe copy
     sqlite3 "$T/dda_lab-$TS.db" "PRAGMA integrity_check;" | grep -qx ok
     tar czf "$T/files-$TS.tgz" -C /opt/dda-lab corridors schemas 2>/dev/null || true
     gzip "$T/dda_lab-$TS.db"
     rclone copy $T spaces:motoracelaps-backups/$(date -u +%Y/%m)/ --min-age 0
     find $T -mtime +3 -delete
     curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null   # dead-man switch (healthchecks.io free)
     ```
  4. systemd timer `dda-backup.timer` `OnCalendar=*-*-* 03:30:00 UTC`, `Persistent=true`.
  5. Also enable DO droplet weekly backups (+20 % of droplet price) as a second layer.
  6. **Restore drill (monthly, 20 min):** download latest from Spaces on the Mac, `gunzip`, `sqlite3 x.db "select count(*) from users"`, start the bridge locally with `DDA_LAB_DB=x.db`, log in. Write the date in `PROJECT.md`.
- **Acceptance:** object appears in Spaces next morning; healthchecks.io shows green; one documented successful restore.

### B7. Uptime + error alerting — 2 h
- **Why:** today an outage is noticed only when someone complains.
- **Steps:**
  - Make `/health` answer HEAD: `@app.api_route("/health", methods=["GET","HEAD"])`; add a DB ping (`select 1`) and return 503 on failure.
  - UptimeRobot (free, 5-min): `GET https://motoracelaps.com/health` (keyword `"ok":true`), `https://motoracelaps.com/` and `https://motoracelaps.com/lab/`, `https://dda.kitchenonstage.com/health`; SSL-expiry alert (UptimeRobot includes it). Alert to e-mail + phone app.
  - Sentry free tier: `sentry-sdk[fastapi]` in `requirements-lab.txt` (DSN from env, `send_default_pii=False`, `traces_sample_rate=0`); `@sentry/react` in `dda_lab` with release = git SHA, upload source maps in CI only. Scrub e-mails in `before_send`.
  - Healthchecks.io for the backup job (B6).
- **Acceptance:** `systemctl stop dda-lab` on staging → alert within 10 min; a thrown test error appears in Sentry with readable stack.

### B8. Structured logs + logrotate — 1 h
- **Steps:** uvicorn `--no-access-log` (nginx already logs access) + Python `logging` JSON-ish one-liners (`ts level route status ms user_id`); `/etc/systemd/journald.conf`: `SystemMaxUse=200M`; nginx log format with `$request_time $upstream_response_time`; confirm `/etc/logrotate.d/nginx` is `daily rotate 14 compress`.
- **Acceptance:** `journalctl --disk-usage` < 200 MB; `df -h /` alert threshold documented (UptimeRobot can't see disk → add a cron that pings healthchecks only if `df` < 85 %).

### B9. Resource limits and droplet upgrade path — 1.5 h
- **Why:** 512 MB hosts nginx + cloudflared + uvicorn + KOS site; `pip install` during deploy and Sentry SDK add memory; OOM kill = downtime.
- **Steps:**
  1. Now: add 1 GB swapfile (`fallocate -l 1G /swapfile && chmod 600 … && mkswap && swapon`, `vm.swappiness=10`), `MemoryHigh=180M MemoryMax=250M` + `Restart=always RestartSec=2` in the unit, `--workers 1`.
  2. At launch: **resize to Basic 1 GB ($6/mo)** — CPU+RAM resize only (keeps disk, reversible), ~1 min downtime: `doctl compute droplet-action power-off <id> && doctl compute droplet-action resize <id> --size s-1vcpu-1gb && … power-on`.
  3. Trigger for 2 GB ($12): p95 RSS > 70 % for a week, or > 300 WAU. Trigger for splitting KOS site off: either project needs a different deploy cadence.
  4. Stop doing `pip install` on every deploy: only when `requirements-lab.txt` hash changed.
- **Acceptance:** `free -m` shows swap; `systemctl show dda-lab -p MemoryMax`; a load test (`hey -n 2000 -c 20 https://dda.kitchenonstage.com/health`) keeps RSS < 150 MB.

### B10. CI with GitHub Actions — 3 h
- **Why:** 3 failing tests on main right now prove the need.
- **Steps:** first fix or `it.skip` (with an issue) the 3 sim calibration tests. Then `.github/workflows/ci.yml`:
  ```yaml
  on: { pull_request: {}, push: { branches: [main] } }
  jobs:
    web:
      runs-on: ubuntu-latest
      defaults: { run: { working-directory: dda_lab } }
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: 22, cache: npm, cache-dependency-path: dda_lab/package-lock.json }
        - run: npm ci && npm run typecheck && npm test && npm run build
        - run: npx playwright install --with-deps chromium && npm run e2e
    py:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-python@v5
          with: { python-version: "3.11" }
        - run: pip install -r requirements-lab.txt pytest && pytest -q tests/test_bridge.py
  ```
  Deploy job (`needs: [web, py]`, `if: github.ref == 'refs/heads/main'`, `environment: production` with manual approval): SSH key in repo secret `DEPLOY_SSH_KEY` (a dedicated `deploy` user, not root, with `sudo systemctl restart dda-lab` only), runs the same steps as `deploy_lab.sh`. Branch protection on `main`: require CI green.
- **Acceptance:** a PR shows 2 green checks; a deliberately broken test blocks merge.

### B11. Real staging on dda.kitchenonstage.com — 2 h
- **Steps:** second unit `dda-lab-staging` (port 8778, `/opt/dda-lab-staging`, own `dda_lab.db`, own env file with a separate Google OAuth redirect URI and `APP_URL=https://dda.kitchenonstage.com`); nginx `server_name dda.kitchenonstage.com` → 8778; `X-Robots-Tag: noindex`; `deploy_lab.sh --staging` flag. Flow: merge → deploy staging → smoke → promote prod.
- **Acceptance:** creating a user on staging doesn't appear in prod DB; `curl -sI https://dda.kitchenonstage.com | grep -i x-robots`.

### B12. Legal pages, consent, deletion path — 4 h
- **Why:** Google login stores e-mail/name/avatar = personal data (GDPR for EU riders, KVKK for Turkey); usage stats with `anon_id` is tracking.
- **Steps:**
  - `site/privacy.html`: controller (Eren, contact e-mail), what is stored (`users`, `usage_events`, corridors, schema images), what is NOT (DDA/CSV/video files never leave the browser), legal basis (contract for account; legitimate interest or consent for stats), processors (DigitalOcean fra1, Google, Resend, Sentry, Cloudflare for staging), retention (events 13 months, OTP rows deleted on use/expiry, backups 30 days), rights + how to exercise them.
  - `site/terms.html`: free beta, no warranty, "not for on-track safety decisions", user content licence for shared track models, not affiliated with Ducati/BMW/RaceChrono.
  - Cookie note: only strictly necessary cookies (`session`, OAuth `state`) → no banner needed for them; for usage stats either (a) cookieless + first-party + aggregated (no banner, disclose in policy) or (b) a one-line opt-in toast in the app storing choice in `localStorage`. Recommend (a) and make `anon_id` a random per-browser id with no fingerprinting; honour `navigator.doNotTrack`/GPC.
  - Footer links on landing + `/lab/` login page; add both pages to `sitemap.xml`.
  - Deletion: `DELETE /api/auth/me` (deletes user row, nulls `usage_events.user_id`, bumps session_version) + "Delete my account" in the account menu; fallback e-mail `privacy@motoracelaps.com` (forward via GoDaddy/ImprovMX), 30-day SLA, logged in a private sheet.
  - Export: `GET /api/auth/me/export` (JSON of the user row + own events) — 1 h, cheap to do now.
- **Acceptance:** pages live and linked; pytest: delete endpoint removes user and keeps aggregate counts; a real account deletion run on staging.

**Blocker total ≈ 26 h** (Phase 1 = B1–B9 ≈ 17 h, Phase 2 = B10–B12 ≈ 9 h + buffer).

---

## 4. Nice-to-have before the marketing push (Phase 3, ≈ 14 h)

| # | Item | Steps | Acceptance | h |
|---|---|---|---|---|
| N1 | Bundle + Lighthouse budget | `manualChunks` in `vite.config.ts` (maplibre, uplot, sim/* lazy via `import()`), brotli via `ngx_brotli` or pre-compressed `vite-plugin-compression` + `gzip_static on` | Lighthouse mobile: landing ≥ 95 perf, `/lab/` ≥ 70; main chunk < 600 KB raw; LCP < 2.5 s | 3 |
| N2 | Lighthouse CI | `treosh/lighthouse-ci-action` on PR against staging with `budget.json` | PR fails if budget exceeded | 1 |
| N3 | OG image | 1200×630 `site/img/og.jpg` (logo + map + lap delta), update `og:image`, add `og:image:width/height` | opengraph.xyz preview correct on X/WhatsApp/LinkedIn | 1 |
| N4 | Error boundary UX | React `ErrorBoundary` around panels + root: "Something broke — reload / report" with Sentry event id; worker error toasts | Throwing in a panel keeps the rest of the app alive | 2 |
| N5 | Feedback link | "Feedback" in header → `mailto:` or a Tally form; include app version + browser | Test submission received | 0.5 |
| N6 | Status page | UptimeRobot public status page at `status.motoracelaps.com` (CNAME) | Page shows monitors | 0.5 |
| N7 | Analytics dashboard | Admin-only `/lab/#admin` view over `/api/stats/summary` (WAU, files opened, sim runs, retention cohort) | Numbers match a manual SQL query | 3 |
| N8 | Onboarding tour | 4-step tour on first visit: open example Serres lap → map → compare laps → Δ time; "skip" stored in `localStorage` | 3 test users finish it unaided | 2 |
| N9 | Docs/FAQ | `site/faq.html`: supported formats, "is my data uploaded?", DDA download, troubleshooting; update README for the web product | Linked from landing | 1 |

---

## 5. Operations

### 5.1 Release checklist (copy-paste into the PR / commit)

```markdown
## Release <version / SHA> — <date HH:MM>
- [ ] `git status` clean, branch up to date with origin/main
- [ ] CI green (typecheck, vitest, pytest, playwright)
- [ ] `cd dda_lab && npm run build` ok, main chunk size noted: ___ KB
- [ ] DB migrations are additive / idempotent (`CREATE ... IF NOT EXISTS`, no DROP)
- [ ] New env vars added to /etc/dda-lab/env on staging AND prod
- [ ] Deployed to staging (dda.kitchenonstage.com) at HH:MM
- [ ] Staging smoke: /health ok · landing loads · /lab/ loads · open Serres example · compare 2 laps · sim run · Google login · e-mail code login · logout
- [ ] Manual backup taken: `ssh kos-web /usr/local/bin/dda-backup.sh`
- [ ] Tag: `git tag lab-$(date +%Y%m%d-%H%M) && git push --tags`
- [ ] Deployed to prod at HH:MM; same smoke on motoracelaps.com
- [ ] Sentry: no new issues 30 min after deploy; UptimeRobot green
```

### 5.2 Rollback procedure (target < 5 min)

1. Keep the previous build on the server: change `deploy_lab.sh` to rsync into `/opt/dda-lab/releases/<sha>/` and flip a symlink `/opt/dda-lab/current` (nginx `root` and the unit's `WorkingDirectory` point at `current`). Keep last 5.
2. Rollback: `ssh root@159.89.97.78 'ln -sfn /opt/dda-lab/releases/<prev> /opt/dda-lab/current && systemctl restart dda-lab'`.
3. Until symlinks exist: `git checkout <last-good-tag> && ./deploy_lab.sh`.
4. DB: migrations are additive so code rollback is safe. If data is corrupted: stop service → restore last nightly from Spaces (§B6 drill) → start → announce on status page.
5. Landing site: `git checkout <tag> -- site && ./deploy_site.sh`.

### 5.3 Incident runbook

| Incident | Detect | Diagnose | Fix |
|---|---|---|---|
| **Service down** (5xx / timeout) | UptimeRobot `/health` alert | `ssh` → `systemctl status dda-lab`, `journalctl -u dda-lab -n 200`, `dmesg -T \| grep -i oom`, `free -m` | `systemctl restart dda-lab`; if OOM → raise MemoryMax / resize droplet (B9); if bad deploy → rollback §5.2; if nginx → `nginx -t`, `systemctl restart nginx` |
| **Disk full** | disk cron ping missing / writes fail | `df -h`, `du -xh / --max-depth=2 \| sort -h \| tail`, `journalctl --disk-usage` | `journalctl --vacuum-size=100M`, delete `/var/backups/dda` > 3 days, old `releases/`, `apt clean`; expand volume if recurring |
| **Cert expiry** | UptimeRobot SSL alert (14 days before) | `certbot certificates`, `systemctl list-timers \| grep certbot`, port 80 reachable? | `certbot renew --dry-run` then `certbot renew && systemctl reload nginx`; GoDaddy A record still 159.89.97.78? |
| **OAuth broken** (login loops / `redirect_uri_mismatch`) | Sentry auth errors, user reports | Google Cloud console: client not deleted, redirect URI = `https://motoracelaps.com/api/auth/google/callback`, consent screen published (not "testing" → 100 user cap); `APP_URL` env; clock skew (`timedatectl`) | Fix URI / publish consent screen; e-mail code login remains as fallback; if `SESSION_SECRET` changed, all users must re-login (expected) |
| **E-mail codes not arriving** | support mail | Resend dashboard logs, domain SPF/DKIM status, daily quota (free = 100/day) | upgrade Resend plan or fall back to Google login; check spam placement |
| **Abuse / traffic spike** | nginx 429 rate, CPU | `tail -f /var/log/nginx/access.log`, `goaccess` | tighten `limit_req`, block IP in nginx `deny`, optionally put motoracelaps.com behind Cloudflare proxy (free) |

---

## 6. 30 / 60 / 90-day roadmap

| Window | Goals | Work |
|---|---|---|
| **Days 0–14** (Phase 1–2) | Safe to share publicly | B1–B12, fix 3 failing tests, CI on main |
| **Days 15–30** (soft launch) | 50 real riders, no data loss | Phase 3 N1–N5; post in 2–3 track-day / Ducati forums and Serres community; weekly restore drill until stable; read every Sentry issue |
| **Days 31–60** | Find the "aha" step | N6–N9; instrument funnel (visit → open file/example → compare → sim); interview 5 users; decide on account-required features (saved sessions, shared track models) |
| **Days 61–90** | Retention & growth | Second circuit pack (e.g. Istanbul Park), share-a-lap link, SEO pages per circuit; revisit hosting (2 GB or split KOS) if triggers hit; decide if a paid tier (cloud OCP solves) makes sense |

**Metrics to watch** (from `usage_events`; review weekly, Monday):

| Metric | Definition (SQL sketch on `usage_events`) | Day-30 target | Day-90 target |
|---|---|---|---|
| WAU | distinct `coalesce(user_id, anon_id)` with any event in last 7 days | 30 | 150 |
| Files opened / week | count `event='file_opened'` (props: type dda/csv/racechrono/video) | 60 | 400 |
| Example-lap opens | `event='example_opened'` — top-of-funnel for new visitors | — | track ratio vs file_opened |
| Sim usage | distinct users with `event in ('sim_run','fit_to_lap')` / WAU | 15 % | 25 % |
| Sign-up conversion | new `users` rows / distinct new anon_ids | 10 % | 20 % |
| Week-4 retention | % of a week's new users active in week 4 | 15 % | 25 % |
| Reliability | uptime (UptimeRobot), Sentry issues/week, p95 `/api` latency | ≥ 99.5 %, < 10 | ≥ 99.9 %, < 5 |

Event names must match what agent B implements in `bridge/stats.py` + `dda_lab/src/analytics/`; keep the vocabulary small and documented in the privacy policy.

---

## 7. Cost table (USD / month, approximate list prices)

| Item | Current | Recommended at launch | Notes |
|---|---|---|---|
| DigitalOcean droplet kos-web | $4 (512 MB) | $6 (1 GB) → $12 (2 GB) on trigger | Shared with KOS marketing site |
| DO droplet backups | $0 (off) | $1.20 (20 % of $6) | Weekly snapshot layer |
| DO Spaces (backups) | $0 | $5 | 250 GB + 1 TB egress included; far more than needed |
| Domain motoracelaps.com (GoDaddy) | ≈ $1.75 | ≈ $1.75 | ~$21/yr renewal; consider moving to Cloudflare Registrar (at-cost) |
| Let's Encrypt / Cloudflare tunnel | $0 | $0 | |
| E-mail sending (Resend) | $0 | $0 (3 000/mo, 100/day) → $20 if exceeded | Dedicated key + verified domain |
| Inbound e-mail (privacy@ / hello@) | $0 | $0 (ImprovMX/forwarding free) | |
| Uptime (UptimeRobot) + status page | $0 | $0 | Free: 50 monitors, 5-min interval |
| Error tracking (Sentry Developer) | $0 | $0 | 5k errors/mo; sample if exceeded |
| Backup dead-man (healthchecks.io) | $0 | $0 | 20 checks free |
| CI (GitHub Actions) | $0 | $0 | Public repo → unlimited minutes |
| **Total** | **≈ $5.75** | **≈ $13.95** (≈ $20 with 2 GB) | |

---

### Files relied on
`deploy_lab.sh`, `deploy_site.sh`, `dda_lab_bridge.py` (CORS ~L311, `/health` L320, corridors L395–470), `bridge/auth.py`, `bridge/db.py`, `bridge/stats.py`, `requirements-lab.txt`, `package_lab.py`, `dda_lab/package.json`, `dda_lab/tests/{unit,e2e}`, `tests/test_bridge.py`, `site/index.html`, `site/robots.txt`, `site/sitemap.xml`, `docs/DURUM.md`, `README.md`; live checks: `curl -I` on `/`, `/lab/`, `/health`, an asset, a CORS preflight, and `openssl s_client` (2026-10-16 10:08 UTC).
