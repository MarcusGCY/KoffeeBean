# BeanBox: SDLC automation demo (Cursor SDK)

A small coffee and merch store with **planted bugs**. Users report problems from the
store, and a pipeline triages them, asks a human to approve, then has Cursor fix them.

```
Report a problem widget
  -> POST /api/feedback
  -> Cursor agent writes a failing test, then triages: duplicate of an open issue?
       yes -> comment on the existing issue (merged)
       no  -> agent pushes one new tests/repro/*.test.ts file on a beanbox-triage branch
            -> server checks the commit adds only that file, then dispatches the main workflow
            -> workflow checks out main, copies that file at the pinned sha, runs vitest
                 failed assertion -> issue (user-feedback, awaiting-review)
                          body includes the test path, check link, and failure output
                 passes, no test, extra files, or a load error -> closed cannot-reproduce
                 still running -> same resume path as fixes (webhook, /api/fix-status, cron)
  -> review request sent to the Grok bot (GROK_WEBHOOK_URL, optional GROK_WEBHOOK_AUTH)
  -> human taps Approve  -> GET /api/review (signed link)
       -> Grok webhook `fix_started` (issue number, title, url)
       -> Cursor cloud agent copies that test, makes it pass, and opens a PR (autoCreatePR)
       -> the agent id and run id are saved on the GitHub issue
       -> locally, this process tracks the run until it finishes (up to 30 min)
       -> on Vercel, later requests finish tracking (see Deploy to Vercel)
       -> Grok webhook `fix_completed` (status, PR link, signed merge link, summary)
       -> issue gets a comment with the PR link
  -> human taps Merge fix -> GET /api/merge (signed link, valid 48 hours)
       -> merge check requires the reproduction test file on the PR
       -> draft PR is marked ready, then squash-merged
       -> issue is commented, labeled `merged`, and closed
       -> Grok webhook `fix_merged` (issue, PR, merge commit; Vercel redeploys main)
  -> human taps Reject   -> issue closed as wontfix
```

## Reproduce first

Triage is a cloud agent that can edit the repo. For a new report it adds one failing vitest file under `tests/repro/`, commits it, and pushes a branch whose name contains `beanbox-triage`. The pull request comes later, from the fix agent.

The server resolves that branch to a commit sha. The diff from `main` must be exactly one added `tests/repro/*.test.ts` file. Anything else, including `.github/`, `src/`, or `package.json`, is `cannot-reproduce`. The server then dispatches workflow `repro` on `main`, passing the test path and the sha. The workflow file that runs is the one on `main`. It checks out `main`, copies in only that file at the pinned sha, and runs vitest's JSON reporter with `permissions: contents: read` and no secrets. The untrusted test process does not receive `GITHUB_TOKEN`.

An `awaiting-review` issue is opened only when that report contains a failed assertion in the named file and no collection, import, or syntax error. The body names the test path and sha, links to the workflow run, and includes the failure output trimmed to 2000 characters. A passing test, a missing test, a load error, or no tests at all is a closed `cannot-reproduce` issue. Issue markers are HMAC-signed with `APPROVAL_SECRET` and written first, so text from the report cannot forge one.

If the run is still queued, the report is an open `repro-pending` issue. It resumes the same way a fix does: the `workflow_run` webhook, `POST /api/fix-status`, and the daily cron. After 30 minutes with no result, it is closed as `cannot-reproduce`.

The fix agent copies that same test onto its pull request and makes it pass, with the original assertions still there. Merge returns 409 when the file is missing, skipped (`.skip` or `.todo`), or not byte-for-byte the triage copy.

The app token needs **Actions: write** to dispatch the workflow and **Actions: read** to read the run log. No new environment variable. The workflow's own token is contents read only.

## Shop issues a customer can report

These show up in the store for a signed-in shopper. Report them separately so each one
becomes its own issue. `npm test` fails `product images` until the bean photos load;
cart and checkout tests still pass.

| What the shopper sees | Suggested feedback |
|---|---|
| Coffee bean photos are broken (Ethiopia Yirgacheffe, Colombia Huila, House Espresso). Merch photos load. | The coffee bean pictures are broken. The mug, tote, and shirt photos look fine. |
| Add to cart does nothing for the Canvas Tote Bag. The mug, the shirt, and the coffees still get added. | Add to cart doesn't work for the Canvas Tote Bag. I can add the mug and the coffees. |
| Roast Day T-Shirt is listed at $250.00. Adding it makes the cart total $270.00 with tax. | The Roast Day T-Shirt shows $250. That should be about $25, like the other merch. |

Add more by editing `src/lib`, for example a tax or rounding bug. Keep each fix small and
covered by a test.

## Setup

1. Push this project to a **new GitHub repo** and install the Cursor GitHub app on it.
2. Create an Auth0 app (see below) and `cp .env.example .env.local`. Fill in both the
   Cursor/GitHub values and the Auth0 values.
3. `npm run dev`. To let the Grok bot call back to your machine, expose it with ngrok and
   set `APP_URL` (and the matching Auth0 callback URLs if you leave localhost).
4. If the bot is not ready yet, open `/review/<issue number>` to approve or reject by hand.
   That page stays open on purpose: the link is already signed, and the Grok bot does not
   have an Auth0 session.

## Auth0 login

Shoppers sign in before they can see the catalog, use the cart, or send feedback. This app
uses `@auth0/nextjs-auth0` v4. `src/proxy.ts` mounts the SDK routes:

- `GET /auth/login` — start login
- `GET /auth/logout` — end the session
- `GET /auth/callback` — Auth0 redirects here after login

Feedback issues include the reporter's Auth0 user id and email when a session is present.
`POST /api/feedback` rejects anonymous callers. Each signed-in shopper can file 20 reports per hour;
the count is read from recent GitHub issue bodies and comments, so it holds across serverless instances.

### Create the Auth0 application

1. In the [Auth0 dashboard](https://manage.auth0.com), create an application of type
   **Regular Web Application** (not SPA or Machine to Machine).
2. Open the app's **Settings** and set, for local dev:

   | Field | Value |
   |---|---|
   | Allowed Callback URLs | `http://localhost:3000/auth/callback` |
   | Allowed Logout URLs | `http://localhost:3000` |
   | Allowed Web Origins | `http://localhost:3000` |

   Add the same three URLs for any public origin you actually use (ngrok or production),
   for example `https://your-host.example/auth/callback` and `https://your-host.example`.
3. Copy **Domain**, **Client ID**, and **Client Secret** into `.env.local`.

### Environment variables

| Variable | Purpose |
|---|---|
| `AUTH0_DOMAIN` | Tenant domain only, such as `your-tenant.us.auth0.com` |
| `AUTH0_CLIENT_ID` | Regular Web Application client ID |
| `AUTH0_CLIENT_SECRET` | That application's client secret |
| `AUTH0_SECRET` | Key that encrypts the session cookie. `openssl rand -hex 32` |
| `APP_BASE_URL` | Origin of this Next app, `http://localhost:3000` locally |
| `AUTH0_ROLES_CLAIM` | Optional. ID token claim that lists Auth0 role names. Leave unset to use `https://beanbox/roles` |

`APP_BASE_URL` is the Auth0 SDK v4 name. `APP_URL` is separate: it is the origin baked into
approve/reject links. Set both to the same origin for local dev. On Vercel either may be unset;
preview deployments then use `https://$VERCEL_URL`, and production uses
`https://$VERCEL_PROJECT_PRODUCTION_URL` (then `https://$VERCEL_URL`). v3 names
(`AUTH0_ISSUER_BASE_URL`, `AUTH0_BASE_URL`) are not read by this SDK.

`next build` does not need these values. Login works after `.env.local` is filled and the
dev server is restarted.

### Admin role

`/admin/demo`, `POST /api/demo/revert`, `POST /api/demo/reset`, and the header **Demo** link are
for a signed-in user whose Auth0 role list contains `admin`. A signed-out visitor, a user
without that role, and a user whose email Auth0 has marked unverified (`email_verified` is
`false`) get 404. Signed revert and reset grants still authorize those two POSTs without a
session. The browser forms still send a CSRF token signed with `APPROVAL_SECRET` and tied to
the Auth0 user id, and the routes still reject a cross-site `Origin`.

The app reads roles from one namespaced ID token claim, `https://beanbox/roles` by default.
Set `AUTH0_ROLES_CLAIM` only when the Action below writes a different claim. The value may be
an array of role names or a single role string. Auth0 v4 does not keep custom ID token claims
on `session.user` unless the app copies them in `beforeSessionSaved`; this app keeps that one
claim and drops the rest.

Do this once in the Auth0 dashboard for tenant `koffeebean.jp.auth0.com`:

1. **Create the role.** User Management → Roles → Create Role. Name it `admin`. Description can
   be anything. Create.
2. **Assign it.** Open the `admin` role → Users → Add Users, and add the owner. The same
   assignment is under User Management → Users → that user → Roles → Assign Role → `admin`.
3. **Create the Action.** Actions → Library → Create Action → Build from scratch. Name it
   `Add roles to tokens`. Trigger: **Login / Post Login**. Replace the sample with this code,
   then **Deploy** (Deploy, not only Save):

```javascript
/**
 * @param {Event} event - Details about the user and the context in which they are logging in.
 * @param {PostLoginAPI} api - Interface whose methods can be used to change the behavior of the login.
 */
exports.onExecutePostLogin = async (event, api) => {
  const claim = "https://beanbox/roles";
  if (event.authorization) {
    api.idToken.setCustomClaim(claim, event.authorization.roles);
    api.accessToken.setCustomClaim(claim, event.authorization.roles);
  }
};
```

4. **Add it to the Login flow.** Actions → Triggers → **post-login** (also listed under Flows).
   Drag `Add roles to tokens` into the flow between Start and Complete, then **Apply**.
5. **Log out of BeanBox and log in again.** The claim is written at login. A session that
   already exists does not pick it up.

Delete `ADMIN_EMAILS` from Vercel and from `.env.local` if it is still set. No new Vercel
variable is required. Add `AUTH0_ROLES_CLAIM` only if the Action uses a claim other than
`https://beanbox/roles`, and use that same name in the Action and in Vercel.

## Repeat the demo

After a fix is merged, Vercel redeploys main and that bug is gone. To run the same report again, sign in as a user with the Auth0 role `admin` and open `/admin/demo`. A signed-out visitor or any account without that role gets 404.

| State | What it means |
|---|---|
| Not merged | A Cursor pull request exists and is not on main yet. Revert stays disabled. |
| Merged | The squash merge is on main. **Revert** is available. |
| Merged · deploying | The merge is on main and this deployment does not include it yet. |
| Reverted | A later commit put the bug back. |
| Reverted · deploying | The revert commit is on main and Vercel has not finished redeploying it. The page refreshes while main is ahead of this deployment. |

**Revert** commits the inverse of that squash merge straight to `main` through the Git Data API. It does not open a pull request. Later commits can stay, as long as they did not edit the same lines. If they did, the page shows the file and commits nothing.

The linked feedback issue is then closed and labeled `demo-reverted`, so triage will not merge the next report into it.

**Reset all demo bugs** re-applies the three planted bugs from `5cb6889` (`src/lib/images.ts`, `src/lib/cart.ts`, `src/data/products.json`). A file that already has its bug is skipped. A file that matches neither the planted bug nor the pre-bug line is left untouched and nothing is committed. Merged fixes that this fully undoes are closed and labeled the same way.

Both actions are POST. The browser form sends a CSRF token signed with `APPROVAL_SECRET` and tied to the Auth0 user id, and the route rejects a cross-site `Origin`. Signed-out visitors, users without the `admin` role, and Auth0 users whose email is explicitly unverified get 404.

Optional, for a later Feedback Bot button: `POST /api/demo/revert?pr=<n>&token=<grant>` and `POST /api/demo/reset?token=<grant>`. The grant is an HMAC of `APPROVAL_SECRET` (the same secret as approve/reject links) and expires after 24 hours. The owner page can show a revert URL. These URLs are not added to `review_request`, `fix_started`, or `fix_completed`.

Revert itself needs **Contents** read/write (to commit on `main`) and **Issues** read/write (to close and label the feedback issue). It does not need Pull requests write. If the token cannot read pull requests, merged fixes are still found from squash-merge subjects like `(#23)` on `main`. Squash-merging the fix from the bot also needs Pull requests read/write. See [Grok webhook](#grok-webhook).

## Demo script

1. Log in and open the store.
2. Click **Report a problem** and send one of the feedback lines in the table above.
3. If the reproduction check fails, triage opens a GitHub issue and the Feedback Bot asks for review. Tap **Approve**.
4. Watch the bot for fix status (`fix_started`, then `fix_completed` with the PR). The GitHub issue gets a comment too.
5. When the bot shows **Merge fix**, tap it. Refresh the store after Vercel redeploys. Repeat with the other two reports; each one is a separate fix.

## Grok webhook

`POST GROK_WEBHOOK_URL` with the same `GROK_WEBHOOK_AUTH` handling on every call.

| `type` | When | Body |
|---|---|---|
| `review_request` | A new issue needs a human | `{ type, issue:{number,title,url}, summary, actions:[{id,label,url}] }` |
| `fix_started` | Approve kicks off `fixIssue` | `{ type, issue:{number,title,url} }` |
| `fix_completed` | The Cursor run reaches a terminal status | `{ type, issue:{number,title,url}, status, prUrl?, prNumber?, mergeUrl?, summary }` |
| `fix_merged` | The signed merge link squash-merges that PR | `{ type, issue:{number,title,url}, prNumber, prUrl, sha, summary }` |

`summary` on `fix_completed` is the human-readable GitHub issue comment (PR link, or the run status when no PR opened). A hidden HTML marker on that comment is not part of the payload. `prUrl` is omitted when there is no PR. `prNumber` and `mergeUrl` are omitted in that same case, and also when `prUrl` is not a pull request in `GITHUB_REPO`. The original `fix_completed` fields are unchanged, so an older bot can ignore `prNumber` and `mergeUrl`. A failed POST is logged and does not stop the fix. If `GROK_WEBHOOK_URL` is empty, BeanBox logs the `/review/<n>` page for review requests and skips the fix pings.

The bot shows the review summary with Approve and Reject buttons. Each button calls that action's `url`.

### Merge fix button

When `fix_completed` includes `mergeUrl`, show a **Merge fix** button that opens that URL (a GET, same as Approve). The issue number is `issue.number`. Example:

```json
{
  "type": "fix_completed",
  "issue": { "number": 12, "title": "Bean images not loading", "url": "https://github.com/org/beanbox/issues/12" },
  "status": "finished",
  "prUrl": "https://github.com/org/beanbox/pull/34",
  "prNumber": 34,
  "mergeUrl": "https://koffee-bean.vercel.app/api/merge?issue=12&pr=34&token=1710000000000.abcdef",
  "summary": "Cursor opened a fix: https://github.com/org/beanbox/pull/34"
}
```

`mergeUrl` is `/api/merge?issue=<n>&pr=<n>&token=<exp>.<hmac>`. The HMAC is SHA-256 of `merge:<issue>:<pr>:<exp>` with `APPROVAL_SECRET` (the same secret as approve/reject). `exp` is a unix millisecond timestamp 48 hours after the link is signed. The link is bound to that issue and that pull request.

`GET /api/merge` checks the signature, then checks that the pull request is open in `GITHUB_REPO`, that the issue's fix-result comment recorded that pull request (and the head branch, when the Cursor run reported one), and that GitHub reports it mergeable. A draft is marked ready with the GraphQL mutation `markPullRequestReadyForReview`, then squash-merged. The issue gets a comment, the `merged` label, and is closed. The response is JSON, like `/api/review`:

| Result | HTTP | Body |
|---|---|---|
| Squash-merged | 200 | `{ status: "merged", message, issue, prNumber, prUrl, sha }` |
| Already merged | 200 | `{ status: "already-merged", message, issue, prNumber, prUrl, sha? }` |
| Bad or expired link | 403 | `{ error }` |

`message` is a short sentence. An already-merged pull request is not an error. Opening the link again does not post a second `fix_merged`.

After a squash merge that this request performed (or the first time the issue is closed for an already-merged pull request), BeanBox posts `fix_merged`:

```json
{
  "type": "fix_merged",
  "issue": { "number": 12, "title": "Bean images not loading", "url": "https://github.com/org/beanbox/issues/12" },
  "prNumber": 34,
  "prUrl": "https://github.com/org/beanbox/pull/34",
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "summary": "Squash-merged pull request #34. Vercel will redeploy main shortly."
}
```

`sha` is the squash-merge commit. `summary` tells the bot that Vercel will redeploy `main` shortly. A failed `fix_merged` POST is logged and does not roll back the merge.

Marking a draft ready has no REST field (a PATCH that sets `draft: false` is ignored). BeanBox calls GraphQL `markPullRequestReadyForReview` with the pull request node id. GitHub's GraphQL guide says a fine-grained personal access token can call that API when it has **Pull requests: write** on the repository. This repo cannot call GitHub as the owner, so the route treats a rejected mutation as a failed merge: HTTP 403, the pull request stays a draft, and `error` tells the owner to add Pull requests: write. The token that can merge needs the first three. Reproduction checks also need Checks: read.

| Fine-grained permission | Used for |
|---|---|
| Contents read/write | Squash-merge commit on `main`, and demo revert |
| Pull requests read/write | Read the fix PR, squash-merge it, and `markPullRequestReadyForReview` |
| Issues read/write | Comment, close, and label the feedback issue |
| Actions read and write | Dispatch the reproduction workflow on `main` and read its log |

| Variable | Purpose |
|---|---|
| `GROK_WEBHOOK_URL` | Feedback Bot webhook URL. If empty, BeanBox logs the `/review/<n>` page and does not POST. |
| `GROK_WEBHOOK_AUTH` | Optional. Value may be `Bearer …` or the full `Authorization: Bearer …` line from the panel. Leave unset for an open webhook. |

In the Feedback Bot routine panel, copy the webhook URL into `GROK_WEBHOOK_URL` and the Authorization header field into `GROK_WEBHOOK_AUTH` in `.env.local`. Include the `Bearer ` prefix when the panel shows it. Restart `npm run dev` after changing either value.

## Server cart and orders

Signed-in shoppers keep a cart and orders in Auth0 `app_metadata` (never `user_metadata`). Prices, names, and coupon checks come from `src/data/products.json` and `src/lib/coupons.ts`. Totals use the same math as the shop, including the planted demo bugs in `src/lib/cart.ts`. Quantity is checked in code and must be an integer from 1 to 99.

Auth0 merges only top-level keys. A patch sends the full value of each key it changes (`cart`, `orders`, `chat_limits`, `audit`) and leaves the other keys alone. Two requests that patch the same key are last-write-wins. That can drop a cart line or a quota stamp. Orders keep the newest 20. Audit keeps the newest 50 entries (`ts`, `tool`, `summary`, `outcome`).

The Management API uses a separate machine-to-machine application (not the Regular Web Application used for login). In the Auth0 dashboard, create an application of type **Machine to Machine**, authorize the **Auth0 Management API**, and grant `read:users` and `update:users_app_metadata`. `read:users_app_metadata` does not authorize `GET /api/v2/users/{id}` (Auth0 expects `read:users` for that call). `update:users_app_metadata` is enough for a patch that sends only `app_metadata`. The token request asks for those two scopes, and the GET asks for `fields=app_metadata` only. Copy the client id and secret into `AUTH0_MGMT_CLIENT_ID` and `AUTH0_MGMT_CLIENT_SECRET`. The audience is `https://<AUTH0_DOMAIN>/api/v2/`. If those values are missing, cart routes return 503 and the shop shows a short notice.

Cart and order write quotas stay on the `chat_limits` key: 30 cart writes an hour and 10 order writes an hour. Chat message quotas are separate: 20 an hour and 60 a day, counted with an atomic Upstash Redis `INCR` and `EXPIRE` before the xAI call. A shopper who passes a limit gets HTTP 429 and a short message. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from the Upstash console (free tier, REST only, no SDK). If Redis is missing, chat returns 503.

## Support chat

Signed-in shoppers get a **Support** button at the bottom left of the shop. Report a problem stays at the bottom right. `POST /api/chat` streams Server-Sent Events from xAI chat completions (`https://api.x.ai/v1/chat/completions`) with function calling. The model is `XAI_MODEL`, or `grok-4.20-0309-non-reasoning` when that is unset. `XAI_API_KEY` stays on the server and is never logged.

Tools are `search_products`, `get_cart`, `get_order`, `propose_cart_change`, and `reorder`. The shopper id comes from the Auth0 session, never from tool arguments. Product cards are built from the catalog by id. `propose_cart_change` and `reorder` only return a pending action signed with `APPROVAL_SECRET`. Nothing is written until the shopper presses **Confirm**, which calls `POST /api/chat/confirm`. Add on a product card calls the cart API directly. A coupon is applied only when that code appears in a message the shopper typed in this chat. The bot does not list, reveal, or guess codes. Prices come from the catalogue. A short click-through is in `docs/demo.md`.

The route allows 60 seconds. The turn stops at 45 seconds and the stream says the chat timed out. A status event is sent immediately, and a heartbeat comment every 10 seconds, so a phone browser does not treat the request as silent. Each shopper can send 20 messages an hour and 60 a day. Those counts live in Upstash, not in Auth0. If `XAI_API_KEY` or `APPROVAL_SECRET` is missing, the bubble says support chat is unavailable.

`CURSOR_API_KEY` is still required for triage and fixes. It is not used by support chat. Chats are processed by xAI. Customers should not share personal details.

## Deploy to Vercel

Production deploys from `main` through the Vercel GitHub integration. The app is a Next.js App Router
project (`npm run build`). Set the Node.js version to 22.x (also declared in `package.json` `engines`).
`@cursor/sdk` stays in `serverExternalPackages` so triage and fix calls load it with Node rather than bundling it. Support chat does not start a child process.

Vercel kills work inside `after()` when the function hits `maxDuration`. These routes export
`maxDuration = 300`, the Hobby ceiling with Fluid compute. Triage and a fast fix can finish in that
window. A fix that runs longer does not: the approve handler saves `agentId`, `runId`, and `startedAt`
on the GitHub issue (HTML comment plus the `cursor-fixing` label) and returns. Tracking then continues
from whichever of these runs next:

1. When `CRON_SECRET` is set, the deployment calls `POST /api/fix-status?issue=N` for another slice, up to 30 minutes total.
2. `POST /api/github/webhook` on `pull_request` (`opened`, `synchronize`, `reopened`, `closed`) resumes
   the issue named in the PR (`Fixes #N`) or linked from the cloud agent's `beanboxIssue` metadata.
   The same route on `workflow_run` `completed` for `.github/workflows/repro.yml` resumes a `repro-pending` report.
3. Vercel Cron `GET /api/fix-status` once a day (`0 12 * * *` in `vercel.json`) picks up a run whose
   earlier slice never chained, including a reproduction check that is still pending. Hobby cron cannot run more often than that; it is only the backstop.

`fix_started` is unchanged. `fix_completed` keeps its existing fields and adds `prNumber` and `mergeUrl` when a pull request in this repo was opened. `npm run dev` still tracks the run
in-process and does not need the webhook or cron.

### Environment variables

Set these in the Vercel project. Scope `APP_URL` and `APP_BASE_URL` to **Production** only so preview
deployments fall back to that deployment's `VERCEL_URL`. Do not set `VERCEL_URL`, `VERCEL_ENV`, or
`VERCEL_PROJECT_PRODUCTION_URL`; Vercel provides them.

| Variable | On Vercel |
|---|---|
| `CURSOR_API_KEY` | Same value as local. Used by triage and fixes, not by support chat. |
| `XAI_API_KEY` | Server-only key for support chat. Never expose it to the browser. |
| `XAI_MODEL` | Optional. Defaults to `grok-4.20-0309-non-reasoning`. |
| `GITHUB_REPO` | Same `owner/name` |
| `GITHUB_TOKEN` | Same token. Fine-grained PAT: **Contents** read/write, **Pull requests** read/write, **Issues** read/write, **Actions** read and write. No new variable. Actions write dispatches the reproduction workflow on `main`. Actions read fetches its log. Pull requests write squash-merges the fix and is required for GraphQL `markPullRequestReadyForReview`. Contents write also commits demo reverts. Issues write comments, closes, and labels. |
| `AUTH0_ROLES_CLAIM` | Leave unset. Delete `ADMIN_EMAILS` if a previous deploy set it. Set this only to override `https://beanbox/roles` |
| `APPROVAL_SECRET` | Same signing secret (or a new one; old approve links would stop matching) |
| `APP_URL` | **Change** to the production origin, `https://<production-host>` (no trailing slash) |
| `APP_BASE_URL` | **Change** to that same production origin |
| `GROK_WEBHOOK_URL` | Same Feedback Bot URL |
| `GROK_WEBHOOK_AUTH` | Same value, if the bot requires it |
| `AUTH0_DOMAIN` | Same tenant domain |
| `AUTH0_CLIENT_ID` | Same Regular Web Application client id |
| `AUTH0_CLIENT_SECRET` | Same client secret |
| `AUTH0_SECRET` | Same session secret (or a newly generated 32-byte hex) |
| `GITHUB_WEBHOOK_SECRET` | **New.** Random string. The GitHub webhook secret below |
| `CRON_SECRET` | **New.** Random string. Vercel sends it as `Authorization: Bearer <CRON_SECRET>` on the cron, and the app uses it to chain fix tracking |
| `AUTH0_MGMT_CLIENT_ID` | Machine-to-machine client id for Auth0 `app_metadata` (cart, orders, chat limits, audit). Leave it empty in git |
| `AUTH0_MGMT_CLIENT_SECRET` | Machine-to-machine client secret. Scopes `read:users` and `update:users_app_metadata`. Leave it empty in git |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL for chat quotas and one-time confirm actions. Leave it empty in git |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token. Leave it empty in git |
| `DATABASE_URL` | Optional. Neon Postgres connection string for the BI event log (see below). Leave it empty in git |
| `BI_HASH_SECRET` | Optional. 16+ character secret that keys the shopper hash for BI events. Leave it empty in git |
| `BI_API_SECRET` | Optional. Service token for the read-only `/api/bi/*` endpoints (see "BI read API"). Leave it empty in git |

### BI event log (Neon Postgres)

Foundation for the Barista to BI work. Neon holds **analytics only**: Auth0 stays the source of truth for carts and orders, and Upstash Redis stays the chat quota store. Events are emitted from `src/lib/bi-track.ts` (see "Emission points" below).

1. Set `DATABASE_URL` to the pooled Neon connection string (`sslmode=require`) in `.env.local` and the Vercel project (mark it sensitive). The Neon project is KoffeeBean-BI (`proud-glitter-89179522`, `aws-ap-southeast-1`, branch `main`, database `koffeebean_bi`). No other connection variable name is used.
2. Generate `BI_HASH_SECRET` with `openssl rand -hex 32` and set it the same way. Keep it stable: changing it breaks joins with older rows.
3. The tables already exist on that branch. For a new branch or database, create them once: `psql "$DATABASE_URL" -f db/migrations/0001_bi_events.sql` (idempotent).

Tables: `bi_events` (append-only by convention; `id`, `created_at`, `event_type`, `source`, `shopper_hash`, `session_id`, `payload` jsonb) and an optional `bi_orders` mirror for cross-shopper order aggregates (`items` jsonb and `attributed_sku_ids` text[]; no writer yet).

- Every event has `source` of `live` or `demo`. BI queries should exclude `demo`.
- `shopper_hash` comes from `hashShopperId(sub)` in `src/lib/bi-hash.ts`: HMAC-SHA256 of the Auth0 `sub`, keyed by `BI_HASH_SECRET`, as 64 hex characters. The raw `sub` is never stored.
- No PII and no chat text. `src/lib/bi-events.ts` defines strict payload shapes for `barista.turn`, `recommend.shown`, `recommend.added`, `recommend.undone`, `order.placed`, and `order.cancelled`; unknown fields are rejected.
- `recordBiEvent(...)` never throws. With `DATABASE_URL` or `BI_HASH_SECRET` unset, or if Neon is down or slow (2 second cap), it logs a short code and returns `{ ok: false }`, so checkout and chat are not affected.
- BI is a separate path from `/api/feedback`, triage, and review. It does not call them.

Emission points (all best effort, run after the response when possible):

- `POST /api/chat`: `barista.turn` at turn end (tool ids, message length, latency; no text) and `recommend.shown` when cards were shown. The `products` SSE event carries the turn's `recommendationId`.
- `POST` / `DELETE /api/cart/items` with a `recommendationId` (sent only by chat cards): `recommend.added` / `recommend.undone`. Adding marks the SKU in Redis for 30 minutes (`kb:bi:rec:<sub>:<productId>`).
- `placeOrder` in `src/lib/store-meta.ts` (cart page and chat Confirm): `order.placed` plus a `bi_orders` upsert; `attributed_sku_ids` is the order's SKUs that are still marked.
- `cancelOrder` in `src/lib/store-meta.ts`: `order.cancelled` plus `bi_orders.cancelled_at`.
- `source` is `demo` when the signed-in user has the Auth0 `admin` role (the check behind `/admin/demo` and Demo Reset), otherwise `live`.

### BI read API (for the BI bot)

Read-only, service-token endpoints over `bi_events` for the Marcus-facing BI bot. This is a separate path from `/api/feedback`, triage, and review, and it never calls them. It does not use the Auth0 shopper session.

**Auth.** Set `BI_API_SECRET` (generate with `openssl rand -hex 32`) in `.env.local` and the Vercel project (mark it sensitive), and give the same value to the BI bot. Send it as `Authorization: Bearer <BI_API_SECRET>`, or as `x-bi-secret: <BI_API_SECRET>`. A missing or wrong secret is `401`. If `BI_API_SECRET` is unset on the server the endpoints answer `503 unconfigured` (they never open up). If `DATABASE_URL` is unset they answer `503 database_unconfigured`; a Neon failure is `503 unavailable`. Responses are `private, no-store`. Bad query parameters are `400 { "error": "..." }`.

**Privacy.** Rows are returned with `shopper_hash` only. The Auth0 `sub` and chat text are never stored in `bi_events`, so they cannot be returned.

**Source.** Every query excludes demo and admin traffic by default (`source=live`). Pass `source=demo` for only demo rows, or `source=all` for both.

`GET /api/bi/events` lists events, newest first.

| Param | Meaning |
| --- | --- |
| `since`, `until` | ISO 8601 window on `created_at`. `since` is inclusive, `until` is exclusive. Both optional |
| `event_type` | Optional. One of `barista.turn`, `recommend.shown`, `recommend.added`, `recommend.undone`, `order.placed`, `order.cancelled`. Repeat it or comma-separate |
| `source` | `live` (default), `demo`, or `all` |
| `limit` | Default 50, capped at 200 |
| `cursor` (alias `after_id`) | The `nextCursor` of the previous page |

Response: `{ "events": [{ "id", "created_at", "event_type", "source", "shopper_hash", "session_id", "payload" }], "nextCursor"? }`. `id` is a string. `nextCursor` is present only when more rows exist; pass it back as `cursor`.

`GET /api/bi/summary` returns small aggregates for a window. `since` and `until` default to the last 7 days ending now, and `source` defaults to `live`.

- `orders`: `placed` and `cancelled` event counts, `revenueCents` (sum of `order.placed` totals), `aovCents` (revenue / placed, `null` when none; cancelled orders are not netted out), `withCoupon`.
- `topSkus`: top 10 by ordered quantity, `{ productId, qty, orders }`.
- `coupons`: top 10 coupon codes by orders, `{ code, orders }`.
- `recommendations`: `shown`, `added`, `undone` event counts, `shownRecommendations` and `addedRecommendations` (distinct `recommendationId`s), and `conversion` (`addedRecommendations / shownRecommendations`, `null` when nothing was shown).
- `baristaTurns`: `total` and `byOutcome` (`replied`, `rate_limited`, `timeout`, `error`).

```bash
export BI_BASE_URL="https://<production-host>"
export BI_API_SECRET="<your BI_API_SECRET>"

curl -s -H "Authorization: Bearer $BI_API_SECRET" \
  "$BI_BASE_URL/api/bi/events?event_type=order.placed,order.cancelled&since=2026-11-01T00:00:00Z&limit=20"

curl -s -H "Authorization: Bearer $BI_API_SECRET" \
  "$BI_BASE_URL/api/bi/summary?since=2026-11-01T00:00:00Z&until=2026-11-08T00:00:00Z"

curl -s -H "x-bi-secret: $BI_API_SECRET" "$BI_BASE_URL/api/bi/events?source=all&limit=5"
```

`VERCEL_AUTOMATION_BYPASS_SECRET` is optional. Set it only if production Deployment Protection would
block the app from calling its own `/api/fix-status`. A public production URL does not need it.

### Auth0 application URLs

Keep the localhost entries. Add the production origin, and preview origins if you use preview deployments.
Auth0 accepts a wildcard such as `https://*.vercel.app` when the tenant allows wildcards; otherwise add
each preview host you actually open.

| Field | Values |
|---|---|
| Allowed Callback URLs | `http://localhost:3000/auth/callback`, `https://<production-host>/auth/callback`, and for previews `https://*.vercel.app/auth/callback` |
| Allowed Logout URLs | `http://localhost:3000`, `https://<production-host>`, and for previews `https://*.vercel.app` |
| Allowed Web Origins | `http://localhost:3000`, `https://<production-host>`, and for previews `https://*.vercel.app` |

### GitHub webhook

On the repo (`GITHUB_REPO`), add one webhook:

| Setting | Value |
|---|---|
| Payload URL | `https://<production-host>/api/github/webhook` |
| Content type | `application/json` |
| Secret | the `GITHUB_WEBHOOK_SECRET` value |
| Events | Pull requests, and Workflow runs |

The route checks `X-Hub-Signature-256` and ignores deliveries for any other repository.

### Plan limits that matter

- **Hobby + Fluid compute:** function duration max is 300 seconds. Do not set `maxDuration` above 300 or the deploy is rejected. Pro can go to 800; this app stays at 300 so Hobby works.
- **Hobby cron:** at most once per day. Timely `fix_completed` notifications come from the in-request slice and the pull request webhook, not from the cron.
- Nothing in memory or on the local disk is required between requests. The GitHub issue is the record of an in-flight fix.
