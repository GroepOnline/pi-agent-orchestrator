/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry<T extends ModelEntry = ModelEntry> {
  find(provider: string, modelId: string): T | undefined;
  getAll(): T[];
  getAvailable?(): T[];
}

// Module-level cache for the expensive Set+array build in resolveModel.
// Invalidated automatically when the registry instance changes (identity check).
let cachedRegistry: unknown = null;
let cachedSet: Set<string> | null = null;
let cachedAll: ModelEntry[] | null = null;

/**
 * Builds (and caches) a set of lowercase "provider/id" keys and the corresponding model list from the registry.
 *
 * @param registry - Registry to query; uses `getAvailable()` if present, otherwise falls back to `getAll()`.
 * @returns An object with `set` containing lowercase `"provider/id"` entries for available models and `all` containing the list used to build the set.
 */
function getAvailableSet<T extends ModelEntry>(registry: ModelRegistry<T>): { set: Set<string>; all: T[] } {
  if (registry !== cachedRegistry || !cachedSet) {
    const all = registry.getAvailable?.() ?? registry.getAll();
    cachedAll = all;
    cachedSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));
    cachedRegistry = registry;
  }
  return { set: cachedSet, all: cachedAll! as T[] };
}

/** Manually invalidate the model cache (e.g. after registry mutation). */
export function invalidateModelCache(): void {
  cachedRegistry = null;
  cachedSet = null;
  cachedAll = null;
}

/** Build the "Model not found" error that lists every available model. */
function modelNotFound(input: string, all: ModelEntry[]): string {
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

/**
 * Resolve a model identifier to a registered model.
 *
 * Attempts an exact "provider/modelId" match against available models, then falls back to a fuzzy search over provider, id, and name.
 *
 * @param input - The model identifier or search query
 * @param registry - Registry to resolve the model from
 * @returns The matched model of type `T` if found, otherwise an error message string that lists available models
 */
export function resolveModel<T extends ModelEntry>(
  input: string,
  registry: ModelRegistry<T>,
): T | string {
  // Available models (those with auth configured) — cached per registry instance
  const { set: availableSet, all } = getAvailableSet(registry);

  // Reject empty/blank input up front. An empty query makes `id.includes(query)`
  // and the multi-part `every()` check vacuously true, so it would otherwise
  // resolve to the first model. Cross-extension RPC (subagents:rpc:spawn) forwards
  // the caller's string straight into resolveModel, so a blank string must fail
  // loudly instead of silently spawning an agent on an arbitrary model.
  if (typeof input !== "string" || input.trim() === "") {
    return modelNotFound(typeof input === "string" ? input : "", all);
  }

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const lowercasedInput = input.toLowerCase();
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(lowercasedInput)) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match against available models
  const query = lowercasedInput;

  // Score each model: prefer exact id match > id contains > name contains > provider+id contains
  let bestMatch: ModelEntry | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = m.id.toLowerCase();
    const name = m.name.toLowerCase();
    const full = `${m.provider}/${m.id}`.toLowerCase();

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (query.split(/[\s\-/]+/).every(part => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. No match — list available models
  return modelNotFound(input, all);
}
