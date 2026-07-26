import { VoyageAIClient } from 'voyageai'

const client = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })

export async function embed(texts: string[], inputType: 'document' | 'query') {
  const res = await client.embed({ input: texts, model: 'voyage-3', inputType })
  return (res.data ?? []).map((d) => d.embedding)
}
