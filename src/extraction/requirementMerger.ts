import { z } from "zod";
import type { CandidateRequirement } from "../types/procurement.js";
import { callLLM, parseJsonResponse } from "./llmClient.js";
import {
  MERGE_SYSTEM_PROMPT,
  buildMergeUserPrompt,
} from "../prompts/merge.js";
import { loadFromCache, saveToCache } from "../ingestion/cache.js";
import { createLogger, withTiming } from "../utils/logger.js";

const log = createLogger("requirementMerger");
const SIMILARITY_THRESHOLD = 0.82; // Cosine similarity above which we check for merge
const MAX_LLM_MERGE_CHECKS = 200;  // Safety cap: large tenders could generate many pairs

// Zod schema for LLM merge decision
const MergeDecisionSchema = z.object({
  shouldMerge: z.boolean(),
  confidence: z.string(),          // normalised after parsing
  reason: z.string(),
  mergedBulletPoint: z.record(z.string(), z.string()),
  mergedDescription: z.record(z.string(), z.string()),
  mergedPriority: z.string(),      // normalised after parsing
  mergedConfidence: z.string(),    // normalised after parsing
  mergedEquivalenceAllowed: z.boolean(),
});

// computeEmbedding: local embeddings via @xenova/transformers
// Runs in-process, no API cost, cached to disk
async function computeEmbedding(text: string): Promise<number[]> {
  const cacheKey = `embeddings:${Buffer.from(text).toString("base64").slice(0, 64)}`;

  const cached = await loadFromCache<number[]>(cacheKey);
  if (cached) return cached;

  // Lazy load the pipeline to avoid slow startup on every run
  const { pipeline } = await import("@xenova/transformers");
  const embedPipeline = await pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2"
  );

  const output = await embedPipeline(text, { pooling: "mean", normalize: true });
  const embedding = Array.from(output.data) as number[];

  await saveToCache(cacheKey, embedding);
  return embedding;
}

// cosineSimilarity: standard vector similarity
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// getTextForEmbedding: builds the text to embed for a candidate
// Uses both label and description for richer semantic signal
function getTextForEmbedding(candidate: CandidateRequirement): string {
  const label = candidate.bulletPoint.en ?? candidate.bulletPoint.de ?? "";
  const desc = candidate.description.en ?? candidate.description.de ?? "";
  return `${label} ${desc}`.slice(0, 500);
}

// confirmMerge: asks the LLM whether two candidates should be merged
async function confirmMerge(
  a: CandidateRequirement,
  b: CandidateRequirement
): Promise<z.infer<typeof MergeDecisionSchema> | null> {
  const userPrompt = buildMergeUserPrompt(
    {
      bulletPoint: a.bulletPoint,
      description: a.description,
      priority: a.priority,
      confidence: a.confidence,
      sourceChunkIds: a.sourceChunkIds,
    },
    {
      bulletPoint: b.bulletPoint,
      description: b.description,
      priority: b.priority,
      confidence: b.confidence,
      sourceChunkIds: b.sourceChunkIds,
    }
  );

  try {
    const response = await callLLM([
      { role: "system", content: MERGE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]);

    const parsed = parseJsonResponse<any>(response.content);

    // Normalise: accept any casing or language, clamp to valid values
    const priorityMap: Record<string, string> = {
      "must": "must", "muss": "must", "pflicht": "must", "zwingend": "must",
      "mandatory": "must", "required": "must", "erforderlich": "must",
      "notwendig": "must", "verbindlich": "must",
      "should": "should", "sollte": "should", "empfohlen": "should",
      "recommended": "should", "empfehlung": "should",
      "optional": "optional", "kann": "optional", "darf": "optional",
      "fakultativ": "optional", "wahlweise": "optional",
    };
    const confidenceMap: Record<string, string> = {
      "high": "high", "hoch": "high", "sehr hoch": "high", "sehr_hoch": "high",
      "medium": "medium", "mittel": "medium", "moderat": "medium",
      "moderate": "medium", "mittel-hoch": "medium",
      "low": "low", "niedrig": "low", "gering": "low", "sehr niedrig": "low",
    };

    // Normalise with fallback: never let an unknown value crash the pipeline
    const normPriority = (v: string): "must" | "should" | "optional" => {
      const mapped = priorityMap[v?.toLowerCase()?.trim()];
      if (mapped) return mapped as "must" | "should" | "optional";
      // Heuristic fallback: if it looks like a strong obligation use "must"
      const lower = v?.toLowerCase() ?? "";
      if (lower.includes("must") || lower.includes("muss") || lower.includes("zwing")) return "must";
      if (lower.includes("should") || lower.includes("soll")) return "should";
      return "should"; // safe default
    };

    const normConfidence = (v: string): "high" | "medium" | "low" => {
      const mapped = confidenceMap[v?.toLowerCase()?.trim()];
      if (mapped) return mapped as "high" | "medium" | "low";
      const lower = v?.toLowerCase() ?? "";
      if (lower.includes("high") || lower.includes("hoch")) return "high";
      if (lower.includes("low") || lower.includes("niedrig") || lower.includes("gering")) return "low";
      return "medium"; // safe default
    };

    parsed.mergedPriority = normPriority(parsed.mergedPriority ?? "should");
    parsed.mergedConfidence = normConfidence(parsed.mergedConfidence ?? "medium");
    parsed.confidence = normConfidence(parsed.confidence ?? "medium");

    return MergeDecisionSchema.parse(parsed);
  } catch (err) {
    log.warn(
      { candidateA: a.candidateId, candidateB: b.candidateId, err },
      "Merge decision failed — skipping pair"
    );
    return null;
  }
}

// mergeRequirements: the main merge function
// Returns deduplicated, consolidated requirements with REQ-xxxx IDs
export async function mergeRequirements(
  candidates: CandidateRequirement[]
): Promise<CandidateRequirement[]> {
  log.info({ candidateCount: candidates.length }, "Starting requirement merging");

  // Step 1: Compute embeddings for all candidates
  log.info("Computing embeddings for all candidates");
  const embeddings: number[][] = await withTiming(
    log,
    "Compute embeddings",
    async () => {
      const result: number[][] = [];
      for (const candidate of candidates) {
        const text = getTextForEmbedding(candidate);
        const embedding = await computeEmbedding(text);
        result.push(embedding);
      }
      return result;
    }
  );

  // Store embeddings on candidates for later use
  candidates.forEach((c, i) => {
    c.embedding = embeddings[i];
  });

  // Step 2: Find candidate pairs above similarity threshold
  const similarPairs: Array<{ i: number; j: number; similarity: number }> = [];

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      if (sim >= SIMILARITY_THRESHOLD) {
        similarPairs.push({ i, j, similarity: sim });
      }
    }
  }

  // Sort by similarity descending: process highest confidence pairs first
  similarPairs.sort((a, b) => b.similarity - a.similarity);

  log.info(
    {
      similarPairsFound: similarPairs.length,
      threshold: SIMILARITY_THRESHOLD,
      pairsToCheck: Math.min(similarPairs.length, MAX_LLM_MERGE_CHECKS),
    },
    "Similarity scan complete"
  );

  // Step 3: LLM confirmation for similar pairs
  const parent: number[] = candidates.map((_, i) => i);

  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }

  function union(x: number, y: number): void {
    parent[find(x)] = find(y);
  }

  let mergesConfirmed = 0;
  let mergesRejected = 0;
  const pairsToCheck = similarPairs.slice(0, MAX_LLM_MERGE_CHECKS);

  for (const { i, j, similarity } of pairsToCheck) {
    // Skip if already in the same merge group
    if (find(i) === find(j)) continue;

    const decision = await confirmMerge(candidates[i], candidates[j]);

    if (!decision) continue; // skip pairs where merge decision failed

    if (decision.shouldMerge) {
      union(i, j);
      mergesConfirmed++;

      log.debug(
        {
          a: candidates[i].candidateId,
          b: candidates[j].candidateId,
          similarity: similarity.toFixed(3),
          reason: decision.reason,
        },
        "Merge confirmed"
      );
    } else {
      mergesRejected++;
      log.debug(
        {
          a: candidates[i].candidateId,
          b: candidates[j].candidateId,
          similarity: similarity.toFixed(3),
          reason: decision.reason,
        },
        "Merge rejected"
      );
    }
  }

  log.info(
    { mergesConfirmed, mergesRejected },
    "LLM merge decisions complete"
  );

  // Step 4: Build merged requirements from groups
  const groups = new Map<number, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const merged: CandidateRequirement[] = [];
  let reqCounter = 1;

  for (const [, group] of groups) {
    const primary = candidates[group[0]];
    const others = group.slice(1).map((i) => candidates[i]);

    if (others.length === 0) {
      // No merge: single candidate, assign REQ ID and keep as is
      primary.requirementId = `REQ-${String(reqCounter).padStart(4, "0")}`;
      reqCounter++;
      merged.push(primary);
      continue;
    }

    // Merge: consolidate all chunk IDs from all members of the group
    const allChunkIds = new Set<string>(primary.sourceChunkIds);
    for (const other of others) {
      other.sourceChunkIds.forEach((id) => allChunkIds.add(id));
    }

    // Priority escalation: if any member is "must", the merged is "must"
    const priorityRank = { must: 2, should: 1, optional: 0 };
    const highestPriority = [primary, ...others].reduce((best, c) =>
      priorityRank[c.priority] > priorityRank[best.priority] ? c : best
    );

    // Confidence: take the most conservative (lowest) confidence from group
    const confidenceRank = { high: 2, medium: 1, low: 0 };
    const lowestConfidence = [primary, ...others].reduce((worst, c) =>
      confidenceRank[c.confidence] < confidenceRank[worst.confidence] ? c : worst
    );

    const mergedRequirement: CandidateRequirement = {
      candidateId: primary.candidateId,
      requirementId: `REQ-${String(reqCounter).padStart(4, "0")}`,
      bulletPoint: primary.bulletPoint,
      description: primary.description,
      priority: highestPriority.priority,
      confidence: lowestConfidence.confidence,
      equivalenceAllowed: [primary, ...others].some((c) => c.equivalenceAllowed),
      fullfillable: [primary, ...others].every((c) => c.fullfillable),
      sourceChunkIds: Array.from(allChunkIds),
    };

    log.info(
      {
        requirementId: mergedRequirement.requirementId,
        mergedFrom: group.length,
        totalChunks: allChunkIds.size,
        label: mergedRequirement.bulletPoint.en ?? mergedRequirement.bulletPoint.de,
      },
      "Requirements merged"
    );

    reqCounter++;
    merged.push(mergedRequirement);
  }

  log.info(
    {
      beforeMerge: candidates.length,
      afterMerge: merged.length,
      reductionPercent: Math.round((1 - merged.length / candidates.length) * 100),
      avgChunksPerRequirement: (
        merged.reduce((s, r) => s + r.sourceChunkIds.length, 0) / merged.length
      ).toFixed(2),
    },
    "Merge complete"
  );

  return merged;
}