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
2. `cp .env.example .env.local` and fill in the values.
3. `npm run dev`. To let the Grok bot call back to your machine, expose it with ngrok and
   set `APP_URL`.
4. If the bot is not ready yet, open `/review/<issue number>` to approve or reject by hand.

## Demo script

1. Open the store and add a mug, then enter `save10`. The discount is missing (bug).
2. Click **Report a problem** and type "my promo code does nothing".
3. Show the new GitHub issue and the review request in Grok.
4. Report it again in different words ("discount code ignored"). It merges into the same issue.
5. Approve in Grok, then show the Cursor agent and the PR. Merge it and re-run `npm test`.

## Grok webhook contract (assumed, adjust to the bot's real API)

`POST GROK_WEBHOOK_URL` with `{ type, issue:{number,title,url}, summary, actions:[{id,label,url}] }`.
The bot shows the summary with Approve and Reject buttons. Each button calls that action's `url`.
