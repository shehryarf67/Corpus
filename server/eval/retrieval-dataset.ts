export type RetrievalEvaluationCase = {
  question: string
  expectedChunkIndexes: number[]
  expectedPage: number
}

// Ground truth was checked against docs/test_pdf.pdf and then mapped to the
// actual chunk indexes produced by the current ingestion pipeline. Multiple
// indexes are accepted when adjacent chunks both contain valid evidence.
export const retrievalDataset: RetrievalEvaluationCase[] = [
  {
    question: 'Who wrote Automatic Mixed-Precision Quantization Search of BERT?',
    expectedChunkIndexes: [0],
    expectedPage: 1,
  },
  {
    question: 'What three main directions are used for model compression?',
    expectedChunkIndexes: [0, 1],
    expectedPage: 1,
  },
  {
    question: 'What two networks make up the proposed framework?',
    expectedChunkIndexes: [5, 6],
    expectedPage: 3,
  },
  {
    question: 'Which bit-width choices can each subgroup select?',
    expectedChunkIndexes: [5],
    expectedPage: 3,
  },
  {
    question: 'How does the paper backpropagate through the non-differentiable quantization function?',
    expectedChunkIndexes: [9],
    expectedPage: 4,
  },
  {
    question: 'Which four NLP tasks are used to evaluate AQ-BERT?',
    expectedChunkIndexes: [12],
    expectedPage: 5,
  },
  {
    question: 'How much performance gain is obtained when increasing groups from 128 to 768?',
    expectedChunkIndexes: [14],
    expectedPage: 6,
  },
  {
    question: 'What conclusions are made about combining AQ-BERT with knowledge distillation?',
    expectedChunkIndexes: [14, 15],
    expectedPage: 6,
  },
]
