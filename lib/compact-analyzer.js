#!/usr/bin/env node
/**
 * Compact Analyzer - LLM-driven session analysis
 *
 * Replaces the old 900-line regex/keyword logic in pre-compact.js.
 * Sends the entire session transcript to LLM for one-shot analysis,
 * extracting memories worth saving.
 *
 * Usage:
 *   CLI:    node compact-analyzer.js <transcriptPath> <sessionId> [cwd]
 *   Module: const { analyzeAndSave, loadMessagesFromTranscript } = require('./compact-analyzer')
 *
 * Flow:
 *   1. Read transcript JSONL -> parse messages
 *   2. Condense messages into concise text (~6000 chars)
 *   3. Call llm-client.analyzeSession() -> Azure OpenAI
 *   4. Parse returned <memory> blocks
 *   5. Save to database via memory-db.save()
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const config = require('../config');
const DATA_DIR = config.dataDir;
const LOG_FILE = path.join(config.logDir, 'compact-analyzer.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

function truncate(text, maxLen) {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen) + '...';
}

// --- Transcript loading ---

/**
 * Load messages from a transcript JSONL file
 */
async function loadMessagesFromTranscript(transcriptPath) {
  const messages = [];

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log(`[Analyzer] Transcript not found: ${transcriptPath}`);
    return messages;
  }

  const fileStream = fs.createReadStream(transcriptPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      let msg = entry.message || entry.data?.message || entry.data?.message?.message;
      if (msg && msg.content) {
        messages.push({ role: msg.role, content: msg.content });
      }
    } catch (e) {
      // Skip unparseable lines
    }
  }

  return messages;
}

// --- Transcript condensation ---

/**
 * Convert message list into LLM-analyzable text
 *
 * Strategy: preserve original conversation structure, only filter large file content
 * (Read/Grep/Glob return values)
 * - Pass 1: collect tool_use id -> tool name mapping
 * - Pass 2: decide how to handle tool_result based on tool type
 */
function condenseTranscript(messages) {
  // Pass 1: build tool_use_id -> { toolName, filePath } mapping
  const toolMap = {};
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id) {
        toolMap[block.id] = {
          name: block.name,
          filePath: block.input?.file_path || block.input?.path || ''
        };
      }
    }
  }

  // Pass 2: build output
  const lines = [];

  for (const msg of messages) {
    const content = msg.content;

    // Plain text messages
    if (typeof content === 'string') {
      if (msg.role === 'user') {
        // Filter system-injected messages
        if (/<(task-notification|system-reminder|antml:|function_results)/i.test(content)) continue;
        lines.push(`[User] ${content}`);
      } else if (msg.role === 'assistant') {
        if (content.length > 10) {
          lines.push(`[Assistant] ${content}`);
        }
      }
      continue;
    }

    // Array content (tool_use / tool_result / text mix)
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        if (msg.role === 'assistant' && block.text.length > 10) {
          lines.push(`[Assistant] ${block.text}`);
        }
      } else if (block.type === 'tool_use') {
        const name = block.name;
        const input = block.input || {};
        if (name === 'Bash') {
          lines.push(`[Bash] ${input.command || ''}`);
        } else if (name === 'Edit') {
          lines.push(`[Edit] ${shortPath(input.file_path)}`);
        } else if (name === 'Write') {
          lines.push(`[Write] ${shortPath(input.file_path)}`);
        } else if (name === 'Read') {
          lines.push(`[Read] ${shortPath(input.file_path)}`);
        } else if (name === 'Grep') {
          lines.push(`[Grep] pattern="${input.pattern || ''}" path=${shortPath(input.path)}`);
        } else if (name === 'Glob') {
          lines.push(`[Glob] ${input.pattern || ''}`);
        }
        // Other tools (Task, WebSearch, etc.) skipped
      } else if (block.type === 'tool_result') {
        const toolInfo = toolMap[block.tool_use_id] || {};
        const toolName = toolInfo.name || '';
        const output = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content || '');

        // Handle return values by tool type
        if (['Read', 'Grep', 'Glob'].includes(toolName)) {
          // File content: only keep a one-line marker
          lines.push(`  -> [${toolName} returned ${output.length} chars, omitted]`);
        } else if (toolName === 'Bash') {
          // Bash output: keep detailed info for errors, truncate for success
          if (block.is_error || /error|exception|traceback|failed|denied/i.test(output.slice(0, 500))) {
            lines.push(`  -> ERROR: ${output}`);
          } else if (output.length > 0) {
            lines.push(`  -> ${output}`);
          }
        } else if (toolName === 'Edit' || toolName === 'Write') {
          // Edit/Write results are usually short
          if (output.length > 0 && output.length < 200) {
            lines.push(`  -> ${output}`);
          }
        }
      }
    }
  }

  return lines.join('\n');
}

function shortPath(filePath) {
  if (!filePath) return '';
  return filePath.split('/').slice(-3).join('/');
}

// --- Core analysis ---

/**
 * Analyze transcript and save extracted memories
 *
 * @param {string} transcriptPath - transcript JSONL path
 * @param {string} sessionId - session ID
 * @param {object} options
 * @param {string} options.cwd - working directory
 * @param {object} options.memoryDb - optional, externally provided memory-db instance
 */
async function analyzeAndSave(transcriptPath, sessionId, options = {}) {
  const { cwd } = options;

  // Load memory-db
  let db = options.memoryDb;
  if (!db) {
    try {
      db = require('./memory-db');
    } catch (e) {
      log(`[Analyzer] Failed to load memory-db: ${e.message}`);
      return { saved: 0 };
    }
  }

  // Incremental state
  const stateFile = path.join(DATA_DIR, `compact-state-${sessionId}.json`);
  let lastProcessedLine = 0;
  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      lastProcessedLine = state.lastLine || 0;
    }
  } catch (e) {}

  // Read transcript
  const allMessages = await loadMessagesFromTranscript(transcriptPath);
  const newMessages = allMessages.slice(lastProcessedLine);

  log(`[Analyzer] Session ${sessionId}: total=${allMessages.length}, lastProcessed=${lastProcessedLine}, new=${newMessages.length}`);

  if (newMessages.length < 5) {
    log(`[Analyzer] Skipping: only ${newMessages.length} new messages`);
    return { saved: 0 };
  }

  // Condense transcript
  const condensed = condenseTranscript(newMessages);
  if (condensed.length < 100) {
    log(`[Analyzer] Skipping: condensed transcript too short (${condensed.length} chars)`);
    return { saved: 0 };
  }

  log(`[Analyzer] Condensed transcript: ${condensed.length} chars`);

  // Call LLM for analysis
  let llmClient;
  try {
    llmClient = require('./llm-client');
    const available = await llmClient.isAvailable();
    if (!available) {
      log(`[Analyzer] LLM service not available`);
      return { saved: 0 };
    }
  } catch (e) {
    log(`[Analyzer] Failed to load llm-client: ${e.message}`);
    return { saved: 0 };
  }

  const result = await llmClient.analyzeSession(condensed);
  const memories = result.memories || [];

  log(`[Analyzer] LLM returned ${memories.length} memories`);

  // Save memories
  let saved = 0;
  for (const mem of memories) {
    try {
      const saveResult = await db.save(mem.summary, {
        type: mem.type,
        domain: mem.domain,
        confidence: mem.confidence || 0.8,
        source: 'compact-analyzer',
        skipStructurize: true,
        structuredContent: mem.structuredContent
      });

      if (saveResult.action === 'created') {
        saved++;
        log(`[Analyzer] Saved: #${saveResult.id} ${mem.type}/${mem.domain} - ${mem.summary}`);
      } else {
        log(`[Analyzer] ${saveResult.action}: ${mem.summary}`);
      }
    } catch (e) {
      log(`[Analyzer] Save error: ${e.message}`);
    }
  }

  // Update incremental state
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionId,
      lastLine: allMessages.length,
      updatedAt: new Date().toISOString()
    }));
  } catch (e) {
    log(`[Analyzer] Failed to save state: ${e.message}`);
  }

  // Close DB (only when loaded by CLI mode itself)
  if (!options.memoryDb && db.closeDb) {
    db.closeDb();
  }

  log(`[Analyzer] Done: saved ${saved}/${memories.length} memories`);
  return { saved, total: memories.length };
}

// --- Exports ---

module.exports = { analyzeAndSave, loadMessagesFromTranscript };

// --- CLI mode ---

if (require.main === module) {
  const [transcriptPath, sessionId, cwd] = process.argv.slice(2);

  if (!transcriptPath || !sessionId) {
    console.error('Usage: node compact-analyzer.js <transcriptPath> <sessionId> [cwd]');
    process.exit(1);
  }

  analyzeAndSave(transcriptPath, sessionId, { cwd })
    .then(result => {
      log(`[Analyzer-CLI] Finished: ${JSON.stringify(result)}`);
      process.exit(0);
    })
    .catch(e => {
      log(`[Analyzer-CLI] Error: ${e.message}`);
      process.exit(1);
    });
}
