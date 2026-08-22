import { cookies } from "next/headers";

export async function POST(request: Request): Promise<Response> {
  // This route runs on the Next server, so Hono's internal URL stays out of
  // browser code. The browser only needs to call /api/query/stream.
  const baseUrl = process.env.API_BASE_URL;

  if (!baseUrl) {
    return Response.json(
      { error: "API_BASE_URL is not configured" },
      { status: 500 },
    );
  }

  // Read the body as text so it can be forwarded unchanged. Hono remains
  // responsible for validating documentId, question, and conversationId.
  const requestBody = await request.text();
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  try {
    const upstream = await fetch(`${baseUrl}/query/stream`, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type") ?? "application/json",
        Cookie: cookieHeader,
      },
      body: requestBody,
      cache: "no-store",
    });

    // Keep Hono's SSE headers so the browser treats the response as a live
    // event stream instead of an ordinary buffered response.
    const headers = new Headers();
    const contentType = upstream.headers.get("Content-Type");
    const cacheControl = upstream.headers.get("Cache-Control");
    const connection = upstream.headers.get("Connection");

    headers.set("Content-Type", contentType ?? "text/event-stream");
    headers.set("Cache-Control", cacheControl ?? "no-cache");
    if (connection) headers.set("Connection", connection);

    // Do not call upstream.text() or upstream.json(). Returning the body
    // directly lets each SSE event reach the browser as Hono produces it.
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    // fetch only throws when Hono could not return an HTTP response at all.
    // Normal upstream errors such as 400 or 401 are passed through above.
    console.error("could not reach Hono query stream", error);
    return Response.json(
      { error: "The answer service is temporarily unavailable. Please try again." },
      { status: 502 },
    );
  }
}
