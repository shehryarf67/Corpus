/**
 * TEMPORARY placeholder data — there's no API wired up yet.
 *
 * The shape deliberately mirrors what the backend already stores, so
 * swapping this for a real fetch is mostly mechanical:
 *   - id / title / filename / uploadedAt  → the `documents` table
 *   - status                              → `jobs.status`, since ingestion
 *                                           runs asynchronously in worker.ts
 *   - chunkCount                          → count of rows in `chunks`
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
};

/** One of each status, so every row treatment is visible while designing. */
export const MOCK_DOCUMENTS: MockDocument[] = [
  {
    id: "joint-pruning-quantization",
    title: "Joint Pruning and Quantization at Scale",
    filename: "joint-pruning-quantization.pdf",
    status: "ready",
    chunkCount: 2341,
    pageCount: 4,
    uploadedAt: "2026-08-02",
  },
  {
    id: "mixed-precision-bert",
    title: "Automatic Mixed-Precision Quantization Search of BERT",
    filename: "mixed-precision-bert.pdf",
    status: "ready",
    chunkCount: 1876,
    pageCount: 9,
    uploadedAt: "2026-07-28",
  },
  {
    id: "sparse-attention-survey",
    title: "A Survey of Sparse Attention Mechanisms",
    filename: "sparse-attention-survey.pdf",
    status: "indexing",
    chunkCount: 0,
    pageCount: 22,
    uploadedAt: "2026-08-07",
  },
  {
    id: "scanned-notes",
    title: "Scanned Lab Notes",
    filename: "scanned-notes.pdf",
    status: "failed",
    chunkCount: 0,
    pageCount: 0,
    uploadedAt: "2026-08-05",
  },
];

export function findMockDocument(id: string): MockDocument | undefined {
  return MOCK_DOCUMENTS.find((document) => document.id === id);
}
