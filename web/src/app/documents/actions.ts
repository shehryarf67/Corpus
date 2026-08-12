"use server";

import { revalidatePath } from "next/cache";
import { getJob, retryDocument, uploadDocument } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import type {
  JobStatusActionResult,
  UploadDocumentActionState,
} from "./upload-types";

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

export async function getJobStatusAction(
  jobId: string,
): Promise<JobStatusActionResult> {
  if (!jobId.trim()) {
    return { job: null, error: "A job ID is required." };
  }

  try {
    // Keep the HttpOnly cookie on the server: getJob() forwards it to Hono's
    // authenticated GET /jobs/:jobId endpoint on behalf of the Client Component.
    const job = await getJob(jobId);

    // Make the terminal refresh fetch a newly rendered document card even if
    // this poll crossed a Next route-cache boundary.
    if (job.status === "done" || job.status === "failed") {
      revalidatePath("/documents");
    }

    return { job, error: null };
  } catch (error) {
    if (error instanceof ApiError) {
      return { job: null, error: error.message };
    }

    console.error(`job status check failed for ${jobId}`, error);
    return { job: null, error: "Could not check the ingestion status." };
  }
}

export async function retryDocumentAction(
  documentId: string,
): Promise<UploadDocumentActionState> {
  if (!documentId.trim()) return errorState("A document ID is required.");

  try {
    const result = await retryDocument(documentId);
    revalidatePath("/documents");

    return {
      error: null,
      documentId: result.documentId,
      jobId: result.jobId,
      status: result.status,
    };
  } catch (error) {
    if (error instanceof ApiError) return errorState(error.message);

    console.error(`document retry failed for ${documentId}`, error);
    return errorState("The document could not be retried. Please try again.");
  }
}
