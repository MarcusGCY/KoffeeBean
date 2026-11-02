import { serve } from "@grok/agent-sdk";
import os from "node:os";
import path from "node:path";

// Started with `node --import tsx` so the agent's TypeScript loads outside
// Next's module hooks. Prints one line, then keeps the loopback server up.
const handle = await serve(path.join(process.cwd(), "support-agent"), {
  host: "127.0.0.1",
  port: 0,
  playground: false,
  docs: false,
  schedules: false,
  reminders: false,
  apiKey: process.env.CURSOR_API_KEY,
  stateRoot: path.join(os.tmpdir(), "beanbox-support"),
  mode: "single",
});
const url = (handle.agents[0]?.url ?? handle.url).replace(/\/$/, "");
process.stdout.write(`SUPPORT_URL=${url}\n`);
