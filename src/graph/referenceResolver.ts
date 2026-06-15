import type { RawChunk } from "../types/procurement.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("referenceResolver");

const OUTBOUND_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  // English annex references
  { pattern: /\bannex\s+[A-Z0-9]+/gi, type: "annex" },
  { pattern: /\bappendix\s+[A-Z0-9]+/gi, type: "appendix" },
  { pattern: /\bschedule\s+[A-Z0-9]+/gi, type: "schedule" },
  // German annex references
  { pattern: /\banhang\s+[A-Z0-9]+/gi, type: "annex_de" },
  { pattern: /\bbeilage\s+\d+/gi, type: "annex_de" },
  // Section cross references (German tender format)
  { pattern: /\b(?:gem\.|gemäß|lt\.|laut|siehe)\s+(?:pos\.|position)?\s*[A-Z]{0,2}[\d.]{5,}/gi, type: "section_ref" },
  // English section references
  { pattern: /\b(?:see|refer to|as per|per)\s+section\s+[\d.]+/gi, type: "section_ref" },
  // Position number references (Austrian tender style: GU.xx.xx.xx.xx)
  { pattern: /\b[A-Z]{1,2}\d+\.\d+\.\d+\.\d+\.\d+/g, type: "position_ref" },
  // "as described above/below"
  { pattern: /\b(?:as\s+described|wie\s+(?:oben|unter|beschrieben))\b/gi, type: "narrative_ref" },
  // Drawing/plan references
  { pattern: /\b(?:see\s+plan|lt\.\s+plan|grundrissplan|detailplan)\b/gi, type: "plan_ref" },
];

// Patterns that mark a chunk as an annex/appendix (potential target)
const ANNEX_HEADER_PATTERNS = [
  /^annex\s+[A-Z0-9]+/i,
  /^appendix\s+[A-Z0-9]+/i,
  /^anhang\s+[A-Z0-9]+/i,
  /^beilage\s+\d+/i,
  /^schedule\s+[A-Z0-9]+/i,
];

// detectOutboundReferences: returns reference labels found in a chunk
function detectOutboundReferences(chunk: RawChunk): string[] {
  const refs: string[] = [];
  for (const { pattern } of OUTBOUND_PATTERNS) {
    const matches = chunk.text.match(pattern);
    if (matches) {
      refs.push(...matches.map((m) => m.toLowerCase().trim()));
    }
  }
  return [...new Set(refs)]; // deduplicate
}

// isAnnexChunk: returns the annex label if this chunk is an annex header
function getAnnexLabel(chunk: RawChunk): string | null {
  const firstLine = chunk.text.split("\n")[0].trim();
  for (const pattern of ANNEX_HEADER_PATTERNS) {
    if (pattern.test(firstLine)) {
      return firstLine.toLowerCase().trim();
    }
  }
  return null;
}


export function resolveReferences(chunks: RawChunk[]): RawChunk[] {
  log.info({ totalChunks: chunks.length }, "Resolving cross-references");

  // Build lookup maps
  const annexMap = new Map<string, string>(); // label --> chunkId
  const sectionMap = new Map<string, string>(); // sectionRef --> chunkId

  for (const chunk of chunks) {
    // Index annexes
    const annexLabel = getAnnexLabel(chunk);
    if (annexLabel) {
      annexMap.set(annexLabel, chunk.chunkId);
    }

    // Index section refs
    if (chunk.sectionRef) {
      sectionMap.set(chunk.sectionRef.toLowerCase().trim(), chunk.chunkId);
    }
  }

  log.debug(
    { annexCount: annexMap.size, sectionCount: sectionMap.size },
    "Reference index built"
  );

  // Build a chunkId lookup
  const chunkById = new Map<string, RawChunk>(
    chunks.map((c) => [c.chunkId, c])
  );

  let totalLinksCreated = 0;

  for (const chunk of chunks) {
    const outboundRefs = detectOutboundReferences(chunk);
    if (outboundRefs.length === 0) continue;

    for (const ref of outboundRefs) {
      // Try to resolve: annex reference?
      let targetChunkId: string | undefined;

      // Check annex map
      for (const [label, id] of annexMap) {
        if (ref.includes(label) || label.includes(ref)) {
          targetChunkId = id;
          break;
        }
      }

      // Check section map
      if (!targetChunkId) {
        for (const [section, id] of sectionMap) {
          if (ref.includes(section) || section.includes(ref)) {
            targetChunkId = id;
            break;
          }
        }
      }

      if (targetChunkId && targetChunkId !== chunk.chunkId) {
        const target = chunkById.get(targetChunkId);
        if (!target) continue;

        // Forward link: this chunk references target
        if (!chunk.referencesChunkIds.includes(targetChunkId)) {
          chunk.referencesChunkIds.push(targetChunkId);
        }

        // Backward link: target is referenced by this chunk
        if (!target.referencedByChunkIds.includes(chunk.chunkId)) {
          target.referencedByChunkIds.push(chunk.chunkId);
        }

        totalLinksCreated++;
      }
    }
  }

  log.info(
    {
      totalLinksCreated,
      chunksWithOutboundRefs: chunks.filter((c) => c.referencesChunkIds.length > 0).length,
      chunksWithInboundRefs: chunks.filter((c) => c.referencedByChunkIds.length > 0).length,
    },
    "Cross-references resolved"
  );

  return chunks;
}