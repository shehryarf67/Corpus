export type QueryEvaluationTurn = {
  question: string
  expectedFactGroups: string[][]
  expectedChunkIndexes: number[]
  expectedPages: number[]
  shouldRefuse?: boolean
}

export type QueryEvaluationCase = {
  id: string
  description: string
  turns: QueryEvaluationTurn[]
}

// Each inner fact group contains acceptable wording variations. A generated
// answer only needs to contain one variation from each group.
export const queryEvaluationCases: QueryEvaluationCase[] = [
  {
    id: 'authors',
    description: 'Direct factual authorship question',
    turns: [
      {
        question: 'Who wrote Automatic Mixed-Precision Quantization Search of BERT?',
        expectedFactGroups: [
          ['Changsheng Zhao'],
          ['Ting Hua'],
          ['Yilin Shen'],
          ['Qian Lou'],
          ['Hongxia Jin'],
        ],
        expectedChunkIndexes: [0],
        expectedPages: [1],
      },
    ],
  },
  {
    id: 'compression-directions',
    description: 'Three model-compression directions',
    turns: [
      {
        question: 'What three main directions are used for model compression?',
        expectedFactGroups: [
          ['knowledge distillation'],
          ['pruning', 'weight pruning'],
          ['quantization'],
        ],
        expectedChunkIndexes: [0, 1],
        expectedPages: [1],
      },
    ],
  },
  {
    id: 'framework-networks',
    description: 'Two networks in the proposed framework',
    turns: [
      {
        question: 'What two networks make up the proposed framework?',
        expectedFactGroups: [
          ['inner network', 'inner training network', 'weight-training inner network'],
          ['super network', 'bit-assignment super network'],
        ],
        expectedChunkIndexes: [5, 6],
        expectedPages: [3],
      },
    ],
  },
  {
    id: 'bit-widths',
    description: 'Subgroup bit-width choices',
    turns: [
      {
        question: 'Which bit-width choices can each subgroup select?',
        expectedFactGroups: [
          ['0-bit', '0 bit'],
          ['2-bit', '2 bit'],
          ['4-bit', '4 bit'],
        ],
        expectedChunkIndexes: [5, 6],
        expectedPages: [3],
      },
    ],
  },
  {
    id: 'quantization-backpropagation',
    description: 'Backpropagation through non-differentiable quantization',
    turns: [
      {
        question:
          'How does the paper backpropagate through the non-differentiable quantization function?',
        expectedFactGroups: [
          ['straight-through estimator', 'straight through estimator'],
        ],
        expectedChunkIndexes: [9],
        expectedPages: [4],
      },
    ],
  },
  {
    id: 'evaluation-tasks',
    description: 'Four NLP evaluation tasks',
    turns: [
      {
        question: 'Which four NLP tasks are used to evaluate AQ-BERT?',
        expectedFactGroups: [
          ['SST-2'],
          ['MNLI'],
          ['CoNLL-2003', 'CoNLL-03'],
          ['SQuAD'],
        ],
        expectedChunkIndexes: [12],
        expectedPages: [5],
      },
    ],
  },
  {
    id: 'group-performance',
    description: 'Performance gain from increasing group count',
    turns: [
      {
        question:
          'How much performance gain is obtained when increasing groups from 128 to 768?',
        expectedFactGroups: [['0.1%', '0.1 percent']],
        expectedChunkIndexes: [14],
        expectedPages: [6],
      },
    ],
  },
  {
    id: 'knowledge-distillation',
    description: 'Conclusions about combining AQ-BERT and distillation',
    turns: [
      {
        question:
          'What conclusions are made about combining AQ-BERT with knowledge distillation?',
        expectedFactGroups: [
          ['safe to integrate', 'can be integrated', 'orthogonal'],
          ['extreme light-weight', 'extreme lightweight', 'compact model'],
          ['little performance loss', '0.1% extra performance loss'],
        ],
        expectedChunkIndexes: [14, 15],
        expectedPages: [6],
      },
    ],
  },
  {
    id: 'unanswerable-gpu',
    description: 'Document does not specify a GPU model',
    turns: [
      {
        question: 'Which exact GPU model was used to train AQ-BERT?',
        expectedFactGroups: [],
        expectedChunkIndexes: [],
        expectedPages: [],
        shouldRefuse: true,
      },
    ],
  },
  {
    id: 'unanswerable-cost',
    description: 'Document does not report financial training cost',
    turns: [
      {
        question: 'What was the financial cost of training AQ-BERT?',
        expectedFactGroups: [],
        expectedChunkIndexes: [],
        expectedPages: [],
        shouldRefuse: true,
      },
    ],
  },
  {
    id: 'multi-turn-tasks',
    description: 'Follow-up pronoun must resolve to AQ-BERT',
    turns: [
      {
        question: 'What is AQ-BERT?',
        expectedFactGroups: [
          ['automatic mixed-precision quantization', 'mixed-precision quantization'],
          ['BERT'],
        ],
        expectedChunkIndexes: [0, 1, 5, 6],
        expectedPages: [1, 3],
      },
      {
        question: 'Which four tasks was it evaluated on?',
        expectedFactGroups: [
          ['SST-2'],
          ['MNLI'],
          ['CoNLL-2003', 'CoNLL-03'],
          ['SQuAD'],
        ],
        expectedChunkIndexes: [12],
        expectedPages: [5],
      },
    ],
  },
  {
    id: 'multi-turn-network',
    description: 'Follow-up refers to previously discussed bit assignments',
    turns: [
      {
        question: 'Which bit-widths can a subgroup choose?',
        expectedFactGroups: [
          ['0-bit', '0 bit'],
          ['2-bit', '2 bit'],
          ['4-bit', '4 bit'],
        ],
        expectedChunkIndexes: [5, 6],
        expectedPages: [3],
      },
      {
        question: 'Which network controls those assignments?',
        expectedFactGroups: [['super network', 'bit-assignment super network']],
        expectedChunkIndexes: [5, 6],
        expectedPages: [3],
      },
    ],
  },
]
