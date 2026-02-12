#!/usr/bin/env node
/**
 * Memory MCP Server [v1.0]
 *
 * Pull model: exposes memory search as MCP tools, invoked by Claude on demand.
 * Complements the Push model (hooks that auto-inject context).
 *
 * Tools:
 *   - memory_search: hybrid search (BM25 + vector similarity)
 *   - memory_save:   save new memory
 *   - memory_validate: validate memory usefulness (adjust confidence)
 *   - memory_stats:  view memory statistics
 *
 * Transport: stdio (Claude Code standard)
 */

const path = require('path');

// Try standard import first, fallback to manual path resolution
let McpServer, StdioServerTransport;
try {
  ({ McpServer } = require('@modelcontextprotocol/sdk/dist/cjs/server/mcp.js'));
  ({ StdioServerTransport } = require('@modelcontextprotocol/sdk/dist/cjs/server/stdio.js'));
} catch (e) {
  const SDK_DIR = path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'server');
  ({ McpServer } = require(path.join(SDK_DIR, 'mcp.js')));
  ({ StdioServerTransport } = require(path.join(SDK_DIR, 'stdio.js')));
}
const z = require('zod');

// ============ Memory modules ============

const memoryDb = require('../lib/memory-db');

// Embedding client for hybrid search via embedding server
let embeddingClient;
try {
  embeddingClient = require('../lib/embedding-client');
} catch (e) {
  // embedding-client not available, will fall back to memoryDb.search
}

/**
 * Execute hybrid search (prefer embedding service, fallback to inline search)
 */
async function hybridSearch(query, limit, options = {}) {
  let useEmbeddingService = false;

  if (embeddingClient) {
    try {
      useEmbeddingService = await embeddingClient.isServerRunning();
    } catch (e) {
      // ignore
    }
  }

  if (useEmbeddingService) {
    return embeddingClient.search(query, limit);
  }

  // Fallback: inline hybrid search
  try {
    return await memoryDb.search(query, limit, options);
  } catch (e) {
    // Final fallback: pure BM25
    const keywords = memoryDb.extractKeywords(query);
    const ftsQuery = keywords.map(k => `"${k}"`).join(' OR ');
    return memoryDb.quickSearch(ftsQuery, limit);
  }
}

// ============ MCP Server definition ============

const server = new McpServer({
  name: 'memory',
  version: '1.0.0'
});

// --- Tool: memory_search ---
server.tool(
  'memory_search',
  'Search persistent memories (hybrid BM25 + vector semantic retrieval). Use when you need to recall previous context, patterns, decisions, or bug fix records.',
  {
    query: z.string().describe('Search query (natural language, supports Chinese and English)'),
    limit: z.number().optional().default(5).describe('Number of results to return (default 5)'),
    type: z.enum(['fact', 'decision', 'bug', 'pattern', 'context', 'preference', 'skill']).optional().describe('Filter by memory type'),
    domain: z.enum(['orm', 'api', 'frontend', 'backend', 'testing', 'memory', 'general']).optional().describe('Filter by domain')
  },
  async ({ query, limit = 5, type, domain }) => {
    try {
      const options = {};
      if (type) options.type = type;
      if (domain) options.domain = domain;

      const results = await hybridSearch(query, limit, options);

      if (!results || results.length === 0) {
        return {
          content: [{ type: 'text', text: 'No relevant memories found.' }]
        };
      }

      // Mark memories as used
      const usedIds = results.map(r => r.id).filter(Boolean);
      if (usedIds.length > 0) {
        memoryDb.markMemoriesUsed(usedIds);
      }

      // Format results
      const formatted = results.map((r, i) => {
        const confidence = r.confidence ? `${Math.round(r.confidence * 100)}%` : 'N/A';
        const vecSim = r.vectorSimilarity ? r.vectorSimilarity.toFixed(3) : 'N/A';
        const bm25 = r.bm25Score ? r.bm25Score.toFixed(1) : '0';
        const date = r.createdAt ? r.createdAt.slice(0, 10) : r.date || 'unknown';

        let content = r.content || r.rawContent || '';
        // Truncate overly long content
        if (content.length > 500) {
          content = content.slice(0, 500) + '...';
        }

        return [
          `## Memory #${r.id} [${r.type || 'unknown'}/${r.domain || 'general'}] (confidence: ${confidence})`,
          `date: ${date} | vecSim: ${vecSim} | BM25: ${bm25}`,
          '',
          content
        ].join('\n');
      });

      return {
        content: [{
          type: 'text',
          text: `Found ${results.length} relevant memories:\n\n${formatted.join('\n\n---\n\n')}`
        }]
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Search failed: ${e.message}` }],
        isError: true
      };
    }
  }
);

// --- Tool: memory_save ---
server.tool(
  'memory_save',
  'Save a new persistent memory. Use to record important patterns, decisions, bug fixes, user preferences, etc.',
  {
    content: z.string().describe('Memory content to save'),
    type: z.enum(['fact', 'decision', 'bug', 'pattern', 'context', 'preference']).optional().default('context').describe('Memory type'),
    domain: z.enum(['orm', 'api', 'frontend', 'backend', 'testing', 'memory', 'general']).optional().default('general').describe('Domain'),
    confidence: z.number().min(0.3).max(0.9).optional().default(0.7).describe('Confidence (0.3-0.9)')
  },
  async ({ content, type = 'context', domain = 'general', confidence = 0.7 }) => {
    try {
      const result = await memoryDb.save(content, {
        type,
        domain,
        confidence,
        source: 'mcp-tool'
      });

      return {
        content: [{
          type: 'text',
          text: `Memory saved (ID: ${result.id}, type: ${type}, domain: ${domain}, confidence: ${confidence})`
        }]
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Save failed: ${e.message}` }],
        isError: true
      };
    }
  }
);

// --- Tool: memory_validate ---
server.tool(
  'memory_validate',
  'Validate whether a memory was helpful. Helpful increases confidence by +0.1, unhelpful decreases by -0.05.',
  {
    memory_id: z.number().describe('Memory ID'),
    is_valid: z.boolean().describe('Whether the memory was helpful (true=helpful, false=not helpful)')
  },
  async ({ memory_id, is_valid }) => {
    try {
      memoryDb.validateMemory(memory_id, is_valid);
      const action = is_valid ? 'increased +0.1' : 'decreased -0.05';
      return {
        content: [{
          type: 'text',
          text: `Memory #${memory_id} validated, confidence ${action}`
        }]
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Validation failed: ${e.message}` }],
        isError: true
      };
    }
  }
);

// --- Tool: memory_stats ---
server.tool(
  'memory_stats',
  'View memory system statistics: total memories, type distribution, domain distribution, cluster status, etc.',
  {},
  async () => {
    try {
      const stats = memoryDb.getStats();

      const lines = [
        `## Memory System Statistics`,
        `- Total memories: ${stats.totalMemories}`,
        `- Total clusters: ${stats.totalClusters} (mature: ${stats.matureClusters})`,
        `- Promoted memories: ${stats.promotedCount}`,
        '',
        '### By Type',
        ...Object.entries(stats.byType).map(([k, v]) => `  - ${k}: ${v}`),
        '',
        '### By Domain',
        ...Object.entries(stats.byDomain).map(([k, v]) => `  - ${k}: ${v}`)
      ];

      return {
        content: [{ type: 'text', text: lines.join('\n') }]
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Failed to get stats: ${e.message}` }],
        isError: true
      };
    }
  }
);

// ============ Start server ============

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP server is now running via stdio
  // stderr is used for logs, does not affect MCP protocol communication
  process.stderr.write('[memory-mcp] Server started\n');
}

main().catch(e => {
  process.stderr.write(`[memory-mcp] Fatal: ${e.message}\n`);
  process.exit(1);
});
