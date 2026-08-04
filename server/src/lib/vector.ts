// The embedding model returns vectors as number[], but node-postgres sends
// custom pgvector values as text. pgvector's accepted text form is a list
// wrapped in square brackets, for example "[0.1,-0.2,0.3]".
export function formatEmbeddingForPgvector(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}
