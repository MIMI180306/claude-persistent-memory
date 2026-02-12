const path = require('path');

module.exports = {
  // TCP ports
  embeddingPort: 23811,
  llmPort: 23812,

  // Data directories (relative to project root)
  dataDir: path.resolve(__dirname, 'data'),
  logDir: path.resolve(__dirname, 'data', 'logs'),
  pidDir: '/tmp',

  // Azure OpenAI (configure via environment variables)
  azure: {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    apiKey: process.env.AZURE_OPENAI_KEY || '',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1',
    apiVersion: '2024-12-01-preview',
  },

  // Embedding model
  embedding: {
    model: 'Xenova/bge-m3',
    dimensions: 1024,
  },

  // Search parameters
  search: {
    maxResults: 3,
    minSimilarity: 0.6,
  },

  // Clustering parameters
  cluster: {
    similarityThreshold: 0.70,
    maturityCount: 5,
    maturityConfidence: 0.65,
  },

  // Timeouts (ms)
  timeout: {
    hookPreTool: 300,
    hookPostTool: 300,
    hookUserPrompt: 1500,
    embeddingSearch: 1000,
    embeddingClient: 800,
    llmDefault: 5000,
  },
};
