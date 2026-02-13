<p align="center">
  <img src="./assets/logo.png" alt="Claude Persistent Memory" width="120" />
</p>

<h1 align="center">Claude Persistent Memory</h1>

<p align="center">
  <strong>Give Claude Code long-term memory that persists across sessions.</strong><br/>
  Hybrid BM25 + vector semantic search · LLM-driven structuring · 4-channel retrieval (MCP + hooks)
</p>

<p align="center">
  <a href="https://github.com/MIMI180306/claude-persistent-memory/blob/main/LICENSE"><img src="https://img.shields.io/github/license/MIMI180306/claude-persistent-memory?style=flat-square&color=blue" alt="License"></a>
  <a href="https://github.com/MIMI180306/claude-persistent-memory/stargazers"><img src="https://img.shields.io/github/stars/MIMI180306/claude-persistent-memory?style=flat-square&color=yellow" alt="Stars"></a>
  <a href="https://github.com/MIMI180306/claude-persistent-memory/issues"><img src="https://img.shields.io/github/issues/MIMI180306/claude-persistent-memory?style=flat-square" alt="Issues"></a>
  <a href="https://github.com/MIMI180306/claude-persistent-memory/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/MIMI180306/claude-persistent-memory/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" alt="Node >= 18">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform">
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#mcp-tools">MCP Tools</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#contributing">Contributing</a>
</p>

---

<!-- TODO: Add a GIF demo here showing the memory system in action
<p align="center">
  <img src="./assets/demo.gif" alt="Demo" width="700" />
</p>
-->

## Features

🧠 **Hybrid Search** — BM25 full-text (FTS5) + vector semantic similarity (sqlite-vec), combined ranking

📡 **4-Channel Retrieval** — Pull (MCP tools) + Push (auto-inject via hooks on user prompt, pre-tool, post-tool)

🏗️ **LLM Structuring** — Memories auto-structured into `<what>/<when>/<do>/<warn>` XML format

📦 **Automatic Clustering** — Similar memories grouped, mature clusters promoted to reusable skills

📊 **Confidence Scoring** — Memories gain/lose confidence through validation feedback and usage

⏳ **Time Decay** — Configurable half-lives per memory type (facts: 90d, context: 30d, skills: never)

🔒 **Local-First** — All data stored locally in SQLite. Your memories never leave your machine.

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
git clone https://github.com/MIMI180306/claude-persistent-memory.git
cd claude-persistent-memory
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
      "args": ["<path-to>/claude-persistent-memory/services/memory-mcp-server.js"]
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
      "command": "node <path-to>/claude-persistent-memory/hooks/user-prompt-hook.js"
    }],
    "PreToolUse": [{
      "type": "command",
      "command": "node <path-to>/claude-persistent-memory/hooks/pre-tool-memory-hook.js"
    }],
    "PostToolUse": [{
      "type": "command",
      "command": "node <path-to>/claude-persistent-memory/hooks/post-tool-memory-hook.js"
    }],
    "PreCompact": [{
      "type": "command",
      "command": "node <path-to>/claude-persistent-memory/hooks/pre-compact-hook.js"
    }],
    "SessionEnd": [{
      "type": "command",
      "command": "node <path-to>/claude-persistent-memory/hooks/session-end-hook.js"
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
|------|-------|---------|-------------|
| `user-prompt-hook.js` | UserPromptSubmit | 1500ms | Embeds user query → searches → injects top memories via stdout |
| `pre-tool-memory-hook.js` | PreToolUse | 300ms | Embeds tool context → searches → injects via `additionalContext` |
| `post-tool-memory-hook.js` | PostToolUse | 300ms | Embeds tool context + result → searches → injects via `additionalContext` |
| `pre-compact-hook.js` | PreCompact | async | Spawns LLM analysis of full transcript → extracts memories |
| `session-end-hook.js` | SessionEnd | async | Incremental transcript analysis + clustering + mature cluster merging |

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
1. Save       → memory_save or auto-extract from transcript
2. Structure  → LLM converts to <what>/<when>/<do>/<warn> XML
3. Embed      → bge-m3 generates 1024-dim vector
4. Search     → BM25 + vector similarity, combined ranking
5. Validate   → memory_validate adjusts confidence ±
6. Cluster    → similar memories auto-grouped
7. Promote    → mature clusters → skill memories
8. Decay      → low-confidence memories fade over time
```

## Configuration

All settings in `config.js` (copy from `config.default.js`):

```js
module.exports = {
  embeddingPort: 23811,          // TCP port for embedding server
  llmPort: 23812,                // TCP port for LLM server
  dataDir: './data',             // memory.db lives here
  azure: {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    apiKey: process.env.AZURE_OPENAI_KEY || '',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1',
  },
  embedding: {
    model: 'Xenova/bge-m3',     // 1024 dimensions, 8192 token context
    dimensions: 1024,
  },
  search: {
    maxResults: 3,               // top-K results per query
    minSimilarity: 0.6,          // vector similarity threshold
  },
  cluster: {
    similarityThreshold: 0.70,   // min similarity to join a cluster
    maturityCount: 5,            // memories needed for mature cluster
  },
};
```

## Project Structure

```
claude-persistent-memory/
├── hooks/                        # Claude Code lifecycle hooks
│   ├── user-prompt-hook.js       # UserPromptSubmit → memory injection
│   ├── pre-tool-memory-hook.js   # PreToolUse → memory injection
│   ├── post-tool-memory-hook.js  # PostToolUse → memory injection
│   ├── pre-compact-hook.js       # PreCompact → transcript analysis
│   └── session-end-hook.js       # SessionEnd → clustering
├── lib/                          # Core libraries
│   ├── memory-db.js              # SQLite + FTS5 + sqlite-vec
│   ├── embedding-client.js       # TCP client for embedding server
│   ├── llm-client.js             # TCP client for LLM server
│   ├── compact-analyzer.js       # Transcript → memory extraction
│   └── utils.js                  # Minimal utilities
├── services/                     # Background services
│   ├── embedding-server.js       # TCP embedding service (bge-m3)
│   ├── llm-server.js             # TCP LLM proxy (Azure OpenAI)
│   └── memory-mcp-server.js      # MCP server for Claude Code
├── tools/
│   └── rebuild-vectors.js        # Rebuild all embeddings
├── config.default.js             # Configuration template
├── CLAUDE.md                     # Claude Code project instructions
└── package.json
```

## Requirements

- Node.js >= 18
- macOS or Linux
- ~2GB RAM for embedding model (bge-m3)
- Azure OpenAI API access (for LLM structuring)

## Notes

- **LLM provider**: Currently supports Azure OpenAI only. For standard OpenAI or other providers, modify `services/llm-server.js`.
- **Ports**: Embedding and LLM servers default to TCP 23811 / 23812. Change in `config.js` if needed.
- **Data**: The `data/` directory (containing `memory.db` and logs) is created automatically and gitignored.

## Contributing

Contributions are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) before submitting a PR.

## License

[MIT](LICENSE) © MIMI180306
