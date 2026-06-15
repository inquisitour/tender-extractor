import { z } from "zod";
import type {
  CandidateRequirement,
  ProcurementMatchDeliverable,
} from "../types/procurement.js";
import type { DocumentGraph } from "../graph/documentGraph.js";
import { callLLM, parseJsonResponse } from "./llmClient.js";
import {
  HIERARCHY_SYSTEM_PROMPT,
  buildHierarchyUserPrompt,
} from "../prompts/hierarchy.js";
import { createLogger, withTiming } from "../utils/logger.js";

const log = createLogger("hierarchyBuilder");

const HierarchyAssignmentSchema = z.object({
  tree: z.array(
    z.object({
      l1Label: z.record(z.string(), z.string()),
      l2Groups: z.array(
        z.object({
          l2Label: z.record(z.string(), z.string()),
          requirementIds: z.array(z.string()),
        })
      ),
    })
  ),
});

export async function buildHierarchy(
  requirements: CandidateRequirement[],
  graph: DocumentGraph,
  documentContext: string
): Promise<ProcurementMatchDeliverable[]> {
  log.info(
    { requirementCount: requirements.length, context: documentContext },
    "Building hierarchy"
  );

  const reqSummaries = requirements
    .filter((r) => r.requirementId !== undefined)
    .map((r) => ({
      requirementId: r.requirementId!,
      bulletPoint: r.bulletPoint,
      description: r.description,
      priority: r.priority,
    }));

  // For large documents, split requirements into batches of 200
  // Each batch gets its own hierarchy call, results are merged
  const HIERARCHY_BATCH_SIZE = 200;
  const assignment = await withTiming(
    log,
    "LLM hierarchy assignment",
    async () => {
      const batches: typeof reqSummaries[] = [];
      for (let i = 0; i < reqSummaries.length; i += HIERARCHY_BATCH_SIZE) {
        batches.push(reqSummaries.slice(i, i + HIERARCHY_BATCH_SIZE));
      }

      log.info({ batches: batches.length, total: reqSummaries.length }, "Hierarchy batches");

      // PHASE 1: Establish a fixed L1 taxonomy from a sample of requirements.
      // This runs once. Every batch is then constrained to use these exact L1s,
      // so the taxonomy is consistent across all batches regardless of document.
      let l1Constraint = "";
      try {
        const sample = reqSummaries.slice(0, 150);
        const sampleList = sample
          .map(r => `${r.requirementId}: ${r.bulletPoint.en ?? r.bulletPoint.de ?? ""}`)
          .join("\n");

        const taxonomyResponse = await callLLM([
          {
            role: "system",
            content: "You are a procurement taxonomy expert. Given a sample of requirements, define 5-10 top-level category names. Return ONLY valid JSON with no markdown: { \"l1Categories\": [{ \"en\": \"...\", \"de\": \"...\" }] }"
          },
          {
            role: "user",
            content: `Document: ${documentContext}\n\nSample requirements:\n${sampleList}\n\nDefine 5-10 L1 category names for this tender.`
          }
        ], { maxTokens: 800 });

        const parsed = parseJsonResponse<any>(taxonomyResponse.content);
        const categories: Array<{ en: string; de: string }> = parsed.l1Categories ?? [];

        if (categories.length >= 3) {
          l1Constraint = `\n\nCRITICAL: You MUST assign every requirement to one of these exact L1 categories. Do not invent new ones:\n${categories.map(c => `- "${c.en}" / "${c.de ?? c.en}"`).join("\n")}`;
          log.info(
            { l1Count: categories.length, categories: categories.map(c => c.en) },
            "Phase 1: L1 taxonomy established"
          );
        } else {
          log.warn("Phase 1: taxonomy too small - batches will use free form L1s");
        }
      } catch (err) {
        log.warn({ err }, "Phase 1: taxonomy call failed - batches will use free form L1s");
      }

      // PHASE 2: Assign requirements to hierarchy using the fixed taxonomy.
      // Each batch receives the L1 constraint so all batches produce the same
      // L1 names, making the merge by key reliable.
      const l1Map = new Map<string, { l1Label: Record<string, string>; l2Groups: Array<{ l2Label: Record<string, string>; requirementIds: string[] }> }>();

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        log.info({ batch: i + 1, of: batches.length, reqs: batch.length }, "Hierarchy batch");

        const userPrompt = buildHierarchyUserPrompt(batch, documentContext) + l1Constraint;
        const response = await callLLM([
          { role: "system", content: HIERARCHY_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ], { maxTokens: 8192 });

        let batchResult: z.infer<typeof HierarchyAssignmentSchema>;
        try {
          const parsed = parseJsonResponse<unknown>(response.content);
          batchResult = HierarchyAssignmentSchema.parse(parsed);
        } catch (err) {
          log.error({ batch: i + 1, err }, "Hierarchy batch failed - skipping");
          continue;
        }

        // Merge into l1Map: key is lowercase English label for reliable matching
        for (const l1 of batchResult.tree) {
          const key = (l1.l1Label.en ?? l1.l1Label.de ?? "").toLowerCase().trim();
          if (!l1Map.has(key)) {
            l1Map.set(key, { l1Label: l1.l1Label, l2Groups: [] });
          }
          const existing = l1Map.get(key)!;
          for (const l2 of l1.l2Groups) {
            const l2Key = (l2.l2Label.en ?? l2.l2Label.de ?? "").toLowerCase().trim();
            const existingL2 = existing.l2Groups.find(g =>
              (g.l2Label.en ?? g.l2Label.de ?? "").toLowerCase().trim() === l2Key
            );
            if (existingL2) {
              existingL2.requirementIds.push(...l2.requirementIds);
            } else {
              existing.l2Groups.push({ ...l2 });
            }
          }
        }
      }

      return { tree: Array.from(l1Map.values()) };
    }
  );

  const reqById = new Map<string, CandidateRequirement>(
    requirements
      .filter((r) => r.requirementId)
      .map((r) => [r.requirementId!, r])
  );

  const assigned = new Set<string>();
  const placedReqIds = new Set<string>(); // deduplication across hierarchy batches
  let nodeCounter = 1;

  function makeNodeId(): string {
    return `NODE-${String(nodeCounter++).padStart(4, "0")}`;
  }

  const tree: ProcurementMatchDeliverable[] = [];

  for (const l1 of assignment.tree) {
    const l1deliverableArray: ProcurementMatchDeliverable[] = [];
    const l1ChunkIds = new Set<string>();

    for (const l2 of l1.l2Groups) {
      const l2deliverableArray: ProcurementMatchDeliverable[] = [];
      const l2ChunkIds = new Set<string>();

      for (const reqId of l2.requirementIds) {
        const req = reqById.get(reqId);
        if (!req) {
          log.warn({ reqId }, "Requirement ID in hierarchy not found - skipping");
          continue;
        }

        assigned.add(reqId);

        // Guard: skip if this requirement was already placed by a previous batch
        if (placedReqIds.has(reqId)) {
          log.warn({ reqId }, "Duplicate requirementId across hierarchy batches - skipping");
          continue;
        }
        placedReqIds.add(reqId);

        // L3 leaf: convert CandidateRequirement --> ProcurementMatchDeliverable
        const leaf: ProcurementMatchDeliverable = {
          requirementId: reqId,
          bulletPoint: req.bulletPoint.en ?? req.bulletPoint.de ?? (Object.values(req.bulletPoint)[0] as string) ?? "",
          description: req.description as Record<string, string>,
          priority: req.priority,
          confidence: req.confidence,
          equivalenceAllowed: req.equivalenceAllowed,
          fullfillable: req.fullfillable ? "yes" : "no",
          procurementDocumentChunkIdArray: req.sourceChunkIds,
          status: "waitingForAnalysis",
          aiReasoning: undefined,
          citedProductIdArray: [],
          citedPersonIdArray: [],
          workspaceDocumentChunkIdArray: [],
        };

        l2deliverableArray.push(leaf);
        req.sourceChunkIds.forEach((id) => l2ChunkIds.add(id));
        req.sourceChunkIds.forEach((id) => l1ChunkIds.add(id));
      }

      if (l2deliverableArray.length === 0) continue;

      // L2 node
      const l2Node: ProcurementMatchDeliverable = {
        requirementId: makeNodeId(),
        bulletPoint: l2.l2Label.en ?? l2.l2Label.de ?? (Object.values(l2.l2Label)[0] as string) ?? "",
        description: l2.l2Label as Record<string, string>,
        priority: escalatePriority(l2deliverableArray),
        confidence: conservativeConfidence(l2deliverableArray),
        equivalenceAllowed: null,
        fullfillable: "yes",
        procurementDocumentChunkIdArray: Array.from(l2ChunkIds),
        status: "waitingForAnalysis",
        citedProductIdArray: [],
        citedPersonIdArray: [],
        workspaceDocumentChunkIdArray: [],
        deliverableArray: l2deliverableArray,
      };

      l2deliverableArray.forEach((c) =>
        c.procurementDocumentChunkIdArray.forEach((id) => l2ChunkIds.add(id))
      );

      l1deliverableArray.push(l2Node);
    }

    if (l1deliverableArray.length === 0) continue;

    // L1 node
    const l1Node: ProcurementMatchDeliverable = {
      requirementId: makeNodeId(),
      bulletPoint: l1.l1Label.en ?? l1.l1Label.de ?? (Object.values(l1.l1Label)[0] as string) ?? "",
      description: l1.l1Label as Record<string, string>,
      priority: escalatePriority(l1deliverableArray),
      confidence: conservativeConfidence(l1deliverableArray),
      equivalenceAllowed: null,
      fullfillable: "yes",
      procurementDocumentChunkIdArray: Array.from(l1ChunkIds),
      status: "waitingForAnalysis",
      citedProductIdArray: [],
      citedPersonIdArray: [],
      workspaceDocumentChunkIdArray: [],
      deliverableArray: l1deliverableArray,
    };

    tree.push(l1Node);
  }

  const orphans = requirements.filter(
    (r) => r.requirementId && !assigned.has(r.requirementId!)
  );

  if (orphans.length > 0) {
    log.warn({ orphanCount: orphans.length }, "Orphaned requirements found - adding to Uncategorized");

    const orphanLeaves: ProcurementMatchDeliverable[] = orphans.map((req) => ({
      requirementId: req.requirementId!,
      bulletPoint: req.bulletPoint.en ?? req.bulletPoint.de ?? (Object.values(req.bulletPoint)[0] as string) ?? "",
      description: req.description as Record<string, string>,
      priority: req.priority,
      confidence: req.confidence,
      equivalenceAllowed: req.equivalenceAllowed,
      fullfillable: req.fullfillable ? "yes" : "no",
      procurementDocumentChunkIdArray: req.sourceChunkIds,
      status: "waitingForAnalysis" as const,
      citedProductIdArray: [],
      citedPersonIdArray: [],
      workspaceDocumentChunkIdArray: [],
    }));

    const orphanNode: ProcurementMatchDeliverable = {
      requirementId: makeNodeId(),
      bulletPoint: "Uncategorized",
      description: { en: "Requirements that could not be categorized", de: "Nicht kategorisierte Anforderungen" },
      priority: "should",
      confidence: "low",
      equivalenceAllowed: null,
      fullfillable: "yes",
      procurementDocumentChunkIdArray: orphanLeaves.flatMap((l) => l.procurementDocumentChunkIdArray),
      status: "waitingForAnalysis",
      citedProductIdArray: [],
      citedPersonIdArray: [],
      workspaceDocumentChunkIdArray: [],
      deliverableArray: [
        {
          requirementId: makeNodeId(),
          bulletPoint: "Uncategorized Requirements",
          description: { en: "Review needed", de: "Überprüfung erforderlich" },
          priority: "should",
          confidence: "low",
          equivalenceAllowed: null,
          fullfillable: "yes",
          procurementDocumentChunkIdArray: orphanLeaves.flatMap((l) => l.procurementDocumentChunkIdArray),
          status: "waitingForAnalysis",
          citedProductIdArray: [],
          citedPersonIdArray: [],
          workspaceDocumentChunkIdArray: [],
          deliverableArray: orphanLeaves,
        },
      ],
    };

    tree.push(orphanNode);
  }

  log.info(
    {
      l1Count: tree.length,
      l2Count: tree.reduce((s, l1) => s + (l1.deliverableArray?.length ?? 0), 0),
      l3Count: tree.reduce(
        (s, l1) =>
          s +
          (l1.deliverableArray?.reduce((s2, l2) => s2 + (l2.deliverableArray?.length ?? 0), 0) ?? 0),
        0
      ),
    },
    "Hierarchy built"
  );

  return tree;
}

function escalatePriority(
  nodes: ProcurementMatchDeliverable[]
): "must" | "should" | "optional" {
  if (nodes.some((n) => n.priority === "must")) return "must";
  if (nodes.some((n) => n.priority === "should")) return "should";
  return "optional";
}

function conservativeConfidence(
  nodes: ProcurementMatchDeliverable[]
): "high" | "medium" | "low" {
  if (nodes.some((n) => n.confidence === "low")) return "low";
  if (nodes.some((n) => n.confidence === "medium")) return "medium";
  return "high";
}