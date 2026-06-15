import type { RawChunk, GraphNode } from "../types/procurement.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("documentGraph");

export class DocumentGraph {
  private nodes: Map<string, GraphNode> = new Map();

  // build: constructs the graph from resolved chunks
  build(chunks: RawChunk[]): void {
    log.info({ chunkCount: chunks.length }, "Building document graph");

    // Create nodes
    for (const chunk of chunks) {
      this.nodes.set(chunk.chunkId, {
        chunkId: chunk.chunkId,
        chunk,
        neighbors: [...chunk.referencesChunkIds, ...chunk.referencedByChunkIds],
      });
    }

    // Add adjacency edges: chunks on consecutive pages in the same section are likely related
    const chunksBySection = new Map<string, RawChunk[]>();
    for (const chunk of chunks) {
      if (chunk.sectionRef) {
        const key = `${chunk.documentName}:${chunk.sectionRef}`;
        if (!chunksBySection.has(key)) chunksBySection.set(key, []);
        chunksBySection.get(key)!.push(chunk);
      }
    }

    let adjacencyEdges = 0;
    for (const sectionChunks of chunksBySection.values()) {
      // Sort by page number
      sectionChunks.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0));

      // Link consecutive chunks in the same section
      for (let i = 0; i < sectionChunks.length - 1; i++) {
        const curr = sectionChunks[i];
        const next = sectionChunks[i + 1];

        // Skip if pages are far apart (likely different clauses)
        if (
          curr.pageNumber !== undefined &&
          next.pageNumber !== undefined &&
          next.pageNumber - curr.pageNumber > 5
        ) {
          continue;
        }

        const currNode = this.nodes.get(curr.chunkId);
        const nextNode = this.nodes.get(next.chunkId);

        if (currNode && !currNode.neighbors.includes(next.chunkId)) {
          currNode.neighbors.push(next.chunkId);
          adjacencyEdges++;
        }
        if (nextNode && !nextNode.neighbors.includes(curr.chunkId)) {
          nextNode.neighbors.push(curr.chunkId);
        }
      }
    }

    const totalEdges = Array.from(this.nodes.values()).reduce(
      (sum, n) => sum + n.neighbors.length,
      0
    );

    log.info(
      {
        totalNodes: this.nodes.size,
        totalEdges,
        adjacencyEdgesAdded: adjacencyEdges,
        avgNeighbors: (totalEdges / (this.nodes.size || 1)).toFixed(2),
      },
      "Document graph built"
    );
  }

  // getNode: retrieve a specific graph node
  getNode(chunkId: string): GraphNode | undefined {
    return this.nodes.get(chunkId);
  }

  // getNeighborChunks: returns the actual chunks for a node's neighbors (useful during consolidation)
  getNeighborChunks(chunkId: string): RawChunk[] {
    const node = this.nodes.get(chunkId);
    if (!node) return [];

    return node.neighbors
      .map((id) => this.nodes.get(id)?.chunk)
      .filter((c): c is RawChunk => c !== undefined);
  }

  // getAllChunks: returns all chunks in the graph
  getAllChunks(): RawChunk[] {
    return Array.from(this.nodes.values()).map((n) => n.chunk);
  }

  // getChunkById: direct chunk lookup
  getChunkById(chunkId: string): RawChunk | undefined {
    return this.nodes.get(chunkId)?.chunk;
  }

  // stats: graph summary for logging
  stats() {
    const nodes = Array.from(this.nodes.values());
    const isolated = nodes.filter((n) => n.neighbors.length === 0).length;
    const wellConnected = nodes.filter((n) => n.neighbors.length >= 3).length;

    return {
      totalNodes: nodes.length,
      isolatedNodes: isolated,
      wellConnectedNodes: wellConnected,
      maxDegree: Math.max(...nodes.map((n) => n.neighbors.length)),
    };
  }
}