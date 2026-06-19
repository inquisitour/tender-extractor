import { z } from "zod";

export const LocaleObjectSchema = z.record(z.string().min(1), z.string());
export type LocaleObject<T extends string = string> = Record<string, T>;

// Priority: must / should / optional
export const PrioritySchema = z.enum(["must", "should", "optional"]);
export type Priority = z.infer<typeof PrioritySchema>;

// Status: workflow state of a deliverable
export const StatusSchema = z.enum([
  "waitingForAnalysis",
  "waitingForAnswer",
  "waitingForAnswerPropagation",
  "waitingForReview",
  "userDefined",
]);
export type Status = z.infer<typeof StatusSchema>;
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

// DocumentChunk: a resolved reference to a source passage
// Assigned during ingestion; referenced throughout the pipeline
export const DocumentChunkSchema = z.object({
  chunkId: z.string(),         
  documentName: z.string(),    // source filename
  pageNumber: z.number().int().positive().optional(),
  sectionRef: z.string().optional(), 
  textSnippet: z.string(),     // the actual text chunk contains
});
export type DocumentChunk = z.infer<typeof DocumentChunkSchema>;

export const ProcurementMatchDeliverableSchema: z.ZodType<ProcurementMatchDeliverable> =
  z.lazy(() =>
    z.object({
      // Unique requirement ID: assigned at candidate extraction stage
      requirementId: z.string(),

      // Short display label
      bulletPoint: z.string(),

      // Full description of what the requirement entails
      description: LocaleObjectSchema,

      // Obligation level: drives completeness checking
      priority: PrioritySchema,

      // How certain we are
      confidence: ConfidenceSchema,

      // Whether the buyer accepts equivalent alternatives
      equivalenceAllowed: z.boolean().nullable(),

      // Whether this requirement is technically fulfillable
      fullfillable: z.enum(["yes", "no", "maybe"]).nullable(),

      // All chunk IDs that together constitute the requirement
      procurementDocumentChunkIdArray: z
        .array(z.string())
        .min(1, "Every leaf must have at least one source chunk"),

      // Workflow state: managed externally, not by extraction
      status: StatusSchema,

      // LLM reasoning trace: for auditability
      aiReasoning: LocaleObjectSchema.nullable(),

      // Human review feedback: set externally
      feedback: z.enum(["good", "bad"]).nullable().optional(),
      feedbackText: z.string().nullable().optional(),

      // Linked open question ID: set externally
      openQuestionId: z.string().optional(),

      // Product / person citations: set externally during matching phase
      citedProductIdArray: z.array(z.string()),
      citedPersonIdArray: z.array(z.string()),

      // Workspace doc chunks (supplier docs): set externally
      workspaceDocumentChunkIdArray: z.array(z.string()),

      // deliverableArray: present at L1 and L2, absent at L3 (leaf nodes)
      deliverableArray: z.array(z.lazy(() => ProcurementMatchDeliverableSchema)).optional(),
    })
  );

export type ProcurementMatchDeliverable = {
  requirementId: string;
  bulletPoint: string;
  description: LocaleObject;
  priority: Priority;
  confidence: Confidence;
  equivalenceAllowed: boolean | null;
  fullfillable: "yes" | "no" | "maybe" | null;
  procurementDocumentChunkIdArray: string[];
  status: Status;
  aiReasoning : LocaleObject | null;
  feedback?: "good" | "bad" | null;
  feedbackText?: string | null;
  openQuestionId?: string;
  citedProductIdArray: string[];
  citedPersonIdArray: string[];
  workspaceDocumentChunkIdArray: string[];
  deliverableArray?: ProcurementMatchDeliverable[];
};

// ExtractionOutput: the top level JSON output of the pipeline
export const ExtractionOutputSchema = z.object({
  // Source document metadata
  sourceDocuments: z.array(
    z.object({
      filename: z.string(),
      totalPages: z.number().int().nonnegative(),
      totalChunks: z.number().int().nonnegative(),
      language: z.string().optional(), // e.g. "de", "en"
    })
  ),

  // Processing metadata
  processedAt: z.string().datetime(),
  pipelineVersion: z.string(),

  // The tree: L1 nodes at the top level, each with L2 deliverableArray, each L2 with L3 leaf deliverableArray
  tree: z.array(ProcurementMatchDeliverableSchema),

  // Summary statistics
  stats: z.object({
    totalL1Nodes: z.number().int().nonnegative(),
    totalL2Nodes: z.number().int().nonnegative(),
    totalL3Leaves: z.number().int().nonnegative(),
    totalChunksReferenced: z.number().int().nonnegative(),
    averageChunksPerLeaf: z.number(),
    confidenceDistribution: z.object({
      high: z.number().int().nonnegative(),
      medium: z.number().int().nonnegative(),
      low: z.number().int().nonnegative(),
    }),
  }),
});

export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

// Internal pipeline types:

// A raw chunk produced by ingestion, before any requirement extraction
export interface RawChunk {
  chunkId: string;
  documentName: string;
  pageNumber?: number;
  sectionRef?: string;
  text: string;
  // Bidirectional reference links, populated by referenceResolver
  referencesChunkIds: string[];
  referencedByChunkIds: string[];
}

// A candidate requirement produced by the LLM extraction step
// Before merging: may duplicate requirements described in multiple places
export interface CandidateRequirement {
  candidateId: string;      
  requirementId?: string;   // assigned after merging: REQ-0001...
  bulletPoint: LocaleObject;
  description: LocaleObject;
  priority: Priority;
  confidence: Confidence;
  equivalenceAllowed: boolean;
  fullfillable: boolean;
  sourceChunkIds: string[];  // which chunks this was extracted from
  embedding?: number[];      // set by embedder, used for merging
}

// The document graph node
export interface GraphNode {
  chunkId: string;
  chunk: RawChunk;
  neighbors: string[]; // chunkIds of semantically/structurally linked chunks
}