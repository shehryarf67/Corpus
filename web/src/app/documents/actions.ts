"use server";

import { revalidatePath } from "next/cache";
import { uploadDocument } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import type { UploadDocumentActionState } from "./upload-types";

const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;
const PDF_MIME_TYPE = "application/pdf";

function errorState(error: string): UploadDocumentActionState {
  return {
    error,
    documentId: null,
    jobId: null,
    status: null,
  };
}

export async function uploadDocumentAction(
  _previousState: UploadDocumentActionState,
  formData: FormData,
): Promise<UploadDocumentActionState> {
  const file = formData.get("file");
  const titleValue = formData.get("title");

  if (!(file instanceof File)) {
    return errorState("Choose a PDF to upload.");
  }

  if (file.size === 0) {
    return errorState("The selected PDF is empty.");
  }

  if (file.type !== PDF_MIME_TYPE) {
    return errorState("Only PDF files are supported.");
  }

  if (file.size > MAX_PDF_SIZE_BYTES) {
    return errorState("The PDF must be 20 MB or smaller.");
  }

  if (titleValue !== null && typeof titleValue !== "string") {
    return errorState("The document title must be text.");
  }

  const title = titleValue?.trim() || undefined;

  try {
    // This calls the frontend API wrapper, which forwards the session cookie
    // and sends multipart FormData to Hono's POST /documents route.
    const result = await uploadDocument(file, title);

    // Hono has now created the document and pending job. Invalidate the
    // library so its next render includes the newly accepted document.
    revalidatePath("/documents");

    return {
      error: null,
      documentId: result.documentId,
      jobId: result.jobId,
      status: result.status,
    };
  } catch (error) {
    // Expected backend failures become form state instead of an error page.
    if (error instanceof ApiError) return errorState(error.message);

    console.error("document upload action failed", error);
    return errorState("The document could not be uploaded. Please try again.");
  }
}
