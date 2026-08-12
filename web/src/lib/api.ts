import { cookies } from "next/headers";
import { ApiError } from "./api-error";

/**
 * This type represents exactly what the backend returns from:
 *
 * GET /jobs/:jobId
 *
 * The frontend should match the backend response shape instead of inventing
 * its own version of the data.
 */
// These values match the backend JobStatus union. `null` means the document
// currently has no ingestion job, not that the frontend failed to parse it.
export type DocumentJobStatus =
  | "pending"
  | "parsing"
  | "embedding"
  | "done"
  | "failed";

export type JobResponse = {
  jobId: string;
  documentId: string;
  type: string;
  status: DocumentJobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The shared public contract returned by both document GET endpoints. */
export type DocumentResponse = {
  id: string;
  title: string;
  filename: string;
  mimeType: string;
  uploadedAt: string;
  status: DocumentJobStatus | null;
  error: string | null;
  chunkCount: number;
  pageCount: number;
};

export type DocumentsResponse = {
  documents: DocumentResponse[];
};

export type SingleDocumentResponse = {
  document: DocumentResponse;
};

/** POST /documents accepts the upload and queues ingestion in the background. */
export type UploadDocumentResponse = {
  documentId: string;
  jobId: string;
  status: DocumentJobStatus;
};

export async function requestRaw(
  path: string, // Only necessary route e.g /jobs/123
  options: RequestInit = {}, // Second arg for fetch options, e.g. method, headers, body
): Promise<Response> {
    // Provide the whole URL to baseUrl, so that the fetch request can be made to the correct endpoint. 
    // The base URL is expected to be set in the environment variable API_BASE_URL. 
    // If it's not set, an error is thrown to indicate that the configuration is missing.
  const baseUrl = process.env.API_BASE_URL;

  // Check so that if anyone else clones Corpus, there is a check for their env
  if (!baseUrl) {
    // Not an ApiError as this is a config error, not api response
    throw new Error("API_BASE_URL is not configured");
  }

  // So that Next can send the cookie to Hono
  const cookieStore = await cookies();

  // Allows to take whatever header the caller provided
  const headers = new Headers(options.headers);

  // Serialized representation of the cookies in the request, which is then set in the headers for the fetch request.
  const cookieHeader = cookieStore.toString();

  if (cookieHeader) {
    // Only one value for this header, replace if existing
    headers.set("Cookie", cookieHeader);
  }

  // Building the actual request
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    // cache written later as latermost wins, so if cache forced elsewhere, this declaration
    // allows to override it and force no caching for API requests, which is important for dynamic data.
    // No store used as variables change dynamically and we want to ensure that the latest data is always 
    // fetched from the server, rather than relying on potentially stale cached responses.
    cache: "no-store",
  });

    // Needed as fetch doesnt throw errors itself 
  if (!response.ok) {
    let message = `API request failed with status ${response.status}`;

    try {
        // unknown makes us prove what type the response is instead of allowing any insane stuff
      const body: unknown = await response.json();

      // Just check how the response looks like and whether it's a string
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
      ) {
        message = body.error;
      }
    } catch {
      // Response was empty or was not JSON.
    }

    // Now return ApiError after data collected
    throw new ApiError(response.status, message);
  }

  return response;
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await requestRaw(path, options);

  // The caller supplies T because it knows the response shape for this route.
  return (await response.json()) as T;
}


export function getJob(jobId: string): Promise<JobResponse> {
  return request<JobResponse>(`/jobs/${jobId}`);
}

/** Load every document owned by the authenticated user. */
export function getDocuments(): Promise<DocumentsResponse> {
  return request<DocumentsResponse>("/documents");
}

/** Load one owned document; request() preserves the backend 404 as ApiError. */
export function getDocument(
  documentId: string,
): Promise<SingleDocumentResponse> {
  // Encoding keeps an accidental slash or other reserved character inside the
  // path parameter instead of allowing it to change the requested route.
  return request<SingleDocumentResponse>(
    `/documents/${encodeURIComponent(documentId)}`,
  );
}

/** Upload one PDF and receive the pending ingestion job created by Hono. */
export function uploadDocument(
  file: File,
  title?: string,
): Promise<UploadDocumentResponse> {
  const formData = new FormData();
  formData.append("file", file);

  if (title !== undefined) {
    formData.append("title", title);
  }

  return request<UploadDocumentResponse>("/documents", {
    method: "POST",
    body: formData,
    // Do not set Content-Type manually. fetch adds multipart/form-data plus
    // the unique boundary Hono needs in order to parse this FormData body.
  });
}

/** Queue a fresh ingestion attempt for an owned document whose latest job failed. */
export function retryDocument(
  documentId: string,
): Promise<UploadDocumentResponse> {
  return request<UploadDocumentResponse>(
    `/documents/${encodeURIComponent(documentId)}/retry`,
    { method: "POST" },
  );
}
