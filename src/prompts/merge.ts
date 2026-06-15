
export const MERGE_SYSTEM_PROMPT = `You are a procurement analyst deciding whether two extracted requirements represent the SAME underlying obligation.

Two requirements are the SAME obligation if:
- They describe what the supplier must provide/do regarding the same thing
- One is a general statement and the other is a specific detail of the same requirement
- They appear in different sections/pages but clearly refer to the same deliverable
- One is in a preamble/general section and the other is a specific instance

Two requirements are DIFFERENT obligations if:
- They concern genuinely distinct deliverables or actions
- Merging them would conflate separate independent requirements
- They apply to different contexts, rooms, or components

IMPORTANT: When in doubt, MERGE. The brief requires consolidation: scattered references to the same requirement must become one leaf. It is better to over-merge than to create duplicate leaves.

OUTPUT FORMAT: Return ONLY valid JSON. No markdown, no explanation outside the JSON.

{
  "shouldMerge": true | false,
  "confidence": "high" | "medium" | "low",
  "reason": "One sentence explanation of your decision",
  "mergedBulletPoint": { "en": "...", "de": "..." },
  "mergedDescription": { "en": "...", "de": "..." },
  "mergedPriority": "must" | "should" | "optional",
  "mergedConfidence": "high" | "medium" | "low",
  "mergedEquivalenceAllowed": true | false
}

If shouldMerge is false, the mergedX fields can be empty strings.`;

export function buildMergeUserPrompt(
  reqA: {
    bulletPoint: Record<string, string>;
    description: Record<string, string>;
    priority: string;
    confidence: string;
    sourceChunkIds: string[];
  },
  reqB: {
    bulletPoint: Record<string, string>;
    description: Record<string, string>;
    priority: string;
    confidence: string;
    sourceChunkIds: string[];
  }
): string {
  return `REQUIREMENT A (chunks: ${reqA.sourceChunkIds.join(", ")}):
Label: ${reqA.bulletPoint.en ?? reqA.bulletPoint.de ?? ""}
Description: ${reqA.description.en ?? reqA.description.de ?? ""}
Priority: ${reqA.priority}

REQUIREMENT B (chunks: ${reqB.sourceChunkIds.join(", ")}):
Label: ${reqB.bulletPoint.en ?? reqB.bulletPoint.de ?? ""}
Description: ${reqB.description.en ?? reqB.description.de ?? ""}
Priority: ${reqB.priority}

Do these describe the same underlying procurement obligation?`;
}