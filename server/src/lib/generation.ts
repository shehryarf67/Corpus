const OLLAMA_URL = 'http://localhost:11434'
const MODEL = 'llama3.2'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// Ollama's /api/chat mirrors the shape RAG generation actually needs later
// (a system prompt plus a user question), rather than a single flat
// prompt string — same reasoning as why embed() kept Voyage's
// document/query distinction even after switching backends.
export async function chat(messages: ChatMessage[]): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
  })

  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`)
  }

  const data = await res.json()
  return data.message.content
}
