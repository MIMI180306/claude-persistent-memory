#!/usr/bin/env node
/**
 * Memory Database Module - Core Memory System v4.5
 *
 * Features:
 * - SQLite + sqlite-vec vector storage
 * - FTS5 full-text search (BM25)
 * - Incremental clustering
 * - Confidence management
 * - Automatic Skill generation
 * - [v4.5] LLM structured memory
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ============== Configuration ==============

const config = require('../config');
const { ensureDir } = require('./utils');

const DATA_DIR = config.dataDir;
const LOG_DIR = config.logDir;
const DB_PATH = path.join(DATA_DIR, 'memory.db');
const LOG_FILE = path.join(LOG_DIR, 'memory-db-calls.log');

// Ensure directories exist
ensureDir(DATA_DIR);
ensureDir(LOG_DIR);

function _str(v) { return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); }

function _log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

// Stopwords
const STOPWORDS = new Set([
  '的', '是', '在', '有', '和', '了', '我', '你', '这', '那', '吗', '呢', '啊',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how', 'can', 'do',
  'does', 'did', 'will', 'would', 'could', 'should', 'to', 'for', 'of', 'in',
  'on', 'at', 'by', 'with', 'from', 'as', 'it', 'this', 'that', 'be', 'have'
]);

// Clustering configuration
const CLUSTER_SIMILARITY_THRESHOLD = config.cluster.similarityThreshold;
const CLUSTER_MATURITY_COUNT = config.cluster.maturityCount;
const CLUSTER_MATURITY_CONFIDENCE = config.cluster.maturityConfidence;

// [v4.5] LLM structuring configuration
const STRUCTURIZE_CONFIG = {
  enabled: true,
  cliCommand: 'claude',  // Claude CLI command
  timeout: 30000,        // 30-second timeout
  model: 'haiku',        // Use haiku to reduce cost
};

// Time decay configuration
const TIME_DECAY_CONFIG = {
  fact: { halfLifeDays: 90, minWeight: 0.3 },
  decision: { halfLifeDays: 90, minWeight: 0.3 },
  bug: { halfLifeDays: 60, minWeight: 0.3 },
  pattern: { halfLifeDays: 90, minWeight: 0.4 },
  preference: { halfLifeDays: 60, minWeight: 0.2 },
  context: { halfLifeDays: 30, minWeight: 0.2 },
  session: { halfLifeDays: 14, minWeight: 0.1 },
  learned: { halfLifeDays: 90, minWeight: 0.4 },
  skill: { halfLifeDays: Infinity, minWeight: 1.0 },  // [v4.5] Skill descriptions never decay
  permanent: { halfLifeDays: Infinity, minWeight: 1.0 }
};

// ============== Database Management ==============

let db = null;
let embeddingModel = null;

function getDb() {
  if (db) return db;

  try {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);

    // Load sqlite-vec extension
    try {
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(db);
    } catch (e) {
      console.error('[memory-db] Warning: sqlite-vec not loaded:', e.message);
    }

    initTables();
    return db;
  } catch (e) {
    console.error('[memory-db] Failed to initialize database:', e.message);
    throw e;
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function initTables() {
  // Main memories table
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      structured_content TEXT,
      summary TEXT,
      type TEXT DEFAULT 'context',
      tags TEXT,
      keywords TEXT,
      domain TEXT DEFAULT 'general',
      confidence REAL DEFAULT 0.5,
      evidence_count INTEGER DEFAULT 0,
      cluster_id INTEGER,
      source TEXT,
      trigger TEXT,
      action TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_accessed_at DATETIME,
      access_count INTEGER DEFAULT 0,
      promoted_at DATETIME,
      FOREIGN KEY (cluster_id) REFERENCES clusters(id)
    )
  `);

  // [v4.5] Add structured_content column (if it doesn't exist)
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN structured_content TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

  // FTS5 full-text search table - [v4.5] added structured_content
  // Note: if the table already exists with a different schema, it needs to be rebuilt
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, structured_content, summary, tags, keywords,
        content='memories',
        content_rowid='id'
      )
    `);
  } catch (e) {
    // If FTS table already exists with a different schema, it may need rebuilding
    // For now, ignore and use the existing table
  }

  // Vector table (if sqlite-vec is available, use cosine distance)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        embedding float[${config.embedding.dimensions}] distance_metric=cosine
      )
    `);
  } catch (e) {
    // sqlite-vec not available, skip
  }

  // Clusters table
  db.exec(`
    CREATE TABLE IF NOT EXISTS clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      theme TEXT NOT NULL,
      centroid_id INTEGER,
      centroid_vector TEXT,
      member_count INTEGER DEFAULT 0,
      avg_confidence REAL DEFAULT 0.5,
      domain TEXT DEFAULT 'general',
      status TEXT DEFAULT 'growing',
      skill_path TEXT,
      evolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
    CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
    CREATE INDEX IF NOT EXISTS idx_memories_cluster_id ON memories(cluster_id);
    CREATE INDEX IF NOT EXISTS idx_memories_promoted ON memories(promoted_at);
    CREATE INDEX IF NOT EXISTS idx_clusters_status ON clusters(status);
  `);

  // FTS triggers - [v4.5] includes structured_content
  // Drop old triggers before creating new ones
  db.exec(`DROP TRIGGER IF EXISTS memories_ai`);
  db.exec(`DROP TRIGGER IF EXISTS memories_ad`);
  db.exec(`DROP TRIGGER IF EXISTS memories_au`);

  db.exec(`
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, structured_content, summary, tags, keywords)
      VALUES (NEW.id, NEW.content, NEW.structured_content, NEW.summary, NEW.tags, NEW.keywords);
    END;

    CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, structured_content, summary, tags, keywords)
      VALUES ('delete', OLD.id, OLD.content, OLD.structured_content, OLD.summary, OLD.tags, OLD.keywords);
    END;

    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, structured_content, summary, tags, keywords)
      VALUES ('delete', OLD.id, OLD.content, OLD.structured_content, OLD.summary, OLD.tags, OLD.keywords);
      INSERT INTO memories_fts(rowid, content, structured_content, summary, tags, keywords)
      VALUES (NEW.id, NEW.content, NEW.structured_content, NEW.summary, NEW.tags, NEW.keywords);
    END;
  `);
}

// ============== Embedding Model ==============
// [v6.2] Uses @huggingface/transformers + bge-m3 (ONNX)
// Replaces bge-base-zh-v1.5, 8192 token context, 1024 dimensions, multilingual support

let _pipeline = null;  // transformers.js pipeline instance

async function getEmbeddingModel() {
  if (_pipeline) return _pipeline;

  try {
    const { pipeline } = await import('@huggingface/transformers');
    console.error('[memory-db] Loading bge-m3 via transformers.js...');
    _pipeline = await pipeline('feature-extraction', config.embedding.model, {
      device: 'cpu'
    });
    console.error('[memory-db] Embedding model ready (bge-m3)');
    return _pipeline;
  } catch (e) {
    console.error('[memory-db] Failed to load embedding model:', e.message);
    return null;
  }
}

async function getEmbedding(text) {
  const startTime = Date.now();
  _log(`[EMBEDDING-REQ] text=${_str(text)}`);
  const extractor = await getEmbeddingModel();
  if (!extractor) {
    _log(`[EMBEDDING-ERR] model not available`);
    return null;
  }

  try {
    const output = await extractor(text, { pooling: 'cls', normalize: true });
    const vector = Array.from(output.data);
    const duration = Date.now() - startTime;
    _log(`[EMBEDDING-RES] duration=${duration}ms dim=${vector.length} norm=${Math.sqrt(vector.reduce((s, v) => s + v * v, 0)).toFixed(4)}`);
    return vector;
  } catch (e) {
    const duration = Date.now() - startTime;
    _log(`[EMBEDDING-ERR] duration=${duration}ms error=${e.message}`);
    console.error('[memory-db] Failed to get embedding:', e.message);
    return null;
  }
}

async function warmupEmbedding() {
  await getEmbeddingModel();
}

/**
 * Build embedding input text: structured_content + domain
 * Enriches the vector with more semantic information
 */
function buildEmbeddingText(content, domain) {
  const parts = [];
  if (domain && domain !== 'general') {
    parts.push(`[${domain}]`);
  }
  parts.push(content);
  return parts.join(' ');
}

// ============== [v4.5] LLM Structuring ==============

/**
 * Use LLM service to structurize raw memory content
 * @param {string} rawContent - Raw content
 * @param {string} type - Memory type
 * @returns {object|null} Structured result
 */
async function structurizeWithLLM(rawContent, type) {
  if (!STRUCTURIZE_CONFIG.enabled) return null;

  const startTime = Date.now();
  _log(`[STRUCTURIZE-REQ] type=${type} content=${_str(rawContent)}`);

  try {
    // Use llm-client to call llm-server (avoid claude --print triggering hooks causing recursion)
    const llmClient = require('./llm-client');
    if (await llmClient.isAvailable()) {
      const structured = await llmClient.structurize(rawContent, type);
      const duration = Date.now() - startTime;
      _log(`[STRUCTURIZE-RES] duration=${duration}ms result=${_str(structured)}`);
      // LLM determined not worth saving
      if (structured && structured.reject) {
        _log(`[STRUCTURIZE-REJECT] reason=${structured.reason || 'low value'}`);
        return { __rejected: true, reason: structured.reason };
      }
      return structured;
    }
    _log(`[STRUCTURIZE-ERR] llm-server not available`);
    return null;
  } catch (e) {
    const duration = Date.now() - startTime;
    _log(`[STRUCTURIZE-ERR] duration=${duration}ms error=${e.message}`);
    console.error('[memory-db] LLM structurize failed:', e.message);
    return null;
  }
}

/**
 * [v6.1] Format a structured object as XML
 *
 * Field descriptions:
 *   <what>  Core content (required)
 *   <when>  Trigger scenario / applicable timing
 *   <do>    Specific operations, commands, code
 *   <warn>  Warnings, prohibitions, caveats
 *
 * Different types use different field subsets:
 *   fact:       <what>
 *   pattern:    <what> + <when> + <do> + <warn>
 *   decision:   <what> + <warn>
 *   preference: <what> + <warn>
 *   bug:        <what> + <do>
 *   context:    <what> + <when>
 *   skill:      <what>
 */
function formatStructuredContent(structured, type = 'context', domain = 'general') {
  if (!structured) return null;

  // Collect content for each field
  const what = structured.summary || '';
  const when = (structured.scenarios && structured.scenarios.length > 0)
    ? structured.scenarios.join(' | ')
    : '';

  // <do> = must rules + prefer rules (merged into actionable instructions)
  const doItems = [];
  if (structured.rules?.must) doItems.push(...structured.rules.must);
  if (structured.rules?.prefer) doItems.push(...structured.rules.prefer);
  const doText = doItems.join('；');

  // <warn> = must_not rules
  const warnText = (structured.rules?.must_not && structured.rules.must_not.length > 0)
    ? structured.rules.must_not.join('；')
    : '';

  // Select fields based on type
  const fields = [];
  if (what) fields.push(`  <what>${escapeXml(what)}</what>`);

  const needsWhen = ['pattern', 'context'].includes(type);
  const needsDo = ['pattern', 'bug'].includes(type);
  const needsWarn = ['pattern', 'decision', 'preference'].includes(type);

  if (needsWhen && when) fields.push(`  <when>${escapeXml(when)}</when>`);
  if (needsDo && doText) fields.push(`  <do>${escapeXml(doText)}</do>`);
  if (needsWarn && warnText) fields.push(`  <warn>${escapeXml(warnText)}</warn>`);

  if (fields.length === 0) return null;

  return [
    `<memory type="${type}" domain="${domain}">`,
    ...fields,
    '</memory>'
  ].join('\n');
}

/**
 * XML escaping
 */
function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============== Core Functions ==============

/**
 * Save a memory (with automatic incremental clustering)
 * [v4.5] Added LLM structuring support
 */
async function save(content, options = {}) {
  const database = getDb();

  const {
    type = 'context',
    domain = 'general',
    tags = '',
    confidence = 0.5,
    source = 'user',
    trigger = null,
    action = null,
    skipClustering = false,
    skipStructurize = false,  // [v4.5] Whether to skip structuring
    structuredContent: preStructuredContent = null  // [v6.1] Pre-structured XML (skip LLM)
  } = options;

  // Generate summary
  const summary = content.length > 100 ? content.slice(0, 100) + '...' : content;

  // Extract keywords
  const keywords = extractKeywords(content).join(',');

  // Deduplication check
  const existing = database.prepare(`
    SELECT id, content, confidence FROM memories
    WHERE type = ? AND domain = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(type, domain);

  for (const e of existing) {
    const similarity = textSimilarity(content, e.content);
    if (similarity >= 0.95) {
      // Update access time and confidence of existing memory
      database.prepare(`
        UPDATE memories
        SET last_accessed_at = CURRENT_TIMESTAMP,
            access_count = access_count + 1,
            confidence = MIN(0.9, confidence + 0.05)
        WHERE id = ?
      `).run(e.id);
      return { id: e.id, action: 'updated', similarity };
    }
  }

  // [v6.1] LLM structuring -> XML
  let structuredContent = preStructuredContent || null;
  if (!structuredContent && !skipStructurize && STRUCTURIZE_CONFIG.enabled) {
    console.log('[memory-db] Structurizing with LLM...');
    const structured = await structurizeWithLLM(content, type);
    if (structured && structured.__rejected) {
      console.log(`[memory-db] Rejected by LLM: ${structured.reason}`);
      return { id: null, action: 'rejected', reason: structured.reason };
    }
    if (structured) {
      if (typeof structured === 'string' && structured.startsWith('<memory')) {
        // LLM returned XML directly
        structuredContent = structured;
      } else if (typeof structured === 'object') {
        // Legacy format object -> format as XML
        structuredContent = formatStructuredContent(structured, type, domain);
      }
      console.log('[memory-db] Structured content:', structuredContent);
    }
  }

  // Insert new memory
  const result = database.prepare(`
    INSERT INTO memories (content, structured_content, summary, type, tags, keywords, domain, confidence, source, trigger, action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(content, structuredContent, summary, type, tags, keywords, domain, confidence, source, trigger, action);

  const memoryId = Number(result.lastInsertRowid);

  // Generate embedding vector (using structured_content + domain for better semantic quality)
  const embeddingText = buildEmbeddingText(structuredContent || content, domain);
  const embedding = await getEmbedding(embeddingText);
  if (embedding) {
    try {
      // sqlite-vec requires BigInt as rowid
      database.prepare(`
        INSERT INTO memories_vec (rowid, embedding)
        VALUES (?, ?)
      `).run(BigInt(memoryId), JSON.stringify(embedding));
    } catch (e) {
      console.error('[memory-db] Vector insert failed:', e.message);
    }
  }

  // Incremental clustering
  let clusterResult = null;
  if (!skipClustering && embedding) {
    clusterResult = await tryJoinCluster(memoryId, embedding, domain, confidence);
  }

  return {
    id: memoryId,
    action: 'created',
    cluster: clusterResult
  };
}

/**
 * Try to join a memory into an existing cluster
 */
async function tryJoinCluster(memoryId, embedding, domain, confidence) {
  const database = getDb();

  // Find active clusters in the same domain
  const clusters = database.prepare(`
    SELECT id, theme, centroid_vector, member_count, avg_confidence
    FROM clusters
    WHERE domain = ? AND status IN ('growing', 'mature')
  `).all(domain);

  let bestCluster = null;
  let bestSimilarity = 0;

  for (const cluster of clusters) {
    if (!cluster.centroid_vector) continue;

    try {
      const centroid = JSON.parse(cluster.centroid_vector);
      const similarity = cosineSimilarity(embedding, centroid);

      if (similarity >= CLUSTER_SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
        bestCluster = cluster;
        bestSimilarity = similarity;
      }
    } catch (e) {
      continue;
    }
  }

  if (bestCluster) {
    // Join existing cluster
    database.prepare(`
      UPDATE memories SET cluster_id = ? WHERE id = ?
    `).run(bestCluster.id, memoryId);

    // Update cluster statistics
    const newCount = bestCluster.member_count + 1;
    const newAvgConf = (bestCluster.avg_confidence * bestCluster.member_count + confidence) / newCount;

    database.prepare(`
      UPDATE clusters
      SET member_count = ?,
          avg_confidence = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newCount, newAvgConf, bestCluster.id);

    // Check if cluster has matured
    if (newCount >= CLUSTER_MATURITY_COUNT && newAvgConf >= CLUSTER_MATURITY_CONFIDENCE) {
      database.prepare(`
        UPDATE clusters SET status = 'mature' WHERE id = ? AND status = 'growing'
      `).run(bestCluster.id);
    }

    return {
      action: 'joined',
      clusterId: bestCluster.id,
      theme: bestCluster.theme,
      similarity: bestSimilarity
    };
  }

  return null;
}

/**
 * Hybrid search (vector + BM25)
 */
async function search(query, limit = 3, options = {}) {
  const database = getDb();
  const { minConfidence = 0, type = null, domain = null } = options;

  // Use Map to merge BM25 and vector search results
  const resultsMap = new Map();

  // BM25 search
  const ftsResults = quickSearch(query, limit * 2);
  for (const r of ftsResults) {
    resultsMap.set(r.id, {
      ...r,
      bm25Score: r.bm25Score || 0,
      vectorSimilarity: 0
    });
  }

  // Vector search
  const embedding = await getEmbedding(query);
  if (embedding) {
    try {
      const vecResults = database.prepare(`
        SELECT rowid, distance
        FROM memories_vec
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(JSON.stringify(embedding), limit * 2);

      for (const vr of vecResults) {
        // cosine distance -> similarity: distance range [0, 2], similarity range [0, 1]
        const similarity = 1 - vr.distance;

        if (resultsMap.has(vr.rowid)) {
          // Merge scores: update vector similarity of existing record
          const existing = resultsMap.get(vr.rowid);
          existing.vectorSimilarity = similarity;
          existing.vectorDistance = vr.distance;
        } else {
          // New record: fetch full info from database
          const memory = database.prepare('SELECT * FROM memories WHERE id = ?').get(vr.rowid);
          if (memory) {
            resultsMap.set(memory.id, {
              id: memory.id,
              content: memory.structured_content || memory.content,  // [v4.6] Prefer returning structured content
              summary: memory.summary,
              type: memory.type,
              domain: memory.domain,
              confidence: memory.confidence,
              tags: memory.tags,
              createdAt: memory.created_at,
              date: memory.created_at ? memory.created_at.slice(0, 10) : 'unknown',
              bm25Score: 0,
              vectorSimilarity: similarity,
              vectorDistance: vr.distance
            });
          }
        }
      }
    } catch (e) {
      // Vector search failed, fall back to BM25 results
    }
  }

  // Calculate combined score and sort
  const results = Array.from(resultsMap.values())
    .filter(r => (r.confidence || 0) >= minConfidence)
    .filter(r => !type || r.type === type)
    .filter(r => !domain || r.domain === domain)
    .map(r => {
      // Combined score: vector-dominant (0.7) + BM25-auxiliary (0.3)
      const bm25Normalized = Math.min((r.bm25Score || 0) / 10, 1.0);
      const vecSim = r.vectorSimilarity || 0;
      r.combinedScore = 0.7 * vecSim + 0.3 * bm25Normalized;
      return r;
    })
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);

  return results;
}

/**
 * Quick BM25 search (without loading the embedding model)
 * Supports mixed Chinese/English queries
 */
function quickSearch(query, limit = 5, options = {}) {
  const database = getDb();

  // Extract English and Chinese keywords
  const englishWords = query.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
  const chineseChars = query.match(/[\u4e00-\u9fff]+/g) || [];

  const results = new Map();

  // 1. FTS search for English keywords
  if (englishWords.length > 0) {
    try {
      const ftsQuery = englishWords.map(w => `"${w}"`).join(' OR ');
      const ftsResults = database.prepare(`
        SELECT m.*, bm25(memories_fts) as bm25_score
        FROM memories_fts fts
        JOIN memories m ON fts.rowid = m.id
        WHERE memories_fts MATCH ?
        ORDER BY bm25(memories_fts)
        LIMIT ?
      `).all(ftsQuery, limit * 2);

      for (const r of ftsResults) {
        results.set(r.id, { ...r, bm25Score: Math.abs(r.bm25_score) });
      }
    } catch (e) {
      // FTS query failed, continue
    }
  }

  // 2. LIKE search for Chinese keywords (using n-gram segmentation)
  if (chineseChars.length > 0) {
    try {
      // Split Chinese text into 2-3 character n-grams
      const chineseNgrams = new Set();
      for (const segment of chineseChars) {
        // 2-grams
        for (let i = 0; i < segment.length - 1; i++) {
          chineseNgrams.add(segment.slice(i, i + 2));
        }
        // 3-grams (more precise matching)
        for (let i = 0; i < segment.length - 2; i++) {
          chineseNgrams.add(segment.slice(i, i + 3));
        }
      }

      // Filter out common function word combinations
      const stopNgrams = new Set(['是多', '多少', '什么', '怎么', '如何', '为什', '为何']);
      const filteredNgrams = [...chineseNgrams].filter(ng => !stopNgrams.has(ng)).slice(0, 10);

      if (filteredNgrams.length > 0) {
        // [v4.5] Search both content and structured_content
        const likeConditions = filteredNgrams.map(() => '(content LIKE ? OR structured_content LIKE ?)').join(' OR ');
        const likeParams = filteredNgrams.flatMap(c => [`%${c}%`, `%${c}%`]);

        const likeResults = database.prepare(`
          SELECT *, 0 as bm25_score
          FROM memories
          WHERE ${likeConditions}
          LIMIT ?
        `).all(...likeParams, limit * 2);

        for (const r of likeResults) {
          if (!results.has(r.id)) {
            // Calculate match score: more matching n-grams = higher score
            // [v4.5] Check both content and structured_content
            const searchText = `${r.content || ''} ${r.structured_content || ''}`;
            const matchCount = filteredNgrams.filter(ng => searchText.includes(ng)).length;
            results.set(r.id, { ...r, bm25Score: matchCount * 0.5 });
          }
        }
      }
    } catch (e) {
      // LIKE query failed, continue
    }
  }

  // 3. If no results, try full-text LIKE fallback
  // [v4.5] Search both content and structured_content
  if (results.size === 0 && query.length > 0) {
    try {
      const fallbackResults = database.prepare(`
        SELECT *, 0 as bm25_score
        FROM memories
        WHERE content LIKE ? OR structured_content LIKE ?
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, limit);

      for (const r of fallbackResults) {
        results.set(r.id, { ...r, bm25Score: 0.3 });
      }
    } catch (e) {
      // Ignore
    }
  }

  // Sort and return
  // [v4.5] Results include structured_content
  const { domain = null } = options;
  return Array.from(results.values())
    .filter(r => !domain || r.domain === domain)
    .sort((a, b) => b.bm25Score - a.bm25Score)
    .slice(0, limit)
    .map(r => ({
      id: r.id,
      content: r.structured_content || r.content,  // [v4.5] Prefer returning structured content
      rawContent: r.content,  // Keep original content
      structuredContent: r.structured_content,
      summary: r.summary,
      type: r.type,
      domain: r.domain,
      confidence: r.confidence,
      tags: r.tags,
      createdAt: r.created_at,
      bm25Score: r.bm25Score,
      date: r.created_at ? r.created_at.slice(0, 10) : 'unknown'
    }));
}

/**
 * Boost confidence
 */
function autoBoostConfidence(memoryId, boost = 0.1) {
  const database = getDb();
  database.prepare(`
    UPDATE memories
    SET confidence = MIN(0.9, confidence + ?),
        last_accessed_at = CURRENT_TIMESTAMP,
        access_count = access_count + 1
    WHERE id = ?
  `).run(boost, memoryId);
}

/**
 * Mark memories as used
 */
function markMemoriesUsed(memoryIds) {
  if (!memoryIds || memoryIds.length === 0) return;

  const database = getDb();
  const placeholders = memoryIds.map(() => '?').join(',');

  database.prepare(`
    UPDATE memories
    SET last_accessed_at = CURRENT_TIMESTAMP,
        access_count = access_count + 1
    WHERE id IN (${placeholders})
  `).run(...memoryIds);
}

/**
 * Delete a memory
 */
function deleteMemory(memoryId) {
  const database = getDb();
  database.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
}

/**
 * Validate a memory (update confidence)
 */
function validateMemory(memoryId, isValid) {
  const database = getDb();
  const delta = isValid ? 0.1 : -0.05;

  database.prepare(`
    UPDATE memories
    SET confidence = MAX(0.3, MIN(0.9, confidence + ?)),
        evidence_count = evidence_count + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(delta, memoryId);
}

// ============== Clustering and Evolution ==============

/**
 * Automatically create new clusters for uncategorized memories
 * @param {object} options - Configuration options
 *   - domain: Specific domain, null for all
 *   - minConfidence: Minimum confidence (default 0.5)
 *   - minClusterSize: Minimum cluster size (default 2)
 *   - similarityThreshold: Similarity threshold (default 0.70)
 *   - hoursBack: Only process memories from the last N hours (default null for unlimited)
 * @returns {array} Information about newly created clusters
 */
async function autoCluster(options = {}) {
  const {
    domain = null,
    minConfidence = 0.5,
    minClusterSize = 2,
    similarityThreshold = CLUSTER_SIMILARITY_THRESHOLD,
    hoursBack = null
  } = options;

  const database = getDb();

  // Build query conditions
  let whereClause = 'cluster_id IS NULL AND confidence >= ?';
  const params = [minConfidence];

  if (domain) {
    whereClause += ' AND domain = ?';
    params.push(domain);
  }

  if (hoursBack) {
    whereClause += ` AND created_at > datetime('now', '-${parseInt(hoursBack)} hours')`;
  }

  // Get unclustered memories
  const unclustered = database.prepare(`
    SELECT id, content, summary, confidence, domain
    FROM memories
    WHERE ${whereClause}
    ORDER BY confidence DESC
    LIMIT 100
  `).all(...params);

  if (unclustered.length < minClusterSize) {
    return [];
  }

  // Get vectors (using vec_to_json to read sqlite-vec binary format)
  const vectors = [];
  for (const m of unclustered) {
    try {
      const vec = database.prepare(
        'SELECT vec_to_json(embedding) as json_vec FROM memories_vec WHERE rowid = ?'
      ).get(m.id);
      if (vec && vec.json_vec) {
        vectors.push({ id: m.id, memory: m, vector: JSON.parse(vec.json_vec) });
      }
    } catch (e) {
      // Skip memories without vectors
    }
  }

  if (vectors.length < minClusterSize) {
    return [];
  }

  // Group by domain
  const byDomain = {};
  for (const v of vectors) {
    const d = v.memory.domain;
    if (!byDomain[d]) byDomain[d] = [];
    byDomain[d].push(v);
  }

  const createdClusters = [];

  // Greedy clustering for each domain
  for (const [domainName, domainVectors] of Object.entries(byDomain)) {
    if (domainVectors.length < minClusterSize) continue;

    const used = new Set();
    const newClusters = [];

    for (let i = 0; i < domainVectors.length; i++) {
      if (used.has(i)) continue;

      const cluster = [domainVectors[i]];
      used.add(i);

      for (let j = i + 1; j < domainVectors.length; j++) {
        if (used.has(j)) continue;

        const similarity = cosineSimilarity(domainVectors[i].vector, domainVectors[j].vector);

        if (similarity >= similarityThreshold) {
          cluster.push(domainVectors[j]);
          used.add(j);
        }
      }

      if (cluster.length >= minClusterSize) {
        newClusters.push(cluster);
      }
    }

    // Create new clusters
    for (const cluster of newClusters) {
      const theme = inferClusterTheme(cluster.map(c => c.memory));

      // Calculate average vector
      const avgVector = cluster[0].vector.map((_, i) =>
        cluster.reduce((sum, c) => sum + c.vector[i], 0) / cluster.length
      );

      const avgConfidence = cluster.reduce((sum, c) => sum + c.memory.confidence, 0) / cluster.length;

      // Determine whether to mark as mature directly
      const status = (cluster.length >= CLUSTER_MATURITY_COUNT && avgConfidence >= CLUSTER_MATURITY_CONFIDENCE)
        ? 'mature'
        : 'growing';

      // Insert cluster
      const result = database.prepare(`
        INSERT INTO clusters (theme, centroid_id, centroid_vector, member_count, avg_confidence, domain, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        theme,
        cluster[0].id,
        JSON.stringify(avgVector),
        cluster.length,
        avgConfidence,
        domainName,
        status
      );

      const clusterId = Number(result.lastInsertRowid);

      // Update cluster_id for memories
      for (const c of cluster) {
        database.prepare('UPDATE memories SET cluster_id = ? WHERE id = ?').run(clusterId, c.id);
      }

      createdClusters.push({
        id: clusterId,
        theme,
        domain: domainName,
        memberCount: cluster.length,
        avgConfidence,
        status,
        memberIds: cluster.map(c => c.id)
      });
    }
  }

  return createdClusters;
}

/**
 * Infer cluster theme from memory contents
 */
function inferClusterTheme(memories) {
  const wordCount = {};
  for (const m of memories) {
    const words = (m.content || '')
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));

    for (const w of words) {
      wordCount[w] = (wordCount[w] || 0) + 1;
    }
  }

  return Object.entries(wordCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => word)
    .join('-') || 'general-pattern';
}

/**
 * Get mature clusters
 */
function getMatureClusters() {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM clusters WHERE status = 'mature'
  `).all();
}

/**
 * [v5.5] Merge memories in a mature cluster into a single high-confidence memory
 * @param {number} clusterId - Cluster ID
 * @returns {object|null} Merged memory information
 */
async function mergeClusterMemories(clusterId) {
  const database = getDb();

  const cluster = database.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster || cluster.status !== 'mature') return null;

  const members = database.prepare(`
    SELECT * FROM memories WHERE cluster_id = ? ORDER BY confidence DESC
  `).all(clusterId);

  if (members.length < 2) return null;  // Need at least 2 to make merging meaningful

  // Collect all memory contents (prefer structured_content, fall back to content)
  const memoryTexts = members.map(m => m.structured_content || m.content);

  // Determine primary type and domain
  const typeCounts = {};
  members.forEach(m => { typeCounts[m.type] = (typeCounts[m.type] || 0) + 1; });
  const mainType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0];
  const domain = cluster.domain || 'general';

  // Call LLM for merging
  let mergedContent = null;
  let structuredContent = null;
  try {
    const llmClient = require('./llm-client');
    if (await llmClient.isAvailable()) {
      mergedContent = await llmClient.merge(memoryTexts, domain);
    }
  } catch (e) {
    // LLM not available, fall back
  }

  if (mergedContent) {
    // [v6.1] LLM merge: supports direct XML return or legacy format object
    let content;
    if (typeof mergedContent === 'string' && mergedContent.startsWith('<memory')) {
      // LLM returned XML directly
      structuredContent = mergedContent;
      content = cluster.theme;
    } else {
      content = mergedContent.content || mergedContent.summary || cluster.theme;
      structuredContent = formatStructuredContent(mergedContent, mainType, domain);
    }

    const summary = (typeof mergedContent === 'string') ? cluster.theme : (mergedContent.summary || cluster.theme);

    // Create merged memory
    const result = database.prepare(`
      INSERT INTO memories (content, structured_content, summary, type, domain, confidence, source, trigger, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      content,
      structuredContent,
      summary,
      mainType,
      domain,
      0.9,
      'cluster-merge',
      `merged from cluster #${clusterId} (${members.length} memories)`,
      (typeof mergedContent === 'object' && mergedContent.triggers) ? mergedContent.triggers.join(',') : ''
    );

    const newMemoryId = Number(result.lastInsertRowid);

    // Generate embedding vector (using structured_content + domain for better semantic quality)
    const embeddingText = buildEmbeddingText(structuredContent || content, domain);
    const embedding = await getEmbedding(embeddingText);
    if (embedding) {
      try {
        database.prepare(`
          INSERT INTO memories_vec (rowid, embedding)
          VALUES (?, ?)
        `).run(BigInt(newMemoryId), JSON.stringify(embedding));
      } catch (e) {
        // Vector insert failed, does not affect main flow
      }
    }

    // Delete original memories and their vectors
    for (const m of members) {
      try {
        database.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(BigInt(m.id));
      } catch (e) { /* ignore */ }
      database.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
    }

    // Update cluster status
    database.prepare(`
      UPDATE clusters SET status = 'merged', evolved_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(clusterId);

    return { memoryId: newMemoryId, summary, memberCount: members.length };
  }

  // LLM not available: simple concatenation fallback
  const fallbackContent = memoryTexts.join('\n---\n');
  const result = database.prepare(`
    INSERT INTO memories (content, summary, type, domain, confidence, source, trigger)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(fallbackContent, cluster.theme, mainType, domain, 0.85, 'cluster-merge', `fallback merge from cluster #${clusterId}`);

  const newMemoryId = Number(result.lastInsertRowid);

  for (const m of members) {
    try {
      database.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(BigInt(m.id));
    } catch (e) { /* ignore */ }
    database.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
  }

  database.prepare(`
    UPDATE clusters SET status = 'merged', evolved_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(clusterId);

  return { memoryId: newMemoryId, summary: cluster.theme, memberCount: members.length };
}

// ============== Utility Functions ==============

function extractKeywords(text) {
  const words = text
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));

  // Count word frequency
  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

function textSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function calcTimeDecay(createdAt, memoryType) {
  if (!createdAt) return 1.0;
  const config = TIME_DECAY_CONFIG[memoryType] || TIME_DECAY_CONFIG.context;
  if (config.halfLifeDays === Infinity) return 1.0;

  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const decay = Math.pow(0.5, ageDays / config.halfLifeDays);
  return Math.max(decay, config.minWeight);
}

/**
 * Get statistics
 */
function getStats() {
  const database = getDb();

  const totalMemories = database.prepare('SELECT COUNT(*) as count FROM memories').get().count;
  const byType = database.prepare('SELECT type, COUNT(*) as count FROM memories GROUP BY type').all();
  const byDomain = database.prepare('SELECT domain, COUNT(*) as count FROM memories GROUP BY domain').all();
  const totalClusters = database.prepare('SELECT COUNT(*) as count FROM clusters').get().count;
  const matureClusters = database.prepare("SELECT COUNT(*) as count FROM clusters WHERE status = 'mature'").get().count;
  const promotedCount = database.prepare('SELECT COUNT(*) as count FROM memories WHERE promoted_at IS NOT NULL').get().count;

  return {
    totalMemories,
    byType: Object.fromEntries(byType.map(r => [r.type, r.count])),
    byDomain: Object.fromEntries(byDomain.map(r => [r.domain, r.count])),
    totalClusters,
    matureClusters,
    promotedCount,
    version: '6.1'
  };
}

/**
 * Rebuild embeddings for all memories (using structured_content + domain)
 */
async function rebuildAllEmbeddings() {
  const database = getDb();
  const rows = database.prepare('SELECT id, content, structured_content, domain FROM memories').all();
  console.log(`[memory-db] Rebuilding embeddings for ${rows.length} memories...`);

  // Rebuild vector table (drop old table, recreate with cosine distance)
  try {
    database.exec('DROP TABLE IF EXISTS memories_vec');
    database.exec(`
      CREATE VIRTUAL TABLE memories_vec USING vec0(
        embedding float[${config.embedding.dimensions}] distance_metric=cosine
      )
    `);
  } catch (e) {
    console.error('[memory-db] Failed to recreate memories_vec:', e.message);
    return { success: false, error: e.message };
  }

  let success = 0;
  let failed = 0;
  for (const row of rows) {
    const text = buildEmbeddingText(row.structured_content || row.content, row.domain);
    const embedding = await getEmbedding(text);
    if (embedding) {
      try {
        database.prepare('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)').run(BigInt(row.id), JSON.stringify(embedding));
        success++;
      } catch (e) {
        failed++;
      }
    } else {
      failed++;
    }
    if ((success + failed) % 10 === 0) {
      console.log(`[memory-db] Progress: ${success + failed}/${rows.length}`);
    }
  }

  console.log(`[memory-db] Rebuild complete: ${success} success, ${failed} failed`);
  return { success: true, rebuilt: success, failed };
}

// ============== Exports ==============

module.exports = {
  // Database
  getDb,
  closeDb,

  // Core functions
  save,
  search,
  quickSearch,

  // Confidence management
  autoBoostConfidence,
  markMemoriesUsed,
  deleteMemory,
  validateMemory,

  // Clustering and merging
  autoCluster,
  inferClusterTheme,
  tryJoinCluster,
  getMatureClusters,
  mergeClusterMemories,

  // Embeddings
  getEmbedding,
  warmupEmbedding,
  buildEmbeddingText,
  rebuildAllEmbeddings,

  // [v4.5] LLM structuring
  structurizeWithLLM,
  formatStructuredContent,

  // Utilities
  extractKeywords,
  cosineSimilarity,
  calcTimeDecay,
  getStats,

  // Configuration
  CLUSTER_SIMILARITY_THRESHOLD,
  CLUSTER_MATURITY_COUNT,
  STRUCTURIZE_CONFIG,
  CLUSTER_MATURITY_CONFIDENCE
};
