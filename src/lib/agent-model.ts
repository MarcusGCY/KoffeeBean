import { Cursor, type ModelSelection } from "@cursor/sdk";

/** Catalog of model ids from Cursor.models.list(), shared for the life of the process. */
let catalog: Promise<Set<string>> | undefined;

export function resetAgentModelCatalog(): void {
  catalog = undefined;
}

function modelIds(apiKey: string): Promise<Set<string>> {
  if (!catalog) {
    const pending = Cursor.models
      .list({ apiKey })
      .then((models) => new Set(models.map((model) => model.id)))
      .catch((err: unknown) => {
        if (catalog === pending) catalog = undefined;
        throw err;
      });
    catalog = pending;
  }
  return catalog;
}

function shown(id: string, apiKey: string): string {
  return apiKey && id.includes(apiKey) ? "[redacted]" : id;
}

/**
 * Default params apply only when the resolved id is the built-in default.
 * An override is `{ id }` so that model keeps its own defaults.
 * A catalog miss falls back to the default. If models.list fails, the override is used as given.
 */
export async function resolveCursorModel(options: {
  kind: "triage" | "fix";
  envName: "TRIAGE_MODEL" | "FIX_MODEL";
  fallback: ModelSelection;
  apiKey: string;
}): Promise<ModelSelection> {
  const override = process.env[options.envName]?.trim();
  const useDefault = !override || override === options.fallback.id;
  let model: ModelSelection = options.fallback;
  if (!useDefault) {
    try {
      const ids = await modelIds(options.apiKey);
      if (!ids.has(override)) {
        console.error(
          `[${options.kind}] unknown ${options.envName}=${shown(override, options.apiKey)}, using ${options.fallback.id}`,
        );
      } else {
        model = { id: override };
      }
    } catch {
      model = { id: override };
    }
  }
  console.log(`[${options.kind}] model=${shown(model.id, options.apiKey)}`);
  return model;
}
