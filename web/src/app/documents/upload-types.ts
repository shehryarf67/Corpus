import type { DocumentJobStatus } from "@/lib/api";

// One stable shape works as both useActionState's initial value and the result
// returned after validation, an API failure, or a successful upload.
export type UploadDocumentActionState = {
  error: string | null;
  documentId: string | null;
  jobId: string | null;
  status: DocumentJobStatus | null;
};
