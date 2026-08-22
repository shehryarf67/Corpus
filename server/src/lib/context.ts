import type { RetrievedChunk } from './db.js'
import type { FusedChunk } from './rrf.js'
import { compressPassageForGeneration } from './passage-compression.js'


export type ContextSource = {
    label: string
    chunkId: string
    documentId: string
    pageNumber: number | null
    content: string
    highlightText?: string | null
    similarity: number | null
}

export type BuiltContext = {
    context: string
    sources: ContextSource[]
}

export function buildContext(
    retrievedChunks: Array<RetrievedChunk | FusedChunk>,
    question?: string
): BuiltContext {
    const sources = retrievedChunks.map((chunk, index) => {
        return {
            label: `S${index + 1}`,
            chunkId: chunk.id,
            documentId: chunk.document_id,
            pageNumber: chunk.page_number,
            content: chunk.content,
            similarity: chunk.similarity,
        }
    })

    const contextParts = sources.map((source) => {
        const page = source.pageNumber ?? 'Unknown'

        // Use explicit source boundaries so the model can distinguish source
        // metadata from the document text. The answer should cite only the
        // source ID as [S1], not copy this wrapper into its response.
        // Compression changes only what generation reads. The source object
        // keeps the complete chunk for citation display, persistence, and PDF
        // passage matching.
        const generationContent = question
          ? compressPassageForGeneration(source.content, question)
          : source.content
        return `<source id="${source.label}" page="${page}">\n${generationContent}\n</source>`
    })

    const context = contextParts.join('\n\n')

    return  ({
        context,
        sources,
    })
}
