import type {
  ProcurementMatchDeliverable,
  ExtractionOutput,
} from "../types/procurement.js";
import type { DocumentGraph } from "../graph/documentGraph.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("invariantChecker");

// InvariantChecker: formal validation of the output tree
// Formal verification applied to the pipeline.
// Before any output is written, these invariants must hold.
// A failed invariant is a hard error, not a warning.

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    totalNodes: number;
    l1Count: number;
    l2Count: number;
    l3Count: number;
    orphanChunkIds: number;
    resolvedChunkIds: number;
  };
}

export function validateOutput(
  output: ExtractionOutput,
  graph: DocumentGraph
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();

  let totalNodes = 0;
  let l1Count = 0;
  let l2Count = 0;
  let l3Count = 0;
  let resolvedChunkIds = 0;
  let orphanChunkIds = 0;

  function validateNode(
    node: ProcurementMatchDeliverable,
    depth: number,
    path: string
  ): void {
    totalNodes++;
    const nodeRef = `${path}[${node.requirementId}]`;

    // Invariant: no duplicate requirement IDs
    if (seenIds.has(node.requirementId)) {
      errors.push(`Duplicate requirementId: ${node.requirementId} at ${path}`);
    }
    seenIds.add(node.requirementId);

    // Invariant: depth must not exceed 3
    if (depth > 3) {
      errors.push(`Tree depth exceeds 3 at ${nodeRef} (depth: ${depth})`);
    }

    // Invariant: no empty bulletPoint
    const bulletText = Object.values(node.bulletPoint).join("").trim();
    if (!bulletText) {
      errors.push(`Empty bulletPoint at ${nodeRef}`);
    }

    // Invariant: no empty description
    const descText = Object.values(node.description).join("").trim();
    if (!descText) {
      errors.push(`Empty description at ${nodeRef}`);
    }

    // Invariant: valid priority
    if (!["must", "should", "optional"].includes(node.priority)) {
      errors.push(`Invalid priority "${node.priority}" at ${nodeRef}`);
    }

    // Invariant: valid confidence
    if (!["high", "medium", "low"].includes(node.confidence)) {
      errors.push(`Invalid confidence "${node.confidence}" at ${nodeRef}`);
    }

    // Depth specific invariants
    if (depth === 1) {
      l1Count++;
      // L1 must have deliverableArray
      if (!node.deliverableArray || node.deliverableArray.length === 0) {
        errors.push(`L1 node has no deliverableArray at ${nodeRef}`);
      }
    } else if (depth === 2) {
      l2Count++;
      // L2 must have deliverableArray
      if (!node.deliverableArray || node.deliverableArray.length === 0) {
        errors.push(`L2 node has no deliverableArray at ${nodeRef}`);
      }
    } else if (depth === 3) {
      l3Count++;

      // Invariant: every L3 leaf has at least one source chunk
      if (node.procurementDocumentChunkIdArray.length === 0) {
        errors.push(`L3 leaf has no source chunks at ${nodeRef}`);
      }

      // Invariant: all chunk IDs must resolve to real chunks
      for (const chunkId of node.procurementDocumentChunkIdArray) {
        const chunk = graph.getChunkById(chunkId);
        if (!chunk) {
          errors.push(
            `Chunk ID "${chunkId}" does not resolve to a real chunk at ${nodeRef}`
          );
          orphanChunkIds++;
        } else {
          resolvedChunkIds++;
        }
      }

      // L3 should have no deliverableArray
      if (node.deliverableArray && node.deliverableArray.length > 0) {
        warnings.push(`L3 leaf unexpectedly has deliverableArray at ${nodeRef}`);
      }
    }

    // Recurse into deliverableArray
    if (node.deliverableArray) {
      for (const child of node.deliverableArray) {
        validateNode(child, depth + 1, `${nodeRef} > `);
      }
    }
  }

  // Validate the tree
  for (const l1 of output.tree) {
    validateNode(l1, 1, "tree > ");
  }

  // Stats consistency check
  if (output.stats.totalL1Nodes !== l1Count) {
    warnings.push(
      `Stats mismatch: declared L1=${output.stats.totalL1Nodes}, actual=${l1Count}`
    );
  }
  if (output.stats.totalL3Leaves !== l3Count) {
    warnings.push(
      `Stats mismatch: declared L3=${output.stats.totalL3Leaves}, actual=${l3Count}`
    );
  }

  // Warn if many orphan chunk IDs
  if (orphanChunkIds > 0) {
    warnings.push(
      `${orphanChunkIds} chunk ID(s) could not be resolved: these may indicate stale cache or chunking mismatch`
    );
  }

  const valid = errors.length === 0;

  log.info(
    {
      valid,
      errorCount: errors.length,
      warningCount: warnings.length,
      totalNodes,
      l1Count,
      l2Count,
      l3Count,
      resolvedChunkIds,
      orphanChunkIds,
    },
    valid ? "All invariants satisfied" : "Invariant violations found"
  );

  if (!valid) {
    errors.forEach((e) => log.error({ error: e }, "Invariant violation"));
  }
  warnings.forEach((w) => log.warn({ warning: w }, "Validation warning"));

  return {
    valid,
    errors,
    warnings,
    stats: {
      totalNodes,
      l1Count,
      l2Count,
      l3Count,
      orphanChunkIds,
      resolvedChunkIds,
    },
  };
}