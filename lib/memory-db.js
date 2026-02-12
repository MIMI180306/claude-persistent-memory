#!/usr/bin/env node
/**
 * Memory Database Module - 记忆系统核心 v4.5
 *
 * 功能：
 * - SQLite + sqlite-vec 向量存储
 * - FTS5 全文搜索 (BM25)
 * - 增量聚类
 * - 置信度管理
 * - Skill 自动生成
 * - [v4.5] LLM 结构化记忆
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ============== 配置 ==============

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

// 停用词
const STOPWORDS = new Set([
  '的', '是', '在', '有', '和', '了', '我', '你', '这', '那', '吗', '呢', '啊',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how', 'can', 'do',
  'does', 'did', 'will', 'would', 'could', 'should', 'to', 'for', 'of', 'in',
  'on', 'at', 'by', 'with', 'from', 'as', 'it', 'this', 'that', 'be', 'have'
]);

// 聚类配置
const CLUSTER_SIMILARITY_THRESHOLD = config.cluster.similarityThreshold;
const CLUSTER_MATURITY_COUNT = config.cluster.maturityCount;
const CLUSTER_MATURITY_CONFIDENCE = config.cluster.maturityConfidence;

// [v4.5] LLM 结构化配置
const STRUCTURIZE_CONFIG = {
  enabled: true,
  cliCommand: 'claude',  // Claude CLI 命令
  timeout: 30000,        // 30秒超时
  model: 'haiku',        // 使用 haiku 降低成本
};

// 时间衰减配置
const TIME_DECAY_CONFIG = {
  fact: { halfLifeDays: 90, minWeight: 0.3 },
  decision: { halfLifeDays: 90, minWeight: 0.3 },
  bug: { halfLifeDays: 60, minWeight: 0.3 },
  pattern: { halfLifeDays: 90, minWeight: 0.4 },
  preference: { halfLifeDays: 60, minWeight: 0.2 },
  context: { halfLifeDays: 30, minWeight: 0.2 },
  session: { halfLifeDays: 14, minWeight: 0.1 },
  learned: { halfLifeDays: 90, minWeight: 0.4 },
  skill: { halfLifeDays: Infinity, minWeight: 1.0 },  // [v4.5] Skill 描述永不衰减
  permanent: { halfLifeDays: Infinity, minWeight: 1.0 }
};

// ============== 数据库管理 ==============

let db = null;
let embeddingModel = null;

function getDb() {
  if (db) return db;

  try {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);

    // 加载 sqlite-vec 扩展
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
  // 主记忆表
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

  // [v4.5] 添加 structured_content 字段（如果不存在）
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN structured_content TEXT`);
  } catch (e) {
    // 字段已存在，忽略
  }

  // FTS5 全文搜索表 - [v4.5] 添加 structured_content
  // 注意：如果表已存在但结构不同，需要重建
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, structured_content, summary, tags, keywords,
        content='memories',
        content_rowid='id'
      )
    `);
  } catch (e) {
    // 如果 FTS 表已存在但结构不同，可能需要重建
    // 暂时忽略，使用现有表
  }

  // 向量表 (如果 sqlite-vec 可用，使用 cosine 距离)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        embedding float[${config.embedding.dimensions}] distance_metric=cosine
      )
    `);
  } catch (e) {
    // sqlite-vec 不可用，跳过
  }

  // 聚类表
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

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
    CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
    CREATE INDEX IF NOT EXISTS idx_memories_cluster_id ON memories(cluster_id);
    CREATE INDEX IF NOT EXISTS idx_memories_promoted ON memories(promoted_at);
    CREATE INDEX IF NOT EXISTS idx_clusters_status ON clusters(status);
  `);

  // FTS 触发器 - [v4.5] 包含 structured_content
  // 先删除旧触发器再创建新的
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

// ============== 嵌入模型 ==============
// [v6.2] 使用 @huggingface/transformers + bge-m3 (ONNX)
// 替代 bge-base-zh-v1.5，8192 token 上下文，1024 维度，多语言支持

let _pipeline = null;  // transformers.js pipeline 实例

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
 * 构建 embedding 输入文本：structured_content + domain
 * 让向量包含更丰富的语义信息
 */
function buildEmbeddingText(content, domain) {
  const parts = [];
  if (domain && domain !== 'general') {
    parts.push(`[${domain}]`);
  }
  parts.push(content);
  return parts.join(' ');
}

// ============== [v4.5] LLM 结构化 ==============

/**
 * 使用 LLM 服务将原始记忆内容结构化
 * @param {string} rawContent - 原始内容
 * @param {string} type - 记忆类型
 * @returns {object|null} 结构化结果
 */
async function structurizeWithLLM(rawContent, type) {
  if (!STRUCTURIZE_CONFIG.enabled) return null;

  const startTime = Date.now();
  _log(`[STRUCTURIZE-REQ] type=${type} content=${_str(rawContent)}`);

  try {
    // 使用 llm-client 调用 llm-server（避免 claude --print 触发 hooks 导致递归）
    const llmClient = require('./llm-client');
    if (await llmClient.isAvailable()) {
      const structured = await llmClient.structurize(rawContent, type);
      const duration = Date.now() - startTime;
      _log(`[STRUCTURIZE-RES] duration=${duration}ms result=${_str(structured)}`);
      // LLM 判断不值得保存
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
 * [v6.1] 将结构化对象格式化为 XML
 *
 * 字段说明：
 *   <what>  核心内容（必填）
 *   <when>  触发场景 / 适用时机
 *   <do>    具体操作、命令、代码
 *   <warn>  警告、禁止、注意事项
 *
 * 不同类型使用不同字段子集：
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

  // 收集各字段内容
  const what = structured.summary || '';
  const when = (structured.scenarios && structured.scenarios.length > 0)
    ? structured.scenarios.join(' | ')
    : '';

  // <do> = must 规则 + prefer 规则（合并为可操作指令）
  const doItems = [];
  if (structured.rules?.must) doItems.push(...structured.rules.must);
  if (structured.rules?.prefer) doItems.push(...structured.rules.prefer);
  const doText = doItems.join('；');

  // <warn> = must_not 规则
  const warnText = (structured.rules?.must_not && structured.rules.must_not.length > 0)
    ? structured.rules.must_not.join('；')
    : '';

  // 根据类型选择字段
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
 * XML 转义
 */
function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============== 核心功能 ==============

/**
 * 保存记忆（自动增量聚类）
 * [v4.5] 添加 LLM 结构化支持
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
    skipStructurize = false,  // [v4.5] 是否跳过结构化
    structuredContent: preStructuredContent = null  // [v6.1] 预结构化 XML（跳过 LLM）
  } = options;

  // 生成摘要
  const summary = content.length > 100 ? content.slice(0, 100) + '...' : content;

  // 提取关键词
  const keywords = extractKeywords(content).join(',');

  // 去重检查
  const existing = database.prepare(`
    SELECT id, content, confidence FROM memories
    WHERE type = ? AND domain = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(type, domain);

  for (const e of existing) {
    const similarity = textSimilarity(content, e.content);
    if (similarity >= 0.95) {
      // 更新已有记忆的访问时间和置信度
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

  // [v6.1] LLM 结构化 → XML
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
        // LLM 直接返回 XML
        structuredContent = structured;
      } else if (typeof structured === 'object') {
        // 旧格式对象 → 格式化为 XML
        structuredContent = formatStructuredContent(structured, type, domain);
      }
      console.log('[memory-db] Structured content:', structuredContent);
    }
  }

  // 插入新记忆
  const result = database.prepare(`
    INSERT INTO memories (content, structured_content, summary, type, tags, keywords, domain, confidence, source, trigger, action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(content, structuredContent, summary, type, tags, keywords, domain, confidence, source, trigger, action);

  const memoryId = Number(result.lastInsertRowid);

  // 生成嵌入向量（使用 structured_content + domain 提升语义质量）
  const embeddingText = buildEmbeddingText(structuredContent || content, domain);
  const embedding = await getEmbedding(embeddingText);
  if (embedding) {
    try {
      // sqlite-vec 需要 BigInt 作为 rowid
      database.prepare(`
        INSERT INTO memories_vec (rowid, embedding)
        VALUES (?, ?)
      `).run(BigInt(memoryId), JSON.stringify(embedding));
    } catch (e) {
      console.error('[memory-db] Vector insert failed:', e.message);
    }
  }

  // 增量聚类
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
 * 尝试将记忆加入已有簇
 */
async function tryJoinCluster(memoryId, embedding, domain, confidence) {
  const database = getDb();

  // 查找同 domain 的活跃簇
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
    // 加入已有簇
    database.prepare(`
      UPDATE memories SET cluster_id = ? WHERE id = ?
    `).run(bestCluster.id, memoryId);

    // 更新簇统计
    const newCount = bestCluster.member_count + 1;
    const newAvgConf = (bestCluster.avg_confidence * bestCluster.member_count + confidence) / newCount;

    database.prepare(`
      UPDATE clusters
      SET member_count = ?,
          avg_confidence = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newCount, newAvgConf, bestCluster.id);

    // 检查簇是否成熟
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
 * 混合搜索（向量 + BM25）
 */
async function search(query, limit = 3, options = {}) {
  const database = getDb();
  const { minConfidence = 0, type = null, domain = null } = options;

  // 使用 Map 合并 BM25 和向量搜索结果
  const resultsMap = new Map();

  // BM25 搜索
  const ftsResults = quickSearch(query, limit * 2);
  for (const r of ftsResults) {
    resultsMap.set(r.id, {
      ...r,
      bm25Score: r.bm25Score || 0,
      vectorSimilarity: 0
    });
  }

  // 向量搜索
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
        // cosine distance → similarity: distance 范围 [0, 2]，similarity 范围 [0, 1]
        const similarity = 1 - vr.distance;

        if (resultsMap.has(vr.rowid)) {
          // 合并分数：更新已存在记录的向量相似度
          const existing = resultsMap.get(vr.rowid);
          existing.vectorSimilarity = similarity;
          existing.vectorDistance = vr.distance;
        } else {
          // 新记录：从数据库获取完整信息
          const memory = database.prepare('SELECT * FROM memories WHERE id = ?').get(vr.rowid);
          if (memory) {
            resultsMap.set(memory.id, {
              id: memory.id,
              content: memory.structured_content || memory.content,  // [v4.6] 优先返回结构化内容
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
      // 向量搜索失败，使用 BM25 结果
    }
  }

  // 计算综合分数并排序
  const results = Array.from(resultsMap.values())
    .filter(r => (r.confidence || 0) >= minConfidence)
    .filter(r => !type || r.type === type)
    .filter(r => !domain || r.domain === domain)
    .map(r => {
      // 综合分数：向量主导 (0.7) + BM25 辅助 (0.3)
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
 * 快速 BM25 搜索（不加载嵌入模型）
 * 支持中英文混合查询
 */
function quickSearch(query, limit = 5, options = {}) {
  const database = getDb();

  // 提取英文和中文关键词
  const englishWords = query.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
  const chineseChars = query.match(/[\u4e00-\u9fff]+/g) || [];

  const results = new Map();

  // 1. FTS 搜索英文关键词
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
      // FTS 查询失败，继续
    }
  }

  // 2. LIKE 搜索中文关键词（使用 n-gram 分段）
  if (chineseChars.length > 0) {
    try {
      // 将中文文本切分成 2-3 字符的 n-gram
      const chineseNgrams = new Set();
      for (const segment of chineseChars) {
        // 2-gram
        for (let i = 0; i < segment.length - 1; i++) {
          chineseNgrams.add(segment.slice(i, i + 2));
        }
        // 3-gram（更精确的匹配）
        for (let i = 0; i < segment.length - 2; i++) {
          chineseNgrams.add(segment.slice(i, i + 3));
        }
      }

      // 过滤掉常见虚词组合
      const stopNgrams = new Set(['是多', '多少', '什么', '怎么', '如何', '为什', '为何']);
      const filteredNgrams = [...chineseNgrams].filter(ng => !stopNgrams.has(ng)).slice(0, 10);

      if (filteredNgrams.length > 0) {
        // [v4.5] 同时搜索 content 和 structured_content
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
            // 计算匹配分数：匹配的 n-gram 越多分数越高
            // [v4.5] 同时检查 content 和 structured_content
            const searchText = `${r.content || ''} ${r.structured_content || ''}`;
            const matchCount = filteredNgrams.filter(ng => searchText.includes(ng)).length;
            results.set(r.id, { ...r, bm25Score: matchCount * 0.5 });
          }
        }
      }
    } catch (e) {
      // LIKE 查询失败，继续
    }
  }

  // 3. 如果没有结果，尝试全文 LIKE
  // [v4.5] 同时搜索 content 和 structured_content
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
      // 忽略
    }
  }

  // 排序并返回
  // [v4.5] 返回结果包含 structured_content
  const { domain = null } = options;
  return Array.from(results.values())
    .filter(r => !domain || r.domain === domain)
    .sort((a, b) => b.bm25Score - a.bm25Score)
    .slice(0, limit)
    .map(r => ({
      id: r.id,
      content: r.structured_content || r.content,  // [v4.5] 优先返回结构化内容
      rawContent: r.content,  // 保留原始内容
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
 * 提升置信度
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
 * 标记记忆已使用
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
 * 删除记忆
 */
function deleteMemory(memoryId) {
  const database = getDb();
  database.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
}

/**
 * 验证记忆（更新置信度）
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

// ============== 聚类与进化 ==============

/**
 * 为未分类记忆自动创建新簇
 * @param {object} options - 配置选项
 *   - domain: 特定领域，null 表示所有
 *   - minConfidence: 最低置信度 (默认 0.5)
 *   - minClusterSize: 最小簇大小 (默认 2)
 *   - similarityThreshold: 相似度阈值 (默认 0.70)
 *   - hoursBack: 只处理最近 N 小时的记忆 (默认 null 表示不限)
 * @returns {array} 创建的新簇信息
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

  // 构建查询条件
  let whereClause = 'cluster_id IS NULL AND confidence >= ?';
  const params = [minConfidence];

  if (domain) {
    whereClause += ' AND domain = ?';
    params.push(domain);
  }

  if (hoursBack) {
    whereClause += ` AND created_at > datetime('now', '-${parseInt(hoursBack)} hours')`;
  }

  // 获取未归类的记忆
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

  // 获取向量 (使用 vec_to_json 读取 sqlite-vec 二进制格式)
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
      // 跳过无向量的记忆
    }
  }

  if (vectors.length < minClusterSize) {
    return [];
  }

  // 按 domain 分组
  const byDomain = {};
  for (const v of vectors) {
    const d = v.memory.domain;
    if (!byDomain[d]) byDomain[d] = [];
    byDomain[d].push(v);
  }

  const createdClusters = [];

  // 对每个 domain 进行贪心聚类
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

    // 创建新簇
    for (const cluster of newClusters) {
      const theme = inferClusterTheme(cluster.map(c => c.memory));

      // 计算平均向量
      const avgVector = cluster[0].vector.map((_, i) =>
        cluster.reduce((sum, c) => sum + c.vector[i], 0) / cluster.length
      );

      const avgConfidence = cluster.reduce((sum, c) => sum + c.memory.confidence, 0) / cluster.length;

      // 判断是否直接标记为 mature
      const status = (cluster.length >= CLUSTER_MATURITY_COUNT && avgConfidence >= CLUSTER_MATURITY_CONFIDENCE)
        ? 'mature'
        : 'growing';

      // 插入簇
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

      // 更新记忆的 cluster_id
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
 * 从记忆内容推断簇主题
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
 * 获取成熟的簇
 */
function getMatureClusters() {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM clusters WHERE status = 'mature'
  `).all();
}

/**
 * [v5.5] 将成熟簇中的记忆聚合为一条高置信度记忆
 * @param {number} clusterId - 簇 ID
 * @returns {object|null} 聚合后的记忆信息
 */
async function mergeClusterMemories(clusterId) {
  const database = getDb();

  const cluster = database.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster || cluster.status !== 'mature') return null;

  const members = database.prepare(`
    SELECT * FROM memories WHERE cluster_id = ? ORDER BY confidence DESC
  `).all(clusterId);

  if (members.length < 2) return null;  // 至少 2 条才有聚合意义

  // 收集所有记忆内容（优先用 structured_content，回退 content）
  const memoryTexts = members.map(m => m.structured_content || m.content);

  // 确定主要类型和领域
  const typeCounts = {};
  members.forEach(m => { typeCounts[m.type] = (typeCounts[m.type] || 0) + 1; });
  const mainType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0][0];
  const domain = cluster.domain || 'general';

  // 调用 LLM 聚合
  let mergedContent = null;
  let structuredContent = null;
  try {
    const llmClient = require('./llm-client');
    if (await llmClient.isAvailable()) {
      mergedContent = await llmClient.merge(memoryTexts, domain);
    }
  } catch (e) {
    // LLM 不可用，回退
  }

  if (mergedContent) {
    // [v6.1] LLM 聚合：支持直接返回 XML 或旧格式对象
    let content;
    if (typeof mergedContent === 'string' && mergedContent.startsWith('<memory')) {
      // LLM 直接返回 XML
      structuredContent = mergedContent;
      content = cluster.theme;
    } else {
      content = mergedContent.content || mergedContent.summary || cluster.theme;
      structuredContent = formatStructuredContent(mergedContent, mainType, domain);
    }

    const summary = (typeof mergedContent === 'string') ? cluster.theme : (mergedContent.summary || cluster.theme);

    // 创建聚合记忆
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

    // 生成嵌入向量（使用 structured_content + domain 提升语义质量）
    const embeddingText = buildEmbeddingText(structuredContent || content, domain);
    const embedding = await getEmbedding(embeddingText);
    if (embedding) {
      try {
        database.prepare(`
          INSERT INTO memories_vec (rowid, embedding)
          VALUES (?, ?)
        `).run(BigInt(newMemoryId), JSON.stringify(embedding));
      } catch (e) {
        // 向量插入失败，不影响主流程
      }
    }

    // 删除原始记忆及其向量
    for (const m of members) {
      try {
        database.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(BigInt(m.id));
      } catch (e) { /* ignore */ }
      database.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
    }

    // 更新簇状态
    database.prepare(`
      UPDATE clusters SET status = 'merged', evolved_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(clusterId);

    return { memoryId: newMemoryId, summary, memberCount: members.length };
  }

  // LLM 不可用：简单拼接
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

// ============== 工具函数 ==============

function extractKeywords(text) {
  const words = text
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));

  // 统计词频
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
 * 获取统计信息
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
 * 重建所有记忆的 embedding（使用 structured_content + domain）
 */
async function rebuildAllEmbeddings() {
  const database = getDb();
  const rows = database.prepare('SELECT id, content, structured_content, domain FROM memories').all();
  console.log(`[memory-db] Rebuilding embeddings for ${rows.length} memories...`);

  // 重建向量表（drop 旧表，用 cosine distance 重建）
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

// ============== 导出 ==============

module.exports = {
  // 数据库
  getDb,
  closeDb,

  // 核心功能
  save,
  search,
  quickSearch,

  // 置信度管理
  autoBoostConfidence,
  markMemoriesUsed,
  deleteMemory,
  validateMemory,

  // 聚类与聚合
  autoCluster,
  inferClusterTheme,
  tryJoinCluster,
  getMatureClusters,
  mergeClusterMemories,

  // 嵌入
  getEmbedding,
  warmupEmbedding,
  buildEmbeddingText,
  rebuildAllEmbeddings,

  // [v4.5] LLM 结构化
  structurizeWithLLM,
  formatStructuredContent,

  // 工具
  extractKeywords,
  cosineSimilarity,
  calcTimeDecay,
  getStats,

  // 配置
  CLUSTER_SIMILARITY_THRESHOLD,
  CLUSTER_MATURITY_COUNT,
  STRUCTURIZE_CONFIG,
  CLUSTER_MATURITY_CONFIDENCE
};
