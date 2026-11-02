# Support bot demo

Sign in first. The shop is at `/`. Support is the button at the bottom left. Each write shows **Confirm** and **Cancel** in the chat. Cancel does nothing. Confirm is what changes the cart, the order, or files a report.

1. **Browse.** Look at the coffees and the mug. The cart on the right starts empty.
2. **Ask.** Open Support and ask what coffees are for sale. The answer comes from the FAQ tool.
3. **Add to cart.** Ask the bot to add 1 BeanBox Ceramic Mug. Press **Confirm**. The cart on the right shows the mug at the catalogue price.
4. **Coupon.** Type `Please apply SAVE10` in the chat. Press **Confirm** when the bot asks. The bot will not tell you a code. It only applies a code you typed. The mug total drops by 10 percent.
5. **Place the order.** Ask the bot to check out. Press **Confirm**. You get an order id that starts with `BB-`, and the cart is empty.
6. **Cancel.** Ask the bot to cancel that order id. Press **Confirm** while it is still cancellable (placed or packed).
7. **Report a problem.** Ask the bot to report that Add to cart does nothing for the Canvas Tote Bag. Press **Confirm**. That files feedback through the same path as Report a problem and starts reproduce-first triage.

Prices in the chat come from the catalogue. Quantity has to be from 1 to 99. More than 20 chats in an hour, 30 cart writes in an hour, or 10 order writes in an hour returns a short "try again" message.
