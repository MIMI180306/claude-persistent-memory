# persistent-memory

Persistent memory system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — hybrid BM25 + vector semantic search, LLM-driven structuring, automatic clustering.

Give your Claude Code sessions long-term memory that persists across conversations.

## Features

- **Hybrid Search** — BM25 full-text (FTS5) + vector semantic similarity (sqlite-vec), combined ranking
- **4-Channel Retrieval** — Pull (MCP tools) + Push (auto-inject via hooks on user prompt, pre-tool, post-tool)
- **LLM Structuring** — Memories auto-structured into `<what>/<when>/<do>/<warn>` XML format
- **Automatic Clustering** — Similar memories grouped, mature clusters promoted to reusable skills
- **Confidence Scoring** — Memories gain/lose confidence through validation feedback and usage
- **Time Decay** — Configurable half-lives per memory type (facts: 90d, context: 30d, skills: never)
- **Zero Config Search** — No keyword extraction, no regex, no caching — full embedding every time

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Code Session                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Pull Channel (on demand)         Push Channels (auto)      │
│  ┌───────────────────┐    ┌──────────────────────────────┐  │
│  │ MCP Server        │    │ UserPromptSubmit Hook        │  │
│  │ memory_search     │    │ PreToolUse Hook              │  │
│  │ memory_save       │    │ PostToolUse Hook             │  │
│  │ memory_validate   │    │ PreCompact Hook (analysis)   │  │
│  │ memory_stats      │    │ SessionEnd Hook (clustering) │  │
│  └────────┬──────────┘    └──────────────┬───────────────┘  │
│           │                              │                  │
│           └──────────┬───────────────────┘                  │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              SQLite + FTS5 + sqlite-vec                 ││
│  │              (memory.db)                                ││
│  └─────────────────────────────────────────────────────────┘│
│                      ▲                                      │
│           ┌──────────┴───────────────────┐                  │
│           │                              │                  │
│  ┌────────┴──────────┐    ┌──────────────┴───────────────┐  │
│  │ Embedding Server  │    │ LLM Server                   │  │
│  │ TCP :23811        │    │ TCP :23812                   │  │
│  │ bge-m3 (1024d)    │    │ Azure OpenAI GPT-4.1        │  │
│  └───────────────────┘    └──────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install

```bash
git clone <repo-url> persistent-memory
cd persistent-memory
npm install
```

### 2. Configure

```bash
cp config.default.js config.js
```

Edit `config.js` — set Azure OpenAI credentials (or use environment variables):

```bash
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"
export AZURE_OPENAI_KEY="your-api-key"
export AZURE_OPENAI_DEPLOYMENT="gpt-4.1"
```

### 3. Start Services

```bash
# Terminal 1: Embedding server (loads bge-m3 model, ~2GB RAM)
npm run embedding-server

# Terminal 2: LLM server (proxies Azure OpenAI)
npm run llm-server
```

### 4. Configure Claude Code

Add MCP server to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to>/persistent-memory/services/memory-mcp-server.js"]
    }
  }
}
```

Add hooks to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "type": "command",
      "command": "node <path-to>/persistent-memory/hooks/user-prompt-hook.js"
    }],
    "PreToolUse": [{
      "type": "command",
      "command": "node <path-to>/persistent-memory/hooks/pre-tool-memory-hook.js"
    }],
    "PostToolUse": [{
      "type": "command",
      "command": "node <path-to>/persistent-memory/hooks/post-tool-memory-hook.js"
    }],
    "PreCompact": [{
      "type": "command",
      "command": "node <path-to>/persistent-memory/hooks/pre-compact-hook.js"
    }],
    "SessionEnd": [{
      "type": "command",
      "command": "node <path-to>/persistent-memory/hooks/session-end-hook.js"
    }]
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid BM25 + vector search. Params: `query`, `limit?`, `type?`, `domain?` |
| `memory_save` | Save a new memory. Params: `content`, `type?`, `domain?`, `confidence?` |
| `memory_validate` | Feedback loop — helpful (+0.1) or unhelpful (-0.05). Params: `memory_id`, `is_valid` |
| `memory_stats` | System stats: total memories, type/domain distribution, cluster status |

## Hooks

| Hook | Event | Timeout | What it does |
|------|-------|---------|--------------|
| `user-prompt-hook.js` | UserPromptSubmit | 1500ms | Embeds user query → searches → injects top memories via stdout |
| `pre-tool-memory-hook.js` | PreToolUse | 300ms | Embeds tool context → searches → injects via `additionalContext` |
| `post-tool-memory-hook.js` | PostToolUse | 300ms | Embeds tool context + result → searches → injects via `additionalContext` |
| `pre-compact-hook.js` | PreCompact | async | Spawns LLM analysis of full transcript → extracts memories |
| `session-end-hook.js` | SessionEnd | async | Incremental transcript analysis + clustering + mature cluster merging |

## Configuration

All settings in `config.js` (copy from `config.default.js`):

```javascript
module.exports = {
  // TCP ports for internal services
  embeddingPort: 23811,
  llmPort: 23812,

  // Data storage
  dataDir: path.resolve(__dirname, 'data'),    // memory.db lives here
  logDir: path.resolve(__dirname, 'data', 'logs'),
  pidDir: '/tmp',

  // Azure OpenAI (for LLM structuring/analysis)
  azure: {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    apiKey: process.env.AZURE_OPENAI_KEY || '',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1',
    apiVersion: '2024-12-01-preview',
  },

  // Embedding model (HuggingFace Transformers)
  embedding: {
    model: 'Xenova/bge-m3',   // 1024 dimensions, 8192 token context
    dimensions: 1024,
  },

  // Search behavior
  search: {
    maxResults: 3,       // top-K results per query
    minSimilarity: 0.6,  // vector similarity threshold
  },

  // Clustering
  cluster: {
    similarityThreshold: 0.70,   // min similarity to join a cluster
    maturityCount: 5,            // memories needed for a mature cluster
    maturityConfidence: 0.65,    // min avg confidence for promotion
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
```

## Memory Types

| Type | Half-life | Use case |
|------|-----------|----------|
| `fact` | 90 days | Stable facts about the codebase |
| `decision` | 90 days | Architectural decisions and rationale |
| `bug` | 60 days | Bug fixes and root causes |
| `pattern` | 90 days | Recurring code patterns |
| `context` | 30 days | Session-specific context |
| `preference` | 60 days | User workflow preferences |
| `skill` | never | Promoted from mature clusters |

## Memory Lifecycle

```
1. Save          → memory_save or auto-extract from transcript
2. Structurize   → LLM converts to <what>/<when>/<do>/<warn> XML
3. Embed         → bge-m3 generates 1024-dim vector
4. Search        → BM25 + vector similarity, combined ranking
5. Validate      → memory_validate adjusts confidence ±
6. Cluster       → similar memories auto-grouped
7. Promote       → mature clusters → skill memories
8. Decay         → low-confidence memories fade over time
```

## Project Structure

```
persistent-memory/
├── config.default.js         # Configuration template (committed)
├── config.js                 # Your config (gitignored)
├── package.json
├── lib/
│   ├── memory-db.js          # Core: SQLite + FTS5 + sqlite-vec
│   ├── embedding-client.js   # TCP client for embedding server
│   ├── llm-client.js         # TCP client for LLM server
│   ├── compact-analyzer.js   # Transcript → memory extraction
│   └── utils.js              # Minimal utilities
├── services/
│   ├── embedding-server.js   # TCP embedding service (bge-m3)
│   ├── llm-server.js         # TCP LLM proxy (Azure OpenAI)
│   └── memory-mcp-server.js  # MCP server for Claude Code
├── hooks/
│   ├── user-prompt-hook.js   # UserPromptSubmit → memory injection
│   ├── pre-tool-memory-hook.js   # PreToolUse → memory injection
│   ├── post-tool-memory-hook.js  # PostToolUse → memory injection
│   ├── pre-compact-hook.js       # PreCompact → transcript analysis
│   └── session-end-hook.js       # SessionEnd → clustering
├── tools/
│   └── rebuild-vectors.js    # Rebuild all embeddings
└── data/                     # Runtime data (gitignored)
    ├── memory.db
    └── logs/
```

## Tools

```bash
# Rebuild all embeddings (after model change or migration)
npm run rebuild-vectors
```

## Requirements

- Node.js >= 18
- macOS or Linux (PID files default to `/tmp`, not supported on Windows)
- ~2GB RAM for embedding model (bge-m3)
- Azure OpenAI API access (for LLM structuring)

## Notes

- **LLM provider**: The LLM server currently only supports Azure OpenAI. If you use standard OpenAI API or other providers, you'll need to modify `services/llm-server.js` (change the endpoint URL format and authentication header).
- **Ports**: The embedding server and LLM server default to TCP ports 23811 and 23812. If these conflict with other services, change `embeddingPort` / `llmPort` in your `config.js`.
- **PID files**: Server PID files (`claude-embedding.pid`, `claude-llm.pid`) are created in `/tmp` by default. Change `pidDir` in `config.js` if needed.
- **Runtime data**: The `data/` directory (containing `memory.db` and logs) is created automatically at first run and is gitignored.

## License

MIT
