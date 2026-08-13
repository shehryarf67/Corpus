import { cookies } from "next/headers"
import type { NextRequest } from "next/server"

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
): Promise<Response> {

    // 1. Read ID and base URL and check the base URL
    const { id } = await params
    // This runs on the Next server, so the internal Hono URL does not need a
    // NEXT_PUBLIC variable that could also be included in browser code.
    const baseUrl = process.env.API_BASE_URL

    if (!baseUrl) {
        return Response.json(
            { error: "API_BASE_URL is not configured" },
            { status: 500 },
        )
    }

    // 2. Read the browser cookies. Includes HttpOnly cookies as Server-side Next code can read it.
    const cookieStore = await cookies()
    const cookieHeader = cookieStore.toString()

    try {
        // 3. Request the PDF from Hono and forward the browser's session cookie.
        // A 401, 404, or 500 is still a completed response, so fetch does not
        // throw for those statuses and we pass them through below.
        const response = await fetch(
            `${baseUrl}/documents/${encodeURIComponent(id)}/pdf`,
            {
                headers: {
                    Cookie: cookieHeader,
                },
                cache: "no-store",
            },
        )

        // 4. Preserve the headers the browser needs to handle the PDF.
        const headers = new Headers()
        const contentType = response.headers.get("Content-Type")
        const contentDisposition = response.headers.get("Content-Disposition")
        const contentLength = response.headers.get("Content-Length")

        if (contentType) headers.set("Content-Type", contentType)
        if (contentDisposition) {
            headers.set("Content-Disposition", contentDisposition)
        }
        if (contentLength) headers.set("Content-Length", contentLength)

        // 5. Pass the stream through without buffering a second PDF copy in Next.
        return new Response(response.body, {
            status: response.status,
            headers,
        })
    } catch (error) {
        // fetch throws when no HTTP response was received, such as when Hono
        // is stopped or its connection breaks. Keep details in server logs.
        console.error(`could not reach Hono for document PDF ${id}`, error)
        return Response.json(
            { error: "Document service is currently unavailable" },
            { status: 502 },
        )
    }

}
