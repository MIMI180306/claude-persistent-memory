#!/usr/bin/env node
/**
 * PostToolUse Memory Hook - Result-triggered memory Push
 *
 * How it works:
 *   1. Reads {tool_name, tool_input, tool_response} from stdin
 *   2. Concatenates all context into a query (tool name, file paths, commands, content, output, etc.)
 *   3. Performs vector search via embedding service (TCP)
 *   4. Injects found memories via JSON stdout additionalContext into Claude context
 *
 * Performance budget: < 300ms
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const config = require('../config');

const EMBEDDING_PORT = config.embeddingPort;
const TIMEOUT_MS = config.timeout.hookPostTool;
const MAX_RESULTS = config.search.maxResults;
const MIN_SIMILARITY = config.search.minSimilarity;
const LOG_FILE = path.join(config.logDir, 'hook-inject.log');

function output(additionalContext) {
  const result = {};
  if (additionalContext) {
    result.hookSpecificOutput = {
      hookEventName: 'PostToolUse',
      additionalContext,
    };
  }
  console.log(JSON.stringify(result));
}

/**
 * Concatenate tool_input + tool_response fields into a single query string
 */
function buildQuery(tool, toolInput, toolResponse) {
  const parts = [tool];
  if (toolInput.file_path) parts.push(toolInput.file_path);
  if (toolInput.command) parts.push(toolInput.command);
  if (toolInput.description) parts.push(toolInput.description);
  if (toolInput.old_string) parts.push(toolInput.old_string);
  if (toolInput.new_string) parts.push(toolInput.new_string);
  if (toolInput.content) parts.push(toolInput.content);
  if (toolInput.pattern) parts.push(toolInput.pattern);
  if (toolInput.path) parts.push(toolInput.path);
  if (toolResponse) {
    const responseStr = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
    parts.push(responseStr.slice(0, 500));
  }
  return parts.join(' ');
}

function searchViaEmbedding(query, limit) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(null); }
    }, TIMEOUT_MS - 50);

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
  const lines = ['<memory_context source="post-tool">'];
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

async function main() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; }

  const failsafe = setTimeout(() => {
    output();
    process.exit(0);
  }, TIMEOUT_MS);

  try {
    const data = JSON.parse(input.trim());
    const tool = data.tool_name;
    const toolInput = data.tool_input || {};
    const toolResponse = data.tool_response || '';

    if (!['Bash', 'Edit', 'Write'].includes(tool)) {
      clearTimeout(failsafe);
      output();
      return;
    }

    const query = buildQuery(tool, toolInput, toolResponse);
    if (!query || query.length < 5) {
      clearTimeout(failsafe);
      output();
      return;
    }

    const raw = await searchViaEmbedding(query, MAX_RESULTS);
    clearTimeout(failsafe);
    const results = raw ? raw.filter(m => (m.vectorSimilarity || 0) >= MIN_SIMILARITY) : [];

    if (results.length > 0) {
      const ids = results.map(m => `#${m.id}(${(m.vectorSimilarity||0).toFixed(2)})`).join(' ');
      try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [post-tool] injected: ${ids}\n`); } catch {}
      output(formatReminder(results));
    } else {
      output();
    }
  } catch {
    clearTimeout(failsafe);
    output();
  }
}

main().catch(() => {
  output();
  process.exit(0);
});
