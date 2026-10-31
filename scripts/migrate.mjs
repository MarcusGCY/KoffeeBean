import { neon } from "@neondatabase/serverless";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = neon(url);

function statements(fileText) {
  return fileText
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const dir = path.join(process.cwd(), "migrations");
const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
const applied = await sql`SELECT version FROM schema_migrations`;
const done = new Set(applied.map((row) => row.version));

for (const file of files) {
  if (done.has(file)) {
    console.log(`skip ${file}`);
    continue;
  }
  const text = await readFile(path.join(dir, file), "utf8");
  const steps = statements(text);
  await sql.transaction((txn) => [
    ...steps.map((statement) => txn.query(statement)),
    txn`INSERT INTO schema_migrations (version) VALUES (${file})`,
  ]);
  console.log(`applied ${file}`);
}
