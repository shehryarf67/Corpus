/**
 * TEMPORARY placeholder data — there's no API wired up yet.
 *
 * The shape deliberately mirrors what the backend already stores, so
 * swapping this for a real fetch is mostly mechanical:
 *   - id / title / filename / uploadedAt  → the `documents` table
 *   - status                              → `jobs.status`, since ingestion
 *                                           runs asynchronously in worker.ts
 *   - chunkCount                          → count of rows in `chunks`
 *   - questionCount / lastAskedAt         → `messages` where role='user',
 *                                           joined through `conversations`
 *                                           (Conversations.getByDocumentId
 *                                           and Messages already exist)
 *
 * `status` matters for the UI, not just bookkeeping: a document isn't
 * chattable until its ingestion job reaches `done`, so rows that are still
 * indexing (or failed) must not link into the workspace.
 */
export type DocumentStatus = "ready" | "indexing" | "failed";

export type MockDocument = {
  id: string;
  title: string;
  filename: string;
  status: DocumentStatus;
  chunkCount: number;
  pageCount: number;
  uploadedAt: string;
  /** How many questions have been asked of this document. */
  questionCount: number;
  /** ISO timestamp of the most recent question, or null if never asked. */
  lastAskedAt: string | null;
  /**
   * Why ingestion failed — `jobs.error`, already recorded by the worker.
   * Null unless status is "failed".
   */
  error: string | null;
};

/**
 * One of each status, so every row treatment is visible while designing —
 * including a ready document nobody has asked anything yet, since that's the
 * state right after indexing finishes.
 */
export const MOCK_DOCUMENTS: MockDocument[] = [
  {
    id: "joint-pruning-quantization",
    title: "Joint Pruning and Quantization at Scale",
    filename: "joint-pruning-quantization.pdf",
    status: "ready",
    chunkCount: 2341,
    pageCount: 4,
    uploadedAt: "2026-08-02",
    questionCount: 6,
    lastAskedAt: "2026-08-07T08:30:00Z",
    error: null,
  },
  {
    id: "mixed-precision-bert",
    title: "Automatic Mixed-Precision Quantization Search of BERT",
    filename: "mixed-precision-bert.pdf",
    status: "ready",
    chunkCount: 1876,
    pageCount: 9,
    uploadedAt: "2026-07-28",
    questionCount: 12,
    lastAskedAt: "2026-08-05T14:10:00Z",
    error: null,
  },
  {
    id: "hybrid-retrieval-notes",
    title: "Notes on Hybrid Retrieval and Reciprocal Rank Fusion",
    filename: "hybrid-retrieval-notes.pdf",
    status: "ready",
    chunkCount: 512,
    pageCount: 3,
    uploadedAt: "2026-08-06",
    questionCount: 0,
    lastAskedAt: null,
    error: null,
  },
  {
    id: "sparse-attention-survey",
    title: "A Survey of Sparse Attention Mechanisms",
    filename: "sparse-attention-survey.pdf",
    status: "indexing",
    chunkCount: 0,
    pageCount: 22,
    uploadedAt: "2026-08-07",
    questionCount: 0,
    lastAskedAt: null,
    error: null,
  },
  {
    id: "scanned-notes",
    title: "Scanned Lab Notes",
    filename: "scanned-notes.pdf",
    status: "failed",
    chunkCount: 0,
    pageCount: 0,
    uploadedAt: "2026-08-05",
    questionCount: 0,
    lastAskedAt: null,
    // Realistic for this pipeline: extract.ts finds no upright text runs in a
    // scanned PDF, so there's nothing to chunk. OCR is on the roadmap.
    error: "no extractable text — this looks like a scan",
  },
];

export function findMockDocument(id: string): MockDocument | undefined {
  return MOCK_DOCUMENTS.find((document) => document.id === id);
}
