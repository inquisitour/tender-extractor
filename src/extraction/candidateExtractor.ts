import { z } from "zod";
import type { RawChunk, CandidateRequirement } from "../types/procurement.js";
import type { DocumentGraph } from "../graph/documentGraph.js";
import { callLLM, parseJsonResponse } from "./llmClient.js";
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
} from "../prompts/extraction.js";
import { createLogger, withTiming } from "../utils/logger.js";

const log = createLogger("candidateExtractor");
const BATCH_SIZE = 4; // chunks per LLM call
const MAX_CHARS_PER_BATCH = 3000; // safety cap on total chars sent

// Zod schema for validating LLM extraction output
const ExtractionOutputSchema = z.object({
  candidates: z.array(
    z.object({
      bulletPoint: z.record(z.string(), z.string()),
      description: z.record(z.string(), z.string()),
      priority: z.enum(["must", "should", "optional"]),
      confidence: z.enum(["high", "medium", "low"]),
      confidenceReason: z.string().optional(),
      equivalenceAllowed: z.boolean(),
      fullfillable: z.boolean(),
      sourceChunkIds: z.array(z.string()).min(1),
    })
  ),
});

// extractCandidates: runs LLM extraction over all chunks in batches
export async function extractCandidates(
  graph: DocumentGraph,
  documentLanguage: string
): Promise<CandidateRequirement[]> {
  const allChunks = graph.getAllChunks();
  log.info({ totalChunks: allChunks.length, language: documentLanguage }, "Starting candidate extraction");

  const batches = buildBatches(allChunks);
  log.info({ batches: batches.length, avgBatchSize: (allChunks.length / batches.length).toFixed(1) }, "Chunks batched");

  const allCandidates: CandidateRequirement[] = [];
  let candidateCounter = 1;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    log.info({ batch: i + 1, of: batches.length, chunks: batch.length }, "Processing batch");

    const batchCandidates = await withTiming(
      log,
      `Extract batch ${i + 1}/${batches.length}`,
      () => extractBatch(batch, documentLanguage)
    );

    // Assign stable candidate IDs and enrich with graph neighbors
    for (const raw of batchCandidates) {
      // Validate all source chunk IDs resolve to real chunks
      const validChunkIds = raw.sourceChunkIds.filter((id) => graph.getChunkById(id) !== undefined);

      if (validChunkIds.length === 0) {
        log.warn({ candidate: raw.bulletPoint }, "Skipping candidate — no valid source chunk IDs");
        continue;
      }

      // Include neighbor chunks if any of the source chunks have references
      // This is the start of consolidation: pull related chunks in now
      const expandedChunkIds = new Set(validChunkIds);
      for (const chunkId of validChunkIds) {
        const neighbors = graph.getNeighborChunks(chunkId);
        // Only add neighbors if they are directly referenced (explicit links)
        const chunk = graph.getChunkById(chunkId);
        if (chunk) {
          chunk.referencesChunkIds.forEach((id) => expandedChunkIds.add(id));
          chunk.referencedByChunkIds.forEach((id) => expandedChunkIds.add(id));
        }
      }

      const candidate: CandidateRequirement = {
        candidateId: `CAND-${String(candidateCounter).padStart(4, "0")}`,
        bulletPoint: raw.bulletPoint as Record<string, string>,
        description: raw.description as Record<string, string>,
        priority: raw.priority,
        confidence: raw.confidence,
        equivalenceAllowed: raw.equivalenceAllowed,
        fullfillable: raw.fullfillable,
        sourceChunkIds: Array.from(expandedChunkIds),
      };

      allCandidates.push(candidate);
      candidateCounter++;
    }

    log.debug({ batch: i + 1, candidatesFound: batchCandidates.length }, "Batch complete");
  }

  log.info(
    {
      totalCandidates: allCandidates.length,
      mustCount: allCandidates.filter((c) => c.priority === "must").length,
      shouldCount: allCandidates.filter((c) => c.priority === "should").length,
      optionalCount: allCandidates.filter((c) => c.priority === "optional").length,
    },
    "Candidate extraction complete"
  );

  return allCandidates;
}

// extractBatch: single LLM call for one batch of chunks
async function extractBatch(
  chunks: RawChunk[],
  language: string
): Promise<z.infer<typeof ExtractionOutputSchema>["candidates"]> {
  const userPrompt = buildExtractionUserPrompt(
    chunks.map((c) => ({
      chunkId: c.chunkId,
      text: c.text,
      pageNumber: c.pageNumber,
      sectionRef: c.sectionRef,
    })),
    language
  );

  const response = await callLLM([
    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);

  try {
    const parsed = parseJsonResponse<unknown>(response.content);
    const validated = ExtractionOutputSchema.parse(parsed);
    return validated.candidates;
  } catch (err) {
    log.error({ err, response: response.content.slice(0, 300) }, "Extraction validation failed");
    return []; // Non fatal: skip bad batches rather than crash
  }
}

// buildBatches: splits chunks into LLM safe batches
// Respects both BATCH_SIZE and MAX_CHARS_PER_BATCH limits
function buildBatches(chunks: RawChunk[]): RawChunk[][] {
  const batches: RawChunk[][] = [];
  let current: RawChunk[] = [];
  let currentChars = 0;

  for (const chunk of chunks) {
    const chunkChars = chunk.text.length;

    if (
      current.length >= BATCH_SIZE ||
      (current.length > 0 && currentChars + chunkChars > MAX_CHARS_PER_BATCH)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(chunk);
    currentChars += chunkChars;
  }

  if (current.length > 0) batches.push(current);

  return batches;
}