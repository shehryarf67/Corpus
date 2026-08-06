const OLLAMA_URL = 'http://localhost:11434'
const MODEL = 'llama3.2'

const ANSWER_MAX_TOKENS = 512
const ANSWER_TIMEOUT_MS = 120_000

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type ChatOptions = {
  maxTokens?: number
  timeoutMs?: number
}

type OllamaStreamChunk = {
  message?: {
    content?: string
  }
  error?: string
}

// Parse one complete NDJSON line from Ollama. Some stream events contain no
// text, so null means there is nothing for the caller to display.
function textFromStreamLine(line: string): string | null {
  const trimmedLine = line.trim()
  if (!trimmedLine) return null

  const chunk = JSON.parse(trimmedLine) as OllamaStreamChunk

  if (chunk.error) {
    throw new Error(`Ollama stream failed: ${chunk.error}`)
  }

  return chunk.message?.content || null
}

// Ollama's /api/chat mirrors the shape RAG generation actually needs later
// (a system prompt plus a user question), rather than a single flat
// prompt string — same reasoning as why embed() kept Voyage's
// document/query distinction even after switching backends.
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const maxTokens = options.maxTokens ?? ANSWER_MAX_TOKENS
  const timeoutMs = options.timeoutMs ?? ANSWER_TIMEOUT_MS

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      // A grounded document answer benefits from consistency more than
      // creativity. Temperature 0 reduces random wording and citation-label
      // changes between otherwise identical requests.
      // num_predict is Ollama's maximum output-token setting. The model can
      // still finish earlier when it has completed the answer.
      options: { temperature: 0, num_predict: maxTokens },
    }),
    // Stop a request that has become stuck instead of letting Ollama keep
    // using CPU forever.
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`)
  }

  const data = await res.json()
  return data.message.content
}

// Ollama streams newline-delimited JSON (NDJSON), not plain text. This async
// generator reconstructs complete JSON lines and yields each generated text
// piece to its caller as soon as it arrives.
export async function* chatStream(
  messages: ChatMessage[],
  options: ChatOptions = {}
): AsyncGenerator<string> {
  const maxTokens = options.maxTokens ?? ANSWER_MAX_TOKENS
  const timeoutMs = options.timeoutMs ?? ANSWER_TIMEOUT_MS

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      options: { temperature: 0, num_predict: maxTokens },
    }),
    // This is currently one simple total timeout for the full stream. We can
    // later split it into first-token and inactivity timeouts if needed.
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`)
  }

  if (!res.body) {
    throw new Error('Ollama response did not contain a body')
  }

  // res.body is the live response coming from Ollama. getReader() locks that
  // response to this reader and lets us ask for each incoming piece manually.
  // reader.read() will later give us { value, done }, where value contains the
  // latest bytes and done tells us whether Ollama has finished sending data.
  const reader = res.body.getReader()

  // The reader gives us bytes as a Uint8Array, not normal text. TextDecoder
  // converts those bytes into the JSON strings that Ollama is actually sending.
  const decoder = new TextDecoder()

  // One network read is not guaranteed to contain one complete JSON object.
  // It can stop halfway through one, so buffer holds unfinished text until the
  // next read arrives and completes it.
  let buffer = ''

  try {
    // We do not know how many pieces Ollama will send. Keep reading forever
    // until reader.read() gives us done = true, then break out of this loop.
    while (true) {
      // reader.read() is asynchronous because we may have to wait for Ollama.
      // This object destructuring is a shorter way to get result.value and
      // result.done into two variables named value and done.
      const { value, done } = await reader.read()

      // No more bytes are coming, so leave the while loop and process anything
      // that may still be waiting inside buffer or TextDecoder.
      if (done) break

      // Convert the latest bytes into text and add them to the text we already
      // had. { stream: true } tells the decoder more bytes are coming, so it can
      // safely hold a character whose bytes were split between network reads.
      buffer += decoder.decode(value, { stream: true })

      // Ollama sends NDJSON, meaning each complete JSON object ends with \n.
      // Splitting on \n gives us the complete lines plus one final item that
      // might still be an unfinished JSON object.
      const lines = buffer.split('\n')

      // pop() removes the final array item. We keep that item in buffer because
      // it may need the next network read before it becomes valid JSON. If pop()
      // somehow returns undefined, ?? gives us an empty string instead.
      buffer = lines.pop() ?? ''

      // lines now contains only newline-completed JSON strings, so each one is
      // safe to parse. for...of visits those complete lines one at a time.
      for (const line of lines) {
        // The helper parses the JSON, checks for an Ollama stream error, and
        // returns message.content. It returns null for empty events such as the
        // final done event that contains no generated text.
        const text = textFromStreamLine(line)

        // yield sends this one text piece to the caller and pauses this function.
        // Unlike return, it does not end chatStream. When the caller asks for the
        // next piece, this function continues and reads more data from Ollama.
        if (text) yield text
      }
    }

    // Calling decode() without another value tells TextDecoder that no more
    // bytes are coming. This flushes any final character bytes it was holding.
    buffer += decoder.decode()

    // Ollama normally ends every JSON object with \n, but the final object may
    // arrive without one. In that case it stayed in buffer, so parse it now.
    for (const line of buffer.split('\n')) {
      const text = textFromStreamLine(line)
      if (text) yield text
    }
  } finally {
    // getReader() locked the response body to this reader. finally always runs,
    // whether streaming succeeded or threw an error, so the lock is always
    // released when we are finished with the response.
    reader.releaseLock()
  }
}
