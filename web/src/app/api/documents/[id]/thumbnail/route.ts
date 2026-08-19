import { cookies } from 'next/headers'
import type { NextRequest } from 'next/server'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  const baseUrl = process.env.API_BASE_URL

  if (!baseUrl) {
    return Response.json({ error: 'API_BASE_URL is not configured' }, { status: 500 })
  }

  try {
    const response = await fetch(
      `${baseUrl}/documents/${encodeURIComponent(id)}/thumbnail`,
      {
        headers: { Cookie: (await cookies()).toString() },
        cache: 'no-store',
      }
    )

    const headers = new Headers()
    const contentType = response.headers.get('Content-Type')
    const cacheControl = response.headers.get('Cache-Control')
    if (contentType) headers.set('Content-Type', contentType)
    if (cacheControl) headers.set('Cache-Control', cacheControl)

    // Keep the image as a stream; Next does not need a second buffered copy.
    return new Response(response.body, {
      status: response.status,
      headers,
    })
  } catch (error) {
    console.error(`could not reach Hono for document thumbnail ${id}`, error)
    return Response.json(
      { error: 'Document service is currently unavailable' },
      { status: 502 }
    )
  }
}
