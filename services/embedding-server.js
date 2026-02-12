#!/usr/bin/env node
const net = require('net');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { ensureDir } = require('../lib/utils');

const PORT = config.embeddingPort;
const PID_FILE = path.join(config.pidDir, 'claude-embedding.pid');

let memoryDb = null;
let isReady = false;
let server = null;

const LOG_FILE = path.join(config.logDir, 'embedding-server.log');
ensureDir(config.logDir);

function str(v) { return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); }
function log(msg) { const line = `[${new Date().toISOString()}] ${msg}\n`; try { fs.appendFileSync(LOG_FILE, line); } catch (e) {} }

async function initialize() {
  console.error('[EmbeddingServer] Starting...');
  try {
    memoryDb = require('../lib/memory-db');
    if (memoryDb.warmupEmbedding) {
      console.error('[EmbeddingServer] Warming up embedding model...');
      await memoryDb.warmupEmbedding();
      console.error('[EmbeddingServer] Embedding model ready');
    }
    isReady = true;
  } catch (e) {
    console.error('[EmbeddingServer] Failed to initialize:', e.message);
    process.exit(1);
  }
}

async function handleRequest(data) {
  if (!isReady) return { success: false, error: 'Server not ready' };
  try {
    const request = JSON.parse(data);
    const startTime = Date.now();
    switch (request.action) {
      case 'search': {
        log(`[REQ] action=search query=${str(request.query)} limit=${request.limit || 3}`);
        const results = await memoryDb.search(request.query, request.limit || 3, request.options || {});
        const duration = Date.now() - startTime;
        log(`[RES] action=search duration=${duration}ms results=${results.length} matches=${results.map(r => '#' + r.id + '(' + (r.vectorSimilarity != null ? r.vectorSimilarity.toFixed(3) : '?') + ')').join(',')}`);
        return { success: true, results };
      }
      case 'quickSearch': {
        log(`[REQ] action=quickSearch query=${str(request.query)} limit=${request.limit || 3}`);
        const quickResults = memoryDb.quickSearch(request.query, request.limit || 3, request.options || {});
        const duration = Date.now() - startTime;
        log(`[RES] action=quickSearch duration=${duration}ms results=${quickResults.length} matches=${quickResults.map(r => '#' + r.id + '(' + (r.vectorSimilarity != null ? r.vectorSimilarity.toFixed(3) : '?') + ')').join(',')}`);
        return { success: true, results: quickResults };
      }
      case 'ping': return { success: true, message: 'pong', ready: isReady };
      case 'shutdown':
        console.error('[EmbeddingServer] Shutdown requested');
        setTimeout(() => { cleanup(); process.exit(0); }, 100);
        return { success: true, message: 'Shutting down' };
      case 'stats':
        const stats = memoryDb.getStats();
        return { success: true, stats };
      default: return { success: false, error: `Unknown action: ${request.action}` };
    }
  } catch (e) {
    log(`[ERR] error=${e.message}`);
    return { success: false, error: e.message };
  }
}

function cleanup() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); if (memoryDb && memoryDb.closeDb) memoryDb.closeDb(); } catch (e) {}
}

async function startServer() {
  await initialize();
  server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          const response = await handleRequest(line);
          socket.write(JSON.stringify(response) + '\n');
        }
      }
    });
    socket.on('error', () => {});
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') { console.error(`[EmbeddingServer] Port ${PORT} already in use`); process.exit(0); }
    console.error('[EmbeddingServer] Server error:', err.message);
    cleanup();
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.error(`[EmbeddingServer] Listening on 127.0.0.1:${PORT}`);
    fs.writeFileSync(PID_FILE, process.pid.toString());
  });
  process.on('SIGTERM', () => { console.error('[EmbeddingServer] SIGTERM received'); cleanup(); process.exit(0); });
  process.on('SIGINT', () => { console.error('[EmbeddingServer] SIGINT received'); cleanup(); process.exit(0); });
}

startServer().catch((err) => { console.error('[EmbeddingServer] Failed to start:', err.message); process.exit(1); });
