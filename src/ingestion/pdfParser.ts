import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { createLogger, withTiming } from "../utils/logger.js";
import { loadFromCache, saveToCache } from "./cache.js";

const log = createLogger("pdfParser");

// ParsedPage: one page of a PDF with its text and page number
export interface ParsedPage {
  pageNumber: number;
  text: string;
}

// ParsedDocument: the result of parsing a single PDF
export interface ParsedDocument {
  filename: string;
  totalPages: number;
  pages: ParsedPage[];
  fullText: string;
  language?: string;
}

// parsePdf: uses pdftotext (poppler utils) for reliable text extraction
export async function parsePdf(filePath: string): Promise<ParsedDocument> {
  const filename = path.basename(filePath);
  const cacheKey = `parsed:${filename}`;

  const cached = await loadFromCache<ParsedDocument>(cacheKey);
  if (cached) {
    log.info({ filename, source: "cache" }, "PDF loaded from cache");
    return cached;
  }

  return withTiming(log, `Parse PDF: ${filename}`, async () => {
    const absPath = path.resolve(filePath);

    // Verify file exists
    if (!fs.existsSync(absPath)) {
      throw new Error(`PDF file not found: ${absPath}`);
    }

    // Get page count via pdfinfo
    let totalPages = 1;
    try {
      const info = execSync(`pdfinfo "${absPath}" 2>/dev/null`, {
        encoding: "utf-8",
      });
      const match = info.match(/Pages:\s+(\d+)/);
      if (match) totalPages = parseInt(match[1], 10);
    } catch {
      log.warn({ filename }, "pdfinfo failed, defaulting to 1 page");
    }

    log.info({ filename, totalPages }, "PDF page count determined");

    // Extract full text with layout preservation
    let fullText = "";
    try {
      fullText = execSync(`pdftotext -layout "${absPath}" -`, {
        encoding: "utf-8",
        maxBuffer: 100 * 1024 * 1024, // 100MB: handles large tenders like Salzburg
      });
    } catch (err) {
      throw new Error(`pdftotext failed for ${filename}: ${err}`);
    }

    log.info({ filename, chars: fullText.length }, "Text extracted");

    // Split into pages: pdftotext inserts \f (form feed) between pages
    const pageTexts = fullText.split("\f");

    const pages: ParsedPage[] = [];
    for (let i = 0; i < totalPages; i++) {
      pages.push({
        pageNumber: i + 1,
        text: (pageTexts[i] ?? "").trim(),
      });
    }

    // Simple language detection by counting function words
    const sampleText = fullText.slice(0, 2000).toLowerCase();
    const germanSignals = (
      sampleText.match(/\b(der|die|das|und|für|sind|mit|wird|werden)\b/g) ?? []
    ).length;
    const englishSignals = (
      sampleText.match(/\b(the|and|for|are|with|shall|must|will)\b/g) ?? []
    ).length;
    const language = germanSignals > englishSignals ? "de" : "en";

    log.info(
      { filename, language, germanSignals, englishSignals },
      "Language detected"
    );

    const parsed: ParsedDocument = {
      filename,
      totalPages,
      pages,
      fullText,
      language,
    };

    await saveToCache(cacheKey, parsed);
    return parsed;
  });
}

// parseMultiplePdfs: parses multiple PDFs, returns all results
export async function parseMultiplePdfs(
  filePaths: string[]
): Promise<ParsedDocument[]> {
  log.info({ count: filePaths.length }, "Parsing PDF files");
  const results: ParsedDocument[] = [];
  for (const filePath of filePaths) {
    results.push(await parsePdf(filePath));
  }
  log.info({ count: results.length }, "All PDFs parsed");
  return results;
}