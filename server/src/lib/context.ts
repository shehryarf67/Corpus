import type { RetrievedChunk } from "./db.js"


export type ContextSource = {
    label: string
    chunkId: string
    documentId: string
    pageNumber: number | null
    content: string
    similarity: number
}

export type BuiltContext = {
    context: string
    sources: ContextSource[]
}

export function buildContext(retrievedChunks: RetrievedChunk[]): BuiltContext {
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

        return `[${source.label} | Page ${page}]\n${source.content}`
    })

    const context = contextParts.join('\n\n')

    return  ({
        context,
        sources,
    })
}
