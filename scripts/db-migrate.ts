import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

/**
 * Applies db/migrations/*.sql in order. Idempotent. Needs DATABASE_URL.
 * The connection string is never printed.
 *
 *   npm run db:migrate
 */

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "migration failed";
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://***");
}

function statements(file: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().startsWith("--")) continue;
    if (!line.trim() && current.length === 0) continue;
    current.push(line);
    if (line.trim().endsWith(";")) {
      const statement = current.join("\n").trim().replace(/;\s*$/, "").trim();
      if (statement) out.push(statement);
      current = [];
    }
  }
  const tail = current.join("\n").trim().replace(/;\s*$/, "").trim();
  if (tail) out.push(tail);
  return out;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = path.join(root, "db", "migrations");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const sql = neon(url);
  await sql.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  for (const name of files) {
    const steps = statements(path.join(dir, name));
    for (let i = 0; i < steps.length; i += 1) {
      try {
        await sql.query(steps[i]);
      } catch (error) {
        console.error(`Failed ${name} statement ${i + 1}: ${safeError(error)}`);
        process.exit(1);
      }
    }
    await sql.query(`INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [name]);
    console.log(`applied ${name} (${steps.length} statements)`);
  }
}

main().catch((error: unknown) => {
  console.error(safeError(error));
  process.exit(1);
});
