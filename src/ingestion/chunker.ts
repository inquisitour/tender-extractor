import type { ParsedDocument } from "./pdfParser.js";
import type { RawChunk } from "../types/procurement.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chunker");

const MIN_CHUNK_CHARS = 150;
const MAX_CHUNK_CHARS = 1200;

// Patterns that signal a new section/requirement boundary
const SECTION_PATTERNS = [
  // Austrian/German tender position numbers: GU.07.01.01.01, G0.09.24.02.01
  /^[A-Z]{1,2}[\d.]+[\d]+\.[\d]+/,
  // Position numbers like 00.00.00.00.01
  /^\d{2}\.\d{2}\.\d{2}/,
  // Numbered list items
  /^\d+\.\s+[A-ZÜÄÖ]/,
  // ALL CAPS section headings
  /^[A-ZÜÄÖ\s]{5,}$/,
];

function isSectionBoundary(line: string): boolean {
  const trimmed = line.trim();
  return SECTION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// chunkDocument: takes a ParsedDocument and returns RawChunks
export function chunkDocument(doc: ParsedDocument): RawChunk[] {
  const chunks: RawChunk[] = [];
  // Use document filename prefix for chunk IDs: "salzburg-chunk-0001"
  const docPrefix = doc.filename
    .replace(/\.[^.]+$/, "") // strip extension
    .replace(/[^a-zA-Z0-9]/g, "-")
    .toLowerCase()
    .slice(0, 20);

  let chunkIndex = 0;

  function pushChunk(
    text: string,
    pageNumber: number,
    sectionRef?: string
  ): void {
    if (text.trim().length < MIN_CHUNK_CHARS) return; // too short, skip

    const chunkId = `${docPrefix}-chunk-${String(chunkIndex).padStart(4, "0")}`;
    chunks.push({
      chunkId,
      documentName: doc.filename,
      pageNumber,
      sectionRef,
      text: text.trim(),
      referencesChunkIds: [],   // filled by referenceResolver
      referencedByChunkIds: [], // filled by referenceResolver
    });
    chunkIndex++;
  }

  for (const page of doc.pages) {
    const lines = page.text.split("\n");
    let currentChunk = "";
    let currentSection: string | undefined;
    let sectionStartPage = page.pageNumber;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isSectionBoundary(trimmed)) {
        // Flush current chunk before starting a new section
        if (currentChunk.length >= MIN_CHUNK_CHARS) {
          pushChunk(currentChunk, sectionStartPage, currentSection);
        }
        currentSection = trimmed.slice(0, 60); // store section ref
        currentChunk = trimmed + "\n";
        sectionStartPage = page.pageNumber;
      } else {
        currentChunk += line + "\n";

        // Flush if hit max size, but only at a sentence boundary
        if (currentChunk.length >= MAX_CHUNK_CHARS) {
          // Find last sentence end
          const lastPeriod = Math.max(
            currentChunk.lastIndexOf(". "),
            currentChunk.lastIndexOf(".\n")
          );

          if (lastPeriod > MIN_CHUNK_CHARS) {
            // Split at sentence boundary
            const toFlush = currentChunk.slice(0, lastPeriod + 1);
            const remainder = currentChunk.slice(lastPeriod + 1);
            pushChunk(toFlush, sectionStartPage, currentSection);
            currentChunk = remainder;
            sectionStartPage = page.pageNumber;
          } else {
            // No good split point: flush whole thing
            pushChunk(currentChunk, sectionStartPage, currentSection);
            currentChunk = "";
            sectionStartPage = page.pageNumber;
          }
        }
      }
    }

    // Flush remaining content at end of page
    if (currentChunk.length >= MIN_CHUNK_CHARS) {
      pushChunk(currentChunk, sectionStartPage, currentSection);
      currentChunk = "";
    }
  }

  log.info(
    {
      document: doc.filename,
      totalChunks: chunks.length,
      avgChunkLength: Math.round(
        chunks.reduce((s, c) => s + c.text.length, 0) / (chunks.length || 1)
      ),
    },
    "Document chunked"
  );

  return chunks;
}

// chunkDocuments: chunks multiple documents, returns flat chunk array
export function chunkDocuments(docs: ParsedDocument[]): RawChunk[] {
  const allChunks: RawChunk[] = [];
  for (const doc of docs) {
    const chunks = chunkDocument(doc);
    allChunks.push(...chunks);
  }
  log.info({ totalChunks: allChunks.length }, "All documents chunked");
  return allChunks;
}