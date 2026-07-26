# Corpus

**Chat with your documents — grounded in what they actually say.**

Corpus is a retrieval-augmented document Q&A system. You upload PDFs, it indexes them, and you ask questions in natural language. Every answer is grounded in your documents and cites the exact passage it came from — click a citation and jump to the highlighted source in the original PDF.

This is not a thin wrapper around an LLM API. The engineering is in the retrieval: structure-aware chunking, hybrid semantic + keyword search with reciprocal rank fusion, reranking, and a measurable eval harness that quantifies retrieval quality rather than eyeballing it.

<!-- TODO: replace with your live link and a real demo gif before publishing -->
**[Live demo](#)** · **[Demo video](#)**

<!-- TODO: embed a demo gif here — the citation-click-to-highlight flow is the money shot -->

---

## Why this exists

"Chat with your PDF" is a solved-looking problem with a lot of bad solutions. Most demos dump the whole document into the context window or split it into naive fixed-length chunks, embed them, and hope. That falls apart the moment you have a real corpus: retrieval gets noisy, answers hallucinate, and there's no way to trust a given answer without re-reading the source yourself.

Corpus is built to do it properly:

- **Answers you can verify** — every claim links back to the specific page and passage it's drawn from.
- **Retrieval that's actually measured** — an eval harness reports recall@k and MRR, so improvements are numbers, not vibes.
- **Retrieval that combines strategies** — semantic search catches meaning, keyword search catches exact terms and rare tokens; fused together they beat either alone.

---

## Features

- **Structure-aware chunking** — documents are parsed into a layout tree (headings, paragraphs, tables) and split along semantic boundaries, not blind character counts. Every chunk carries page number, section heading, and character offsets as metadata.
- **Hybrid retrieval** — vector similarity (pgvector, cosine) and full-text keyword search (Postgres `tsvector`) run in a single query and are fused with Reciprocal Rank Fusion.
- **Reranking** — top candidates from RRF are reranked down to the final context set before generation.
- **Small-to-big retrieval** — precise small chunks are matched, but the surrounding section is handed to the model for context.
- **Inline source citations** — the model emits structured citation markers that resolve to clickable references, opening the source PDF at the right page with the passage highlighted.
- **Token-by-token streaming** — answers stream over SSE, with citation markers resolved client-side as they arrive mid-stream.
- **Conversation memory** — follow-up questions are rewritten into standalone queries ("condense question" pattern) so context-dependent phrasing still retrieves well.
- **Multi-tenant isolation** — every document and chunk is scoped to its owner, enforced at the database layer with Postgres row-level security.
- **Evals** — a golden dataset of question/answer/source triples measures retrieval quality (recall@k, MRR) and tracks it across pipeline changes.

---

## Architecture

```mermaid
flowchart TD
    subgraph Ingestion
        A[PDF Upload] --> B[Parse to layout tree]
        B --> C[Structure-aware chunking<br/>+ metadata: page, section, offsets]
        C --> D[Embed chunks]
        D --> E[(Postgres + pgvector<br/>vectors + tsvector + RLS)]
    end

    subgraph Query
        F[User question] --> G[Condense to standalone query]
        G --> H[Hybrid retrieval<br/>vector + keyword, fused by RRF]
        E --> H
        H --> I[Rerank top-k]
        I --> J[Generate answer<br/>with citation markers]
        J --> K[Stream over SSE]
        K --> L[Resolve citations<br/>→ highlight in PDF viewer]
    end

    subgraph Evals
        M[Golden dataset] --> N[recall@k · MRR]
        H --> N
    end
```

Ingestion runs as a queued background job with status updates, so large uploads don't block the request and the UI can show real processing state.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js, React, `react-pdf` | PDF rendering with highlight overlays for citations |
| Backend | Node / TypeScript | One language end-to-end; consistent with the rest of the stack |
| Database | Postgres + pgvector | Vector and keyword search in one query; RLS for tenant isolation |
| Embeddings + generation | <!-- TODO: Anthropic / OpenAI — state which --> | |
| Streaming | Server-Sent Events | One-directional token stream; simpler than WebSockets for this |
| Deploy | <!-- TODO: Vercel + Railway/Fly, etc. --> | |

---

## Retrieval, in a bit more detail

**Chunking.** Fixed-length splitting severs sentences and mixes topics, which degrades both embedding quality and citation precision. Corpus chunks along structural boundaries at ~300–500 tokens, overlapping only when a unit has to be split. The page/section/offset metadata attached here is what makes precise citations possible downstream.

**Hybrid search + RRF.** Semantic search alone misses exact terms, rare identifiers, and acronyms; keyword search alone misses paraphrase and meaning. Both run against the same table and their rankings are combined with Reciprocal Rank Fusion — a parameter-light fusion that avoids hand-tuning score weights across two different scoring scales.

**Reranking.** RRF surfaces a broad candidate set; a reranking pass narrows it to the highest-precision context before generation, which measurably lifts answer quality per the evals.

**Citations.** Retrieved chunks are passed to the model with stable IDs, and the model is instructed to cite inline. A post-processing step maps those markers back to page + offset metadata and into clickable, highlight-on-click references.

---

## Eval results

<!--
TODO: Run the eval harness and paste REAL measured numbers here.
Do not publish placeholder or invented figures — an interviewer will ask how you
measured them, and made-up numbers turn your strongest feature into a liability.
The table below is the format to fill in, not example data.
-->

Measured on a golden dataset of _N_ question/source triples across _M_ documents:

| Configuration | recall@5 | MRR |
|---|---|---|
| Vector search only | _TODO_ | _TODO_ |
| + Hybrid (RRF) | _TODO_ | _TODO_ |
| + Reranking | _TODO_ | _TODO_ |

Method: <!-- TODO: one or two lines on how the golden set was built and verified -->

---

## Local setup

```bash
# Clone
git clone https://github.com/<you>/corpus.git
cd corpus

# Install
npm install

# Environment
cp .env.example .env
# Fill in: DATABASE_URL, embedding/LLM API key, etc.

# Database (Postgres with the pgvector extension)
# TODO: migration command, e.g.
npm run db:migrate

# Run
npm run dev
```

<!-- TODO: document the pgvector extension requirement and any background-worker process -->

---

## Roadmap

- [ ] Expose the retrieval pipeline as an MCP server (`search_documents` tool)
- [ ] Agentic mode — let the model re-query when the first retrieval looks thin
- [ ] OCR support for scanned PDFs
- [ ] Table-aware retrieval

---

## License

<!-- TODO: MIT, etc. -->
