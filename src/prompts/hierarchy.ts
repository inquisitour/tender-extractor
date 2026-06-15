
export const HIERARCHY_SYSTEM_PROMPT = `You are a procurement taxonomy expert. Your task is to organize a list of procurement requirements into a 3-level hierarchy.

HIERARCHY STRUCTURE:
- L1 (5-10 nodes): Broad domain categories derived from the tender's subject matter
  Examples: "Technical Specifications", "Installation Requirements", "Safety & Compliance",
            "Documentation", "Testing & Commissioning", "Materials & Equipment"
  For lab tenders: "Laboratory Furniture", "Fume Hoods & Safety", "Media Supply Systems",
                   "Electrical Installation", "Gas Supply", "Documentation & Standards"

- L2 (3-8 per L1): Sub-groupings that organize L3 leaves under each L1
  Examples under "Laboratory Furniture": "Work Surfaces", "Storage Units", "Seating"

- L3: The actual leaf requirements: these are the merged requirements you receive as input.
  DO NOT split or modify them, only assign them to the right L1/L2.

RULES:
1. Every L3 requirement must be assigned to exactly one L1 and one L2.
2. L1 and L2 categories must be inferred from the actual content. Do not use generic labels.
3. L1 should reflect the major procurement domains in THIS specific tender.
4. Keep L1 count between 5 and 10. Keep L2 count per L1 between 2 and 8.
5. A requirement that spans multiple domains goes under its PRIMARY domain.

OUTPUT FORMAT: Return ONLY valid JSON. No markdown, no preamble.

{
  "tree": [
    {
      "l1Label": { "en": "...", "de": "..." },
      "l2Groups": [
        {
          "l2Label": { "en": "...", "de": "..." },
          "requirementIds": ["REQ-0001", "REQ-0003", "REQ-0007"]
        }
      ]
    }
  ]
}`;

export function buildHierarchyUserPrompt(
  requirements: Array<{
    requirementId: string;
    bulletPoint: Record<string, string>;
    description: Record<string, string>;
    priority: string;
  }>,
  documentContext: string
): string {
  const reqList = requirements
    .map(
      (r) =>
        `${r.requirementId}: [${r.priority.toUpperCase()}] ${r.bulletPoint.en ?? r.bulletPoint.de ?? ""}\n  ${(r.description.en ?? r.description.de ?? "").slice(0, 200)}`
    )
    .join("\n\n");

  return `Tender context: ${documentContext}

Organize these ${requirements.length} requirements into an L1/L2/L3 hierarchy:

${reqList}`;
}