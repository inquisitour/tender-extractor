import type {
  ProcurementMatchDeliverable,
  ExtractionOutput,
} from "../types/procurement.js";
import type { DocumentGraph } from "../graph/documentGraph.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("spotCheck");

export interface SpotCheckResult {
  leaf: ProcurementMatchDeliverable;
  sourceChunks: Array<{
    chunkId: string;
    documentName: string;
    pageNumber?: number;
    sectionRef?: string;
    textSnippet: string;
  }>;
  qualityScore: "good" | "needs_review" | "suspicious";
  qualityNotes: string[];
}

// collectLeaves: flattens the tree to just L3 nodes
function collectLeaves(tree: ProcurementMatchDeliverable[]): ProcurementMatchDeliverable[] {
  const leaves: ProcurementMatchDeliverable[] = [];

  function traverse(node: ProcurementMatchDeliverable): void {
    if (!node.deliverableArray || node.deliverableArray.length === 0) {
      leaves.push(node);
      return;
    }
    for (const child of node.deliverableArray) {
      traverse(child);
    }
  }

  for (const node of tree) traverse(node);
  return leaves;
}

// scoreLeaf: heuristic quality assessment for a leaf
function scoreLeaf(
  leaf: ProcurementMatchDeliverable,
  sourceChunks: SpotCheckResult["sourceChunks"]
): Pick<SpotCheckResult, "qualityScore" | "qualityNotes"> {
  const notes: string[] = [];

  // Check: does it have multiple chunks? (consolidation working)
  if (sourceChunks.length === 1) {
    notes.push("Only 1 source chunk and may not be fully consolidated");
  } else if (sourceChunks.length >= 3) {
    notes.push(`Well consolidated: ${sourceChunks.length} source chunks`);
  }

  // Check: confidence vs chunk count
  if (leaf.confidence === "high" && sourceChunks.length === 0) {
    notes.push("WARNING: high confidence but no resolved chunks");
  }

  // Check: empty description
  const desc = Object.values(leaf.description).join("").trim();
  if (desc.length < 20) {
    notes.push("WARNING: very short description");
  }

  // Check: are chunks from different pages? (cross page consolidation)
  const uniquePages = new Set(sourceChunks.map((c) => c.pageNumber).filter(Boolean));
  if (uniquePages.size > 1) {
    notes.push(`Cross-page consolidation: chunks from pages ${Array.from(uniquePages).join(", ")}`);
  }

  // Determine overall score
  const hasWarnings = notes.some((n) => n.startsWith("WARNING"));
  const hasSingleChunk = sourceChunks.length === 1;
  const isCrossPage = uniquePages.size > 1;

  let qualityScore: SpotCheckResult["qualityScore"];
  if (hasWarnings) {
    qualityScore = "suspicious";
  } else if (hasSingleChunk && !isCrossPage) {
    qualityScore = "needs_review";
  } else {
    qualityScore = "good";
  }

  return { qualityScore, qualityNotes: notes };
}

// runSpotCheck: main entry point
export function runSpotCheck(
  output: ExtractionOutput,
  graph: DocumentGraph,
  sampleSize = 20
): SpotCheckResult[] {
  const leaves = collectLeaves(output.tree);
  log.info({ totalLeaves: leaves.length, sampleSize }, "Running spot check");

  // Random sample: shuffled index selection
  const shuffled = [...leaves].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, Math.min(sampleSize, leaves.length));

  const results: SpotCheckResult[] = [];

  for (const leaf of sample) {
    // Resolve source chunks
    const sourceChunks = leaf.procurementDocumentChunkIdArray
      .map((id) => {
        const chunk = graph.getChunkById(id);
        if (!chunk) return null;
        return {
          chunkId: id,
          documentName: chunk.documentName,
          pageNumber: chunk.pageNumber,
          sectionRef: chunk.sectionRef,
          textSnippet: chunk.text.slice(0, 300),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    const { qualityScore, qualityNotes } = scoreLeaf(leaf, sourceChunks);

    results.push({ leaf, sourceChunks, qualityScore, qualityNotes });
  }

  // Print human readable report
  printSpotCheckReport(results);

  return results;
}

// printSpotCheckReport: terminal friendly output for manual review
function printSpotCheckReport(results: SpotCheckResult[]): void {
  const divider = "─".repeat(80);

  console.log("\n" + "═".repeat(80));
  console.log("SPOT CHECK REPORT");
  console.log(`${results.length} leaves sampled`);
  console.log("═".repeat(80));

  const scoreCount = { good: 0, needs_review: 0, suspicious: 0 };

  for (const result of results) {
    scoreCount[result.qualityScore]++;
    const { leaf, sourceChunks, qualityScore, qualityNotes } = result;

    const scoreSignal = { good: "GOOD :=>", needs_review: "NEEDS_REVIEW :=>", suspicious: "SUSPICIOUS :=>" }[qualityScore];
    const label = leaf.bulletPoint;
    const desc = (leaf.description.en ?? leaf.description.de ?? "(no desc)").slice(0, 150);

    console.log(`\n${divider}`);
    console.log(`${scoreSignal} ${leaf.requirementId}: ${label}`);
    console.log(`   Priority: ${leaf.priority.toUpperCase()} | Confidence: ${leaf.confidence}`);
    console.log(`   Description: ${desc}`);

    if (qualityNotes.length > 0) {
      console.log(`   Notes:`);
      qualityNotes.forEach((n) => console.log(`     • ${n}`));
    }

    console.log(`   Source chunks (${sourceChunks.length}):`);
    for (const chunk of sourceChunks.slice(0, 5)) {
      const location = [
        chunk.documentName,
        chunk.pageNumber ? `p.${chunk.pageNumber}` : null,
        chunk.sectionRef ? `§${chunk.sectionRef}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      console.log(`     [${chunk.chunkId}] ${location}`);
      console.log(`       "${chunk.textSnippet.slice(0, 120)}..."`);
    }
    if (sourceChunks.length > 5) {
      console.log(`     ... and ${sourceChunks.length - 5} more`);
    }
  }

  console.log("\n" + "═".repeat(80));
  console.log("SUMMARY");
  console.log(`Good:         ${scoreCount.good}`);
  console.log(`Needs review: ${scoreCount.needs_review}`);
  console.log(`Suspicious:   ${scoreCount.suspicious}`);
  console.log("═".repeat(80) + "\n");
}