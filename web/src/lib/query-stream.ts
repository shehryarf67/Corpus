export type QueryStreamStatus = "generating" | "finalizing";

export type QuerySource = {
  label: string;
  chunkId: string;
  documentId: string;
  pageNumber: number | null;
  content: string;
  highlightText?: string | null;
  similarity: number | null;
};

export type QueryStreamInput = {
  documentId: string;
  question: string;
  conversationId?: string;
};

export type QueryStreamResult = {
  conversationId: string;
  answer: string;
  sources: QuerySource[];
};

export type QueryStreamHandlers = {
  onConversation?: (conversationId: string) => void;
  onStatus?: (status: QueryStreamStatus) => void;
  onToken?: (text: string) => void;
  onDone?: (result: QueryStreamResult) => void;
  onError?: (message: string) => void;
};

type ServerStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "status"; status: QueryStreamStatus }
  | { type: "token"; text: string }
  | ({ type: "done" } & QueryStreamResult)
  | { type: "error"; message: string };

/** Convert one complete SSE block into the typed event sent by Hono. */
export function parseSseEvent(block: string): ServerStreamEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    // SSE comments begin with a colon and do not contain application data.
    if (!line || line.startsWith(":")) continue;

    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      // An SSE event may contain multiple data lines. They are joined before
      // parsing, following the SSE format instead of assuming one data line.
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return null;

  const data: unknown = JSON.parse(dataLines.join("\n"));
  if (typeof data !== "object" || data === null) {
    throw new Error("Query stream returned invalid event data");
  }

  // Hono puts the event type on the SSE `event:` line and the remaining
  // fields inside JSON `data:`. Combine them into one discriminated object.
  return { type: eventName, ...data } as ServerStreamEvent;
}

function dispatchEvent(
  event: ServerStreamEvent,
  handlers: QueryStreamHandlers,
): QueryStreamResult | null {
  switch (event.type) {
    case "conversation":
      handlers.onConversation?.(event.conversationId);
      return null;
    case "status":
      handlers.onStatus?.(event.status);
      return null;
    case "token":
      handlers.onToken?.(event.text);
      return null;
    case "done": {
      const result: QueryStreamResult = {
        conversationId: event.conversationId,
        answer: event.answer,
        sources: event.sources,
      };
      handlers.onDone?.(result);
      return result;
    }
    case "error":
      handlers.onError?.(event.message);
      throw new Error(event.message);
    default:
      throw new Error("Query stream returned an unknown event");
  }
}

/**
 * Send a question and consume Hono's SSE response as it arrives.
 * The returned promise resolves only after the final `done` event.
 */
export async function streamQuery(
  input: QueryStreamInput,
  handlers: QueryStreamHandlers = {},
  signal?: AbortSignal,
): Promise<QueryStreamResult> {
  let response: Response;

  try {
    response = await fetch("/api/query/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;

    const message =
      "The connection to the answer service was interrupted. Please try again.";
    handlers.onError?.(message);
    throw new Error(message);
  }

  if (!response.ok) {
    let message = `Query failed with status ${response.status}`;

    if (response.status === 502 || response.status === 503) {
      message = "The answer service is temporarily unavailable. Please try again.";
    }

    try {
      const body: unknown = await response.json();
      if (
        response.status !== 502 &&
        response.status !== 503 &&
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
      ) {
        message = body.error;
      }
    } catch {
      // Keep the status-based message when the error body is empty/non-JSON.
    }

    handlers.onError?.(message);
    throw new Error(message);
  }

  if (!response.body) {
    const message = "Query response did not contain a stream";
    handlers.onError?.(message);
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: QueryStreamResult | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();

      // stream: true keeps partial multi-byte characters for the next read.
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Hono normally uses LF, but normalizing CRLF makes the parser work with
      // either valid SSE line-ending style.
      buffer = buffer.replace(/\r\n/g, "\n");

      const completeBlocks = buffer.split("\n\n");
      // The last piece may be only half an event, so retain it until more
      // network bytes arrive instead of attempting to parse it too early.
      buffer = completeBlocks.pop() ?? "";

      for (const block of completeBlocks) {
        const event = parseSseEvent(block);
        if (!event) continue;

        const result = dispatchEvent(event, handlers);
        if (result) finalResult = result;
      }

      if (done) break;
    }

    // Accept a final complete event even if the server closes without the
    // conventional blank line after it.
    if (buffer.trim()) {
      const event = parseSseEvent(buffer);
      if (event) {
        const result = dispatchEvent(event, handlers);
        if (result) finalResult = result;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!finalResult) {
    const message = "Query stream ended before completion";
    handlers.onError?.(message);
    throw new Error(message);
  }

  return finalResult;
}
