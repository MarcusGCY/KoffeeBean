# BeanBox: SDLC automation demo (Cursor SDK)

A small coffee and merch store with **planted bugs**. Users report problems from the
store, and a pipeline triages them, asks a human to approve, then has Cursor fix them.

```
Report a problem widget
  -> POST /api/feedback
  -> Cursor agent (plan mode) triages: duplicate of an open issue?
       yes -> comment on the existing issue (merged)
       no  -> create a GitHub issue (labels: user-feedback, awaiting-review)
  -> review request sent to the Grok bot (GROK_WEBHOOK_URL)
  -> human taps Approve  -> GET /api/review (signed link)
       -> Cursor cloud agent fixes the bug and opens a PR (autoCreatePR)
       -> issue gets a comment with the PR link
  -> human taps Reject   -> issue closed as wontfix
```

## Planted bugs (`npm test` fails on these until fixed)

| Bug | Where | Test |
|---|---|---|
| Coupon codes are case-sensitive and not trimmed | `src/lib/coupons.ts` | `coupons` |
| Removing an item leaves a 0-quantity line, and `subtotal` counts it as 1 | `src/lib/cart.ts` | `removing items` |

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

`APP_BASE_URL` is the Auth0 SDK v4 name. `APP_URL` is separate: it is the origin baked into
approve/reject links. Set both to the same origin for local dev. v3 names
(`AUTH0_ISSUER_BASE_URL`, `AUTH0_BASE_URL`) are not read by this SDK.

`next build` does not need these values. Login works after `.env.local` is filled and the
dev server is restarted.

## Demo script

1. Log in, open the store, add a mug, then enter `save10`. The discount is missing (bug).
2. Click **Report a problem** and type "my promo code does nothing".
3. Show the new GitHub issue and the review request in Grok.
4. Report it again in different words ("discount code ignored"). It merges into the same issue.
5. Approve in Grok, then show the Cursor agent and the PR. Merge it and re-run `npm test`.

## Grok webhook contract (assumed, adjust to the bot's real API)

`POST GROK_WEBHOOK_URL` with `{ type, issue:{number,title,url}, summary, actions:[{id,label,url}] }`.
The bot shows the summary with Approve and Reject buttons. Each button calls that action's `url`.
