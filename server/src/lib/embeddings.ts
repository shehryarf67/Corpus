import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers'

// Loading the model (downloading it to a local cache on first run, then
// reading it off disk afterward) is slow — created once and reused for
// every call, same reasoning as the tiktoken encoder singleton in
// chunk.ts. Lazily initialized (not called at module load) since the
// first call triggers a download the caller should be able to await.
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

function getExtractor() {
  extractorPromise ??= pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  return extractorPromise
}

// `inputType` mirrors Voyage's document/query distinction from the
// original API, kept so callers don't need to change — but this local
// model has no separate query/document mode, so the parameter is unused
// here.
export async function embed(texts: string[], inputType: 'document' | 'query') {
  const extractor = await getExtractor()
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  return output.tolist() as number[][]
}
