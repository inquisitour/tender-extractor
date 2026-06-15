import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("cache");

// Cache directories: three layers
// .cache/parsed/    --> PDF text extraction results
// .cache/llm/       --> LLM responses, keyed by prompt hash
// .cache/embeddings/--> candidate requirement embeddings

const CACHE_BASE = path.resolve(process.cwd(), ".cache");

const CACHE_DIRS = {
  parsed: path.join(CACHE_BASE, "parsed"),
  llm: path.join(CACHE_BASE, "llm"),
  embeddings: path.join(CACHE_BASE, "embeddings"),
};

// Ensure all cache directories exist
for (const dir of Object.values(CACHE_DIRS)) {
  fs.mkdirSync(dir, { recursive: true });
}

// Determines which cache layer based on key prefix
function getCacheDir(key: string): string {
  if (key.startsWith("parsed:")) return CACHE_DIRS.parsed;
  if (key.startsWith("llm:")) return CACHE_DIRS.llm;
  if (key.startsWith("embeddings:")) return CACHE_DIRS.embeddings;
  // Default to llm for generic keys
  return CACHE_DIRS.llm;
}

function getCachePath(key: string): string {
  // Hash the key to get a safe filename
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(getCacheDir(key), `${hash}.json`);
}

// loadFromCache: returns null if cache miss
export async function loadFromCache<T>(key: string): Promise<T | null> {
  const cachePath = getCachePath(key);

  if (!fs.existsSync(cachePath)) {
    log.debug({ key }, "Cache miss");
    return null;
  }

  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const data = JSON.parse(raw) as { value: T; savedAt: string };
    log.debug({ key }, "Cache hit");
    return data.value;
  } catch (err) {
    log.warn({ key, err }, "Cache read error: treating as miss");
    return null;
  }
}

// saveToCache: persists a value to the appropriate cache layer
export async function saveToCache<T>(key: string, value: T): Promise<void> {
  const cachePath = getCachePath(key);

  try {
    const data = { value, savedAt: new Date().toISOString() };
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
    log.debug({ key }, "Cache saved");
  } catch (err) {
    // Cache failures: just log and continue
    log.warn({ key, err }, "Cache write error: continuing without cache");
  }
}

// hashPrompt: deterministic key for LLM cache entries
// Allows exact same prompt to be served from cache on rerun
export function hashPrompt(prompt: string, model?: string): string {
  const input = model ? `${model}:${prompt}` : prompt;
  return `llm:${crypto.createHash("sha256").update(input).digest("hex")}`;
}

// clearCache: wipes a specific layer or all layers
export function clearCache(layer?: "parsed" | "llm" | "embeddings"): void {
  const dirs = layer ? [CACHE_DIRS[layer]] : Object.values(CACHE_DIRS);

  for (const dir of dirs) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      fs.unlinkSync(path.join(dir, file));
    }
    log.info({ dir, filesRemoved: files.length }, "Cache cleared");
  }
}