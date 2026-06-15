import path from "path";
import fs from "fs";
import "dotenv/config";

import { createLogger, withTiming } from "./utils/logger.js";
import { parseMultiplePdfs } from "./ingestion/pdfParser.js";
import { chunkDocuments } from "./ingestion/chunker.js";
import { resolveReferences } from "./graph/referenceResolver.js";
import { DocumentGraph } from "./graph/documentGraph.js";
import { extractCandidates } from "./extraction/candidateExtractor.js";
import { mergeRequirements } from "./extraction/requirementMerger.js";
import { buildHierarchy } from "./extraction/hierarchyBuilder.js";
import { validateOutput } from "./validation/invariantChecker.js";
import { runSpotCheck } from "./evaluation/spotCheck.js";
import type { ExtractionOutput } from "./types/procurement.js";

const log = createLogger("main");

const OUTPUT_DIR = path.resolve(process.cwd(), "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--spot-check")) {
    const outputFile = args.find((a) => a.endsWith(".json"));
    if (!outputFile) {
      log.error("Usage: --spot-check <output-file.json>");
      process.exit(1);
    }
    await runSpotCheckMode(outputFile);
    return;
  }

  const pdfPaths = args.filter((a) => a.endsWith(".pdf"));
  if (pdfPaths.length === 0) {
    log.error("Usage: npx tsx src/main.ts <file1.pdf> [file2.pdf] ...");
    process.exit(1);
  }

  for (const p of pdfPaths) {
    if (!fs.existsSync(p)) {
      log.error({ path: p }, "PDF file not found");
      process.exit(1);
    }
  }

  log.info({ files: pdfPaths }, "Starting tender extraction pipeline");

  const result = await withTiming(log, "Full pipeline", async () => {
    const documents = await withTiming(log, "Step 1: Parse PDFs", () =>
      parseMultiplePdfs(pdfPaths)
    );

    const chunks = await withTiming(log, "Step 2: Chunk documents", async () =>
      chunkDocuments(documents)
    );

    const linkedChunks = await withTiming(log, "Step 3: Resolve references", async () =>
      resolveReferences(chunks)
    );

    const graph = new DocumentGraph();
    await withTiming(log, "Step 4: Build document graph", async () => {
      graph.build(linkedChunks);
    });
    log.info(graph.stats(), "Document graph stats");

    const primaryLanguage = documents[0]?.language ?? "en";
    const candidates = await withTiming(log, "Step 5: Extract candidates", () =>
      extractCandidates(graph, primaryLanguage)
    );

    const merged = await withTiming(log, "Step 6: Merge requirements", () =>
      mergeRequirements(candidates)
    );

    const documentContext = documents
      .map((d) => `${d.filename} (${d.totalPages} pages, language: ${d.language ?? "unknown"})`)
      .join(", ");

    const tree = await withTiming(log, "Step 7: Build hierarchy", () =>
      buildHierarchy(merged, graph, documentContext)
    );

    const allLeaves = collectLeaves(tree);
    const confidenceCounts = { high: 0, medium: 0, low: 0 };
    allLeaves.forEach((l) => confidenceCounts[l.confidence]++);

    const allReferencedChunks = new Set(
      allLeaves.flatMap((l) => l.procurementDocumentChunkIdArray)
    );

    const output: ExtractionOutput = {
      sourceDocuments: documents.map((d) => ({
        filename: d.filename,
        totalPages: d.totalPages,
        totalChunks: linkedChunks.filter((c) => c.documentName === d.filename).length,
        language: d.language,
      })),
      processedAt: new Date().toISOString(),
      pipelineVersion: "1.0.0",
      tree,
      stats: {
        totalL1Nodes: tree.length,
        totalL2Nodes: tree.reduce((s, l1) => s + (l1.deliverableArray?.length ?? 0), 0),
        totalL3Leaves: allLeaves.length,
        totalChunksReferenced: allReferencedChunks.size,
        averageChunksPerLeaf:
          allLeaves.length > 0
            ? allLeaves.reduce((s, l) => s + l.procurementDocumentChunkIdArray.length, 0) / allLeaves.length
            : 0,
        confidenceDistribution: confidenceCounts,
      },
    };

    const validation = await withTiming(log, "Step 9: Validate invariants", async () =>
      validateOutput(output, graph)
    );

    if (!validation.valid) {
      log.error({ errors: validation.errors }, "Invariant checks failed");
    }

    return output;
  });

  const outputFile = path.join(
    OUTPUT_DIR,
    `result_${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), "utf-8");

  log.info(
    {
      outputFile,
      l1: result.stats.totalL1Nodes,
      l2: result.stats.totalL2Nodes,
      l3: result.stats.totalL3Leaves,
      avgChunksPerLeaf: Number(result.stats.averageChunksPerLeaf).toFixed(2),
    },
    "Pipeline complete"
  );
}

async function runSpotCheckMode(outputFile: string): Promise<void> {
  const output: ExtractionOutput = JSON.parse(fs.readFileSync(outputFile, "utf-8"));

  // Reparse and rechunk the source documents to rebuild the graph
  const pdfPaths = output.sourceDocuments.map((d) => {
    // Look for the PDF in common locations
    const candidates = [
      `data/${d.filename}`,
      `${d.filename}`,
      `output/${d.filename}`,
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    log.warn({ filename: d.filename }, "Source PDF not found for spot check and chunks will show as unresolved");
    return null;
  }).filter((p): p is string => p !== null);

  const graph = new DocumentGraph();

  if (pdfPaths.length > 0) {
    const { parseMultiplePdfs } = await import("./ingestion/pdfParser.js");
    const { chunkDocuments } = await import("./ingestion/chunker.js");
    const { resolveReferences } = await import("./graph/referenceResolver.js");
    const documents = await parseMultiplePdfs(pdfPaths);
    const chunks = chunkDocuments(documents);
    const linked = resolveReferences(chunks);
    graph.build(linked);
    log.info({ chunks: linked.length }, "Graph rebuilt for spot check");
  }

  runSpotCheck(output, graph, 20);
}

function collectLeaves(tree: ExtractionOutput["tree"]): ExtractionOutput["tree"][0][] {
  const leaves: ExtractionOutput["tree"][0][] = [];
  function traverse(node: ExtractionOutput["tree"][0]): void {
    if (!node.deliverableArray || node.deliverableArray.length === 0) { leaves.push(node); return; }
    for (const child of node.deliverableArray) traverse(child);
  }
  for (const node of tree) traverse(node);
  return leaves;
}

main().catch((err) => {
  log.error({ err }, "Pipeline failed");
  process.exit(1);
});