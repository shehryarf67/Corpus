import assert from "node:assert/strict";
import test from "node:test";
import { parseSseEvent, streamQuery } from "./query-stream";

const encoder = new TextEncoder();

function streamingResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

async function withMockFetch<T>(
  response: Response,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withRejectedFetch<T>(run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("network unavailable");
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("one complete event is parsed from one frame", () => {
  const event = parseSseEvent(
    'event: token\ndata: {"text":"Hello"}',
  );

  assert.deepEqual(event, { type: "token", text: "Hello" });
});

test("an event split across network chunks is reconstructed", async () => {
  const response = streamingResponse([
    "event: token\nda",
    'ta: {"text":"Hel',
    'lo"}\n\nevent: done\ndata: {"conversationId":"conversation-1",',
    '"answer":"Hello","sources":[]}\n\n',
  ]);
  let visibleAnswer = "";

  const result = await withMockFetch(response, () =>
    streamQuery(
      { documentId: "document-1", question: "Question?" },
      { onToken: (text) => (visibleAnswer += text) },
    ),
  );

  assert.equal(visibleAnswer, "Hello");
  assert.equal(result.answer, "Hello");
});

test("multiple events in one network chunk are dispatched in order", async () => {
  const received: string[] = [];
  const response = streamingResponse([
    'event: conversation\ndata: {"conversationId":"conversation-2"}\n\n' +
      'event: status\ndata: {"status":"generating"}\n\n' +
      'event: token\ndata: {"text":"Answer"}\n\n' +
      'event: done\ndata: {"conversationId":"conversation-2","answer":"Answer","sources":[]}\n\n',
  ]);

  await withMockFetch(response, () =>
    streamQuery(
      { documentId: "document-1", question: "Question?" },
      {
        onConversation: () => received.push("conversation"),
        onStatus: () => received.push("status"),
        onToken: () => received.push("token"),
        onDone: () => received.push("done"),
      },
    ),
  );

  assert.deepEqual(received, ["conversation", "status", "token", "done"]);
});

test("malformed event JSON throws instead of producing bad data", () => {
  assert.throws(
    () => parseSseEvent("event: token\ndata: {not-json}"),
    SyntaxError,
  );
});

test("done event resolves with its authoritative answer and sources", async () => {
  const response = streamingResponse([
    'event: done\ndata: {"conversationId":"conversation-3","answer":"Final answer [S1]","sources":[{"label":"S1","chunkId":"chunk-1","documentId":"document-1","pageNumber":2,"content":"supporting text","similarity":0.9}]}\n\n',
  ]);

  const result = await withMockFetch(response, () =>
    streamQuery({ documentId: "document-1", question: "Question?" }),
  );

  assert.equal(result.answer, "Final answer [S1]");
  assert.equal(result.sources[0]?.chunkId, "chunk-1");
  assert.equal(result.sources[0]?.pageNumber, 2);
});

test("error event calls the error handler and rejects the stream", async () => {
  const response = streamingResponse([
    'event: error\ndata: {"message":"Query stream failed"}\n\n',
  ]);
  let reportedError = "";

  await assert.rejects(
    withMockFetch(response, () =>
      streamQuery(
        { documentId: "document-1", question: "Question?" },
        { onError: (message) => (reportedError = message) },
      ),
    ),
    /Query stream failed/,
  );
  assert.equal(reportedError, "Query stream failed");
});

test("backend-unavailable responses receive a useful stable message", async () => {
  await assert.rejects(
    withMockFetch(
      Response.json({ error: "internal proxy detail" }, { status: 502 }),
      () => streamQuery({ documentId: "document-1", question: "Question?" }),
    ),
    /answer service is temporarily unavailable/i,
  );
});

test("network interruption receives a retryable user-facing message", async () => {
  await assert.rejects(
    withRejectedFetch(() =>
      streamQuery({ documentId: "document-1", question: "Question?" }),
    ),
    /connection to the answer service was interrupted/i,
  );
});
