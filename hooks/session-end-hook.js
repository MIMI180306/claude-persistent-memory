#!/usr/bin/env node
/**
 * SessionEnd Hook - Incremental transcript analysis + clustering + mature cluster merging
 *
 * Features:
 * - Incremental transcript analysis: extract error patterns, code changes, user preferences
 * - Process unclustered memories, attempt to create new clusters
 * - Mature cluster memories automatically merged into a single high-confidence memory
 */

const path = require('path');
const fs = require('fs');

const config = require('../config');
const { log } = require('../lib/utils');

const DATA_DIR = config.dataDir;

// Clustering configuration
const MIN_CLUSTER_CONFIDENCE = 0.6;

let memoryDb = null;

function getMemoryDb() {
  if (memoryDb) return memoryDb;
  try {
    memoryDb = require('../lib/memory-db');
    return memoryDb;
  } catch (e) {
    log(`[SessionEnd] Warning: memory-db not available: ${e.message}`);
    return null;
  }
}

/**
 * Incremental transcript analysis: from last compact position to session end
 */
async function analyzeTranscriptIncremental(sessionId, transcriptPath) {
  const db = getMemoryDb();
  if (!db || !transcriptPath || !sessionId) return;

  try {
    const { analyzeAndSave } = require('../lib/compact-analyzer');

    const result = await analyzeAndSave(transcriptPath, sessionId, { memoryDb: db });
    log(`[SessionEnd] Transcript analysis: saved ${result.saved || 0} memories`);

    // Clean up state file (session ended, no longer needed)
    const stateFile = path.join(DATA_DIR, `compact-state-${sessionId}.json`);
    try {
      if (fs.existsSync(stateFile)) {
        fs.unlinkSync(stateFile);
        log(`[SessionEnd] Cleaned up state file`);
      }
    } catch (e) {}
  } catch (e) {
    log(`[SessionEnd] Error in analyzeTranscriptIncremental: ${e.message}`);
  }
}

/**
 * Process unclustered memories, attempt to create new clusters
 */
async function processUnclusteredMemories() {
  const db = getMemoryDb();
  if (!db) return;

  try {
    log('[SessionEnd] Processing unclustered memories...');

    const result = await db.autoCluster({
      minConfidence: MIN_CLUSTER_CONFIDENCE,
      hoursBack: 24
    });

    if (result.length === 0) {
      log('[SessionEnd] No new clusters created');
      return;
    }

    for (const c of result) {
      log(`[SessionEnd] Created new cluster: ${c.theme} (${c.memberCount} members, ${c.status})`);
    }
  } catch (e) {
    log(`[SessionEnd] Error in processUnclusteredMemories: ${e.message}`);
  }
}

/**
 * Mature cluster memory merging: multiple memories merged into one high-confidence memory
 */
async function mergeMatureClusters() {
  const db = getMemoryDb();
  if (!db) return;

  try {
    const matureClusters = db.getMatureClusters();
    if (matureClusters.length === 0) {
      log('[SessionEnd] No mature clusters to merge');
      return;
    }

    for (const cluster of matureClusters) {
      const result = await db.mergeClusterMemories(cluster.id);
      if (result) {
        log(`[SessionEnd] Merged cluster #${cluster.id}: "${result.summary}" (${result.memberCount} memories -> ID ${result.memoryId})`);
      }
    }
  } catch (e) {
    log(`[SessionEnd] Error in mergeMatureClusters: ${e.message}`);
  }
}

async function main() {
  log('[SessionEnd] Processing session end...');

  // Read stdin for session data
  let sessionData = {};
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    if (input.trim()) {
      sessionData = JSON.parse(input);
    }
  } catch (e) {
    log(`[SessionEnd] Failed to parse stdin: ${e.message}`);
  }

  const sessionId = sessionData.session_id;
  const transcriptPath = sessionData.transcript_path;

  log(`[SessionEnd] Session: ${sessionId || 'unknown'}, transcript: ${transcriptPath || 'none'}`);

  // 1. Incremental transcript analysis (from last compact position to session end)
  if (sessionId && transcriptPath) {
    await analyzeTranscriptIncremental(sessionId, transcriptPath);
  }

  // 2. Process unclustered memories, attempt to create new clusters
  await processUnclusteredMemories();

  // 3. Mature cluster memory merging
  await mergeMatureClusters();

  // Close database
  if (memoryDb) {
    memoryDb.closeDb();
  }

  log('[SessionEnd] Session end processing complete');
  process.exit(0);
}

main().catch(err => {
  console.error('[SessionEnd] Error:', err.message);
  process.exit(0);
});
