#!/usr/bin/env node
/**
 * PreCompact Hook - Async session analysis
 *
 * Simplified: immediately outputs stdin (does not block compact),
 * then spawns compact-analyzer in the background for LLM analysis.
 * All analysis logic is in compact-analyzer.js, handled by LLM in full.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('../config');

const LOG_FILE = path.join(config.logDir, 'compact-analyzer.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  // Output immediately, do not block compact
  console.log(input);

  try {
    const data = JSON.parse(input.trim());
    const transcriptPath = data.transcript_path;
    const sessionId = data.session_id || 'unknown';
    const cwd = data.cwd || process.cwd();

    if (!transcriptPath) return;

    // Spawn analyzer in background
    const analyzerPath = path.join(__dirname, '..', 'lib', 'compact-analyzer.js');
    const child = spawn('node', [analyzerPath, transcriptPath, sessionId, cwd], {
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();

    log(`[PreCompact] Spawned analyzer (PID ${child.pid}) for session ${sessionId}`);
  } catch (e) {
    log(`[PreCompact] Error: ${e.message}`);
  }
}

// Preserve loadMessagesFromTranscript export (backward compatibility)
const { loadMessagesFromTranscript } = require('../lib/compact-analyzer');
module.exports = { loadMessagesFromTranscript };

if (require.main === module) {
  main().catch(() => {});
}
