import type { MessageRow } from './db.js'
import { chat, type ChatMessage } from './generation.js'

const REWRITE_SYSTEM_PROMPT = `You rewrite follow-up questions for document search.

Use the conversation history only to resolve references such as "it", "they", "that method", or "the second one".

Return one standalone question that preserves the user's meaning. Do not answer the question. Do not add explanations, labels, or quotation marks. If the question is already standalone, return it unchanged.`

type HistoryMessage = Pick<MessageRow, 'role' | 'content'>

export function buildRewriteMessages(
  question: string,
  history: readonly HistoryMessage[]
): ChatMessage[] {
  const formattedHistory = history
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n')

  return [
    { role: 'system', content: REWRITE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `CONVERSATION HISTORY:

${formattedHistory}

FOLLOW-UP QUESTION:

${question}`,
    },
  ]
}

export async function rewriteQuestion(
  question: string,
  history: readonly HistoryMessage[]
): Promise<string> {
  // The first question is already standalone because there is no earlier
  // conversation for it to refer to. Skipping Ollama also saves one model call.
  if (history.length === 0) return question

  const rewritten = await chat(buildRewriteMessages(question, history))
  return rewritten.trim() || question
}
