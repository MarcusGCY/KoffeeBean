# Support bot demo

Sign in first. The shop is at `/`. Support is the button at the bottom left.

1. **Open Support.** Signed-in shoppers with a past order see "Your usual" with **Reorder** and **Change**. Reorder shows **Confirm**. The cart does not change until Confirm. Guests do not see the card.
2. **Ask.** Try "Something fruity". The reply streams, with a status line while the catalog is searched. Up to three product cards show the photo, name, price, and blurb from the catalog. **Add** calls the cart API. It becomes "Added ✓ · Undo".
3. **Coupon.** Ask for a discount with something in the cart, or after a past order. The bot can tell you `SAVE10`: 10% off the subtotal, no expiry. It does not apply the code. Type `Please apply SAVE10` and press **Confirm**. A cancelled order does not count. Only the newest 20 orders are kept.
4. **Checkout and reports.** Place, cancel, and report from the shop buttons. Those are not chat tools. Confirm still checks a signed action before any chat write.

Prices in the chat come from the catalogue. More than 20 chats an hour or 60 a day returns a short "try again" message.

Support chat calls xAI directly. There is no agent child process. Set these names in Vercel and `.env.local` (no values in git):

`XAI_API_KEY`
`XAI_MODEL` (optional; default `grok-4.20-0309-non-reasoning`)
`APPROVAL_SECRET`
`UPSTASH_REDIS_REST_URL`
`UPSTASH_REDIS_REST_TOKEN`
`AUTH0_DOMAIN`
`AUTH0_MGMT_CLIENT_ID`
`AUTH0_MGMT_CLIENT_SECRET`

`CURSOR_API_KEY` is still required for triage and fixes. It is not used by support chat.
