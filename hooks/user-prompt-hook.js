#!/usr/bin/env node
/**
 * User Prompt Hook - Memory retrieval on user prompt
 *
 * Stripped-down version: only performs memory search via embedding service.
 * No compact suggestion logic (that is an optional add-on, not part of core memory).
 *
 * How it works:
 *   1. Reads raw user prompt from stdin
 *   2. Extracts the actual prompt text
 *   3. Searches memories via embedding service (TCP)
 *   4. Outputs memory context + original prompt via stdout
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const config = require('../config');

const EMBEDDING_PORT = config.embeddingPort;
const TIMEOUT_MS = config.timeout.hookUserPrompt;
const SEARCH_TIMEOUT_MS = config.timeout.embeddingSearch;
const MAX_RESULTS = config.search.maxResults;
const MIN_SIMILARITY = config.search.minSimilarity;
const LOG_FILE = path.join(config.logDir, 'hook-inject.log');

/**
 * Extract the actual user prompt from raw stdin input.
 * The input may be wrapped in JSON with a "prompt" field.
 */
function extractUserPrompt(rawInput) {
  try {
    const jsonMatch = rawInput.match(/\{[\s\S]*"prompt"\s*:\s*"[\s\S]*"\s*[\s\S]*\}$/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.prompt) return parsed.prompt;
    }
  } catch (e) {}
  return rawInput;
}

// --- Embedding memory search ---

function searchViaEmbedding(query, limit) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(null); }
    }, SEARCH_TIMEOUT_MS);

    socket.connect(EMBEDDING_PORT, '127.0.0.1', () => {
      socket.write(JSON.stringify({ action: 'search', query, limit }) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      if (buffer.includes('\n') && !resolved) {
        resolved = true;
        clearTimeout(timer);
        socket.destroy();
        try {
          const response = JSON.parse(buffer.split('\n')[0]);
          resolve(response.success ? response.results : null);
        } catch { resolve(null); }
      }
    });

    socket.on('error', () => {
      if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
    });
  });
}

function formatReminder(memories) {
  const lines = ['<memory_context source="user-prompt">'];
  for (const m of memories) {
    const content = m.content || m.rawContent || '';
    const sim = m.vectorSimilarity ? m.vectorSimilarity.toFixed(2) : '?';
    lines.push(`[#${m.id} ${m.type || '?'}/${m.domain || '?'} sim=${sim}]`);
    lines.push(content);
    lines.push('');
  }
  lines.push('</memory_context>');
  return lines.join('\n');
}

// --- Main ---

async function main() {
  let userMessage = '';
  for await (const chunk of process.stdin) {
    userMessage += chunk;
  }
  userMessage = userMessage.trim();

  let resolved = false;
  const timer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      console.log(userMessage);
      process.exit(0);
    }
  }, TIMEOUT_MS);

  try {
    if (!userMessage || userMessage.length < 10) {
      clearTimeout(timer);
      if (!resolved) { resolved = true; console.log(userMessage); }
      return;
    }

    const actualPrompt = extractUserPrompt(userMessage);

    // Embedding memory search: use the full user prompt as query
    const query = actualPrompt;
    let memoryContext = '';
    if (query.length >= 5) {
      const raw = await searchViaEmbedding(query, MAX_RESULTS);
      const results = raw ? raw.filter(m => (m.vectorSimilarity || 0) >= MIN_SIMILARITY) : [];
      if (results.length > 0) {
        const ids = results.map(m => `#${m.id}(${(m.vectorSimilarity||0).toFixed(2)})`).join(' ');
        try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [user-prompt] injected: ${ids}\n`); } catch {}
        memoryContext = formatReminder(results);
      }
    }

    clearTimeout(timer);
    if (resolved) return;
    resolved = true;

    let output = '';
    if (memoryContext) {
      output += memoryContext + '\n\n';
    }

    console.log(output + userMessage);
  } catch (e) {
    clearTimeout(timer);
    if (!resolved) { resolved = true; console.log(userMessage); }
  }
}

main().catch(() => {
  let data = '';
  process.stdin.on('data', chunk => data += chunk);
  process.stdin.on('end', () => console.log(data));
});
