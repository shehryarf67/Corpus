"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  streamQuery,
  type QuerySource,
} from "@/lib/query-stream";
import type { PersistedConversationMessage } from "@/lib/api";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: QuerySource[];
  status: "done" | "processing" | "streaming" | "stopped";
  progress?: string;
};

type DocumentChatProps = {
  documentId: string;
  initialConversationId?: string;
  initialMessages?: PersistedConversationMessage[];
  onCitationSelect?: (source: QuerySource) => void;
  onOpenDocument?: () => void;
};

export function DocumentChat({
  documentId,
  initialConversationId,
  initialMessages = [],
  onCitationSelect,
  onOpenDocument,
}: DocumentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    initialMessages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      // API types describe the intended contract, but runtime history from an
      // older backend/database can omit sources. Never let that crash rendering.
      sources: Array.isArray(message.sources) ? message.sources : [],
      // Only finalized database messages are returned by the history route.
      status: "done",
    })),
  );
  const [question, setQuestion] = useState("");
  const [conversationId, setConversationId] = useState<string | undefined>(
    initialConversationId,
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCitationId, setSelectedCitationId] = useState<string | null>(
    null,
  );
  const requestController = useRef<AbortController | null>(null);
  const nextMessageId = useRef(0);

  function createMessageId() {
    nextMessageId.current += 1;
    return `message-${nextMessageId.current}`;
  }

  useEffect(() => {
    // Stop the network reader if the user leaves this document while an
    // answer is streaming. This prevents an abandoned request updating state.
    return () => requestController.current?.abort();
  }, []);

  function stopActiveStream() {
    requestController.current?.abort();
  }

  function startOver() {
    // Abort first so the old request cannot keep producing useful work. Its
    // callbacks may run once more, but the old messages no longer exist.
    requestController.current?.abort();
    requestController.current = null;
    setMessages([]);
    setConversationId(undefined);
    setQuestion("");
    setError(null);
    setSelectedCitationId(null);
    setIsStreaming(false);
  }

  function selectCitation(source: QuerySource) {
    setSelectedCitationId(source.chunkId);
    // The chat owns citation presentation. A future shared workspace client
    // can provide this callback to navigate/highlight the matching PDF page.
    onCitationSelect?.(source);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const submittedQuestion = question.trim();
    if (!submittedQuestion || isStreaming) return;

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: submittedQuestion,
      sources: [],
      status: "done",
    };
    const assistantMessageId = createMessageId();
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      sources: [],
      // This message exists before Hono sends its first text token, so the UI
      // can immediately show that the submitted question is being processed.
      status: "processing",
      progress: "Finding relevant passages...",
    };

    // Add an empty assistant message now. Each token will fill this same
    // message, which makes the answer visibly grow instead of appearing late.
    setMessages((current) => [
      ...current,
      userMessage,
      assistantMessage,
    ]);
    setError(null);
    setIsStreaming(true);

    const controller = new AbortController();
    requestController.current = controller;

    try {
      await streamQuery(
        {
          documentId,
          question: submittedQuestion,
          conversationId,
        },
        {
          onConversation: (id) => setConversationId(id),
          onStatus: (status) => {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      progress:
                        status === "generating"
                          ? "Writing the answer..."
                          : "Checking sources...",
                    }
                  : message,
              ),
            );
          },
          onToken: (text) => {
            // Tokens are small answer pieces. Append each one to the current
            // assistant message so the user sees generation in real time.
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      content: message.content + text,
                      status: "streaming",
                      progress: undefined,
                    }
                  : message,
              ),
            );
          },
          onDone: (result) => {
            // The backend validates the complete answer before `done`. Replace
            // the token-built draft because done.answer is authoritative and
            // is not guaranteed to equal the raw token concatenation.
            // A grounded refusal such as "the document does not say" also
            // arrives through done and should remain a normal assistant reply.
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      content: result.answer,
                      sources: result.sources,
                      status: "done",
                      progress: undefined,
                    }
                  : message,
              ),
            );
            // Clear only after Hono confirms a completed answer. A failed
            // request leaves the original question available for a retry.
            setQuestion("");
          },
          onError: setError,
        },
        controller.signal,
      );
    } catch (streamError) {
      const wasAborted =
        streamError instanceof Error && streamError.name === "AbortError";

      if (wasAborted) {
        // Preserve any text already displayed, but make it clear that this is
        // a stopped draft and no authoritative done.answer was received.
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? { ...message, status: "stopped" }
              : message,
          ),
        );
      } else {
        setError(
          streamError instanceof Error
            ? streamError.message
            : "The answer could not be generated.",
        );
        // A network, HTTP, or SSE error means there is no trustworthy final
        // assistant answer. Remove its partial placeholder instead of leaving
        // a permanently half-finished response in the conversation.
        setMessages((current) =>
          current.filter((message) => message.id !== assistantMessageId),
        );
      }
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
      }
      setIsStreaming(false);
    }
  }

  return (
    <section
      aria-label="Conversation"
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-chrome lg:grid-rows-[minmax(0,1fr)_auto] lg:border-l lg:border-rule"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-rule px-4 py-2.5 lg:hidden">
        <span className="font-mono text-[10.5px] tracking-[0.12em] text-graphite-dim uppercase">
          Conversation
        </span>
        <button
          type="button"
          onClick={onOpenDocument}
          className="min-h-9 cursor-pointer rounded-[3px] border border-rule-strong px-3 font-mono text-[10.5px] text-graphite transition-colors hover:border-marker-line hover:text-bone"
        >
          Go to document
        </button>
      </div>

      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        className="flex min-w-0 flex-col gap-[26px] overflow-y-auto px-4 pt-5 pb-2 sm:px-[26px] sm:pt-6"
      >
        {messages.length === 0 ? (
          <p className="m-auto max-w-xs text-center text-[13px] leading-6 text-graphite-dim">
            Ask a question about this document. Answers will use information
            from the document.
          </p>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              aria-label={
                message.role === "user" ? "Your question" : "Assistant answer"
              }
              className={`min-w-0 [overflow-wrap:anywhere] ${
                message.role === "user"
                  ? "max-w-[88%] self-end rounded-[3px] border border-rule-strong bg-raise px-[13px] py-2.5 text-[13.5px] leading-[1.55] text-bone"
                  : "max-w-full text-[13.8px] leading-[1.72] text-read"
              }`}
            >
              {message.status === "processing" && !message.content ? (
                <span role="status" className="font-mono text-[11px] text-graphite-dim">
                  {message.progress ?? "Preparing the answer..."}
                </span>
              ) : message.content ? (
                message.content
              ) : message.status === "stopped" ? (
                <span className="text-graphite-dim">
                  Generation stopped.
                </span>
              ) : null}

              {message.progress && message.content && (
                <p
                  role="status"
                  className="mt-2 font-mono text-[10px] text-graphite-dim"
                >
                  {message.progress}
                </p>
              )}

              {message.status === "stopped" && message.content && (
                <p className="mt-2 font-mono text-[10px] text-graphite-dim">
                  Generation stopped before the final answer was validated.
                </p>
              )}

              {message.sources.length > 0 && (
                <div className="mt-3.5 border-t border-rule pt-3">
                  <div className="mb-2 font-mono text-[10.5px] tracking-[0.14em] text-graphite-dim uppercase">
                    Sources
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {message.sources.map((source) => (
                      <button
                        key={source.chunkId}
                        type="button"
                        onClick={() => selectCitation(source)}
                        aria-pressed={selectedCitationId === source.chunkId}
                        aria-label={
                          source.pageNumber == null
                            ? `Select source ${source.label}; page unavailable`
                            : `Open source ${source.label} on PDF page ${source.pageNumber}`
                        }
                        className="max-w-full cursor-pointer whitespace-normal rounded-[3px] border border-rule-strong px-2 py-1.5 text-left font-mono text-[10.5px] [overflow-wrap:anywhere] text-graphite transition-colors hover:border-marker-line hover:bg-marker-wash hover:text-bone focus-visible:border-marker-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marker-line aria-pressed:border-marker-line aria-pressed:bg-marker-wash aria-pressed:text-bone"
                      >
                        {source.label} · Page {source.pageNumber ?? "Unknown"}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </article>
          ))
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-rule bg-chrome px-4 pt-3.5 pb-3 sm:px-[26px] sm:pb-[18px]"
      >
        {(messages.length > 0 || isStreaming) && (
          <div className="mb-2 flex flex-wrap justify-end gap-2">
            {isStreaming && (
              <button
                type="button"
                onClick={stopActiveStream}
                className="rounded-[3px] border border-rule-strong px-2 py-1 font-mono text-[10px] text-graphite transition-colors hover:border-marker-line hover:text-bone"
              >
                Stop generating
              </button>
            )}
            <button
              type="button"
              onClick={startOver}
              className="rounded-[3px] border border-rule-strong px-2 py-1 font-mono text-[10px] text-graphite transition-colors hover:border-marker-line hover:text-bone"
            >
              Start over
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="mb-2 [overflow-wrap:anywhere] text-[12px] text-red-400">
            {error}
          </p>
        )}

        <div className="flex min-w-0 items-center gap-2.5 rounded-[4px] border border-rule-strong bg-void py-1 pr-1 pl-[13px] transition-colors focus-within:border-marker-line">
          <input
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={isStreaming}
            placeholder="Ask about this paper..."
            aria-label="Ask a question"
            className="min-w-0 flex-1 border-0 bg-transparent py-2 text-[13.5px] text-bone outline-none placeholder:text-graphite-dim disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={isStreaming || !question.trim()}
            aria-label="Send question"
            className="grid h-[30px] w-[30px] cursor-pointer place-items-center rounded-[3px] bg-raise text-graphite transition-colors hover:bg-marker hover:text-[#171004] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2.5 7h9M8 3.5L11.5 7 8 10.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <p className="mt-[9px] text-center font-mono text-[10px] tracking-[0.03em] text-graphite-dim">
          answers are based only on this document
        </p>
      </form>
    </section>
  );
}
