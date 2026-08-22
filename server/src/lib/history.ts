import type { MessageRow } from './db.js'
import { countTokens, keepLastTokens } from './tokens.js'

export const HISTORY_MESSAGE_LIMIT = 10
export const HISTORY_TOKEN_BUDGET = 1024

type HistoryMessage = Pick<MessageRow, 'role' | 'content'>

function historyMessageCost(message: HistoryMessage): number {
  // Include the role and a small separator allowance because rewrite.ts and
  // prompt.ts add role/formatting text around each stored message.
  return countTokens(`${message.role}: ${message.content}`) + 2
}

/** Keep one contiguous, newest-first slice without exceeding prompt budget. */
export function limitHistoryByTokens(
  messages: readonly HistoryMessage[],
  tokenBudget = HISTORY_TOKEN_BUDGET
): HistoryMessage[] {
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) return []

  const selected: HistoryMessage[] = []
  let usedTokens = 0

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) continue

    const cost = historyMessageCost(message)
    if (usedTokens + cost <= tokenBudget) {
      selected.unshift(message)
      usedTokens += cost
      continue
    }

    // If even the newest message is enormous, keep its ending rather than
    // sending no recent context at all. Follow-up references often depend on
    // the conclusion of the immediately preceding answer.
    if (selected.length === 0) {
      const marker = '[Earlier content omitted] '
      const fixedCost = countTokens(`${message.role}: ${marker}`) + 2
      const contentBudget = Math.max(0, tokenBudget - fixedCost)
      const retainedContent = keepLastTokens(message.content, contentBudget)

      if (retainedContent) {
        selected.unshift({
          role: message.role,
          content: `${marker}${retainedContent}`,
        })
      }
    }

    // Stop at the first message that does not fit so history stays contiguous
    // instead of including older messages while silently skipping newer ones.
    break
  }

  return selected
}
