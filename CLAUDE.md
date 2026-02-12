# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A persistent memory system for Claude Code — hybrid BM25 + vector semantic search with LLM-driven structuring and automatic clustering. It gives Claude Code sessions long-term memory that persists across conversations.

## Commands

```bash
npm run embedding-server   # Start embedding service (TCP :23811, loads bge-m3 ~2GB RAM)
npm run llm-server         # Start LLM proxy service (TCP :23812, requires Azure OpenAI)
npm run mcp-server         # Start MCP server (stdio, used by Claude Code)
npm run rebuild-vectors    # Rebuild all embeddings (after model change)
```

Both TCP servers must be running for full functionality. The MCP server is configured in `.mcp.json` and launched by Claude Code automatically. Hooks are configured in `.claude/settings.json`.

## Architecture

The system has two retrieval channels:

**Pull channel** — MCP server (`services/memory-mcp-server.js`) exposes 4 tools (`memory_search`, `memory_save`, `memory_validate`, `memory_stats`) that Claude invokes on demand via stdio.

**Push channel** — 5 hooks auto-inject memory context into Claude's conversation:
- `UserPromptSubmit` → embeds user query, searches, prepends results to prompt via stdout
- `PreToolUse` → searches on Edit/Write/Bash tool context, injects via `additionalContext`
- `PostToolUse` → searches on tool context + result, injects via `additionalContext`
- `PreCompact` → spawns `compact-analyzer.js` in background (non-blocking), which sends full transcript to LLM for memory extraction
- `SessionEnd` → incremental transcript analysis + auto-clustering + mature cluster merging

### Internal service communication

Hooks and MCP server communicate with the two TCP servers via `lib/embedding-client.js` and `lib/llm-client.js`. Both clients use raw TCP sockets with newline-delimited JSON protocol.

### Data layer

`lib/memory-db.js` is the core module — manages SQLite database with three virtual tables:
- `memories` — main table with structured content, confidence scores, cluster assignments
- `memories_fts` — FTS5 full-text search (BM25 ranking, synced via triggers)
- `memories_vec` — sqlite-vec cosine similarity (1024-dim bge-m3 embeddings)

Search combines both: `0.7 * vectorSimilarity + 0.3 * normalizedBM25`.

### Memory lifecycle

Save → LLM structurize (to `<what>/<when>/<do>/<warn>` XML) → embed (structured_content + domain) → deduplicate (Jaccard ≥ 0.95) → incremental clustering → mature cluster merging → time decay

## Key Design Decisions

- **Bilingual support**: Chinese n-gram LIKE search for FTS gaps; stopwords for both languages
- **Structured content as XML**: `<memory type="..." domain="..."><what>...<when>...<do>...<warn>...</memory>` — different memory types use different field subsets
- **Embedding input**: `buildEmbeddingText()` prepends domain tag to structured_content for richer semantic vectors
- **Hooks use strict timeouts**: PreToolUse/PostToolUse 300ms, UserPromptSubmit 1500ms — always output/exit on timeout, never block Claude
- **LLM server uses Azure OpenAI** (GPT-4.1) via native `https` module — no SDK dependency
- **sqlite-vec requires BigInt rowids** when inserting vectors

## Configuration

Copy `config.default.js` → `config.js` (gitignored). Set Azure credentials via env vars `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT`. All timeouts, search thresholds, clustering params, and port numbers are in config.

## Runtime Data

`data/` directory (gitignored) contains `memory.db` and `logs/`. PID files go to `/tmp/`.
