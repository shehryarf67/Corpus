import type {Chunk} from './chunk.js';
import {embed} from '../embeddings.js';

export type EmbeddedChunk = Chunk & {
  embedding: number[]
}

const BATCH_SIZE = 32

export async function embedChunks(chunks: Chunk[]) {
    const embeddedChunks: EmbeddedChunk[] = []
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE)
        const texts = batch.map((chunk) => chunk.content)
        const embeddings = await embed(texts, 'document')
        const batchEmbeddedChunks = batch.map((chunk, j) => {
            if (!embeddings[j]) {
                throw new Error('Missing embedding for chunk at index ' + (i + j))
            }

            return ({...chunk, embedding: embeddings[j]}) // This spread means we're creating a 
            // new object that combines the properties of the original chunk with the new 
            // embedding property.

        })
        embeddedChunks.push(...batchEmbeddedChunks)
    }
    return embeddedChunks
}
