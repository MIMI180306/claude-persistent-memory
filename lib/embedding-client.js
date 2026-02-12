const net = require('net');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { ensureDir } = require('./utils');

const PORT = config.embeddingPort;
const HOST = '127.0.0.1';
const TIMEOUT_MS = config.timeout.embeddingClient;
const LOG_FILE = path.join(config.logDir, 'embedding-calls.log');

ensureDir(path.dirname(LOG_FILE));

function str(v) { return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); }

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

async function sendRequest(req, timeout = TIMEOUT_MS) {
  const startTime = Date.now();
  log(`[REQ] action=${req.action} query=${str(req.query)} limit=${req.limit || '-'}`);

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = '';
    let resolved = false;

    const done = (type, value) => {
      const duration = Date.now() - startTime;
      if (type === 'resolve') {
        const resultCount = value.results ? value.results.length : '-';
        log(`[RES] action=${req.action} duration=${duration}ms results=${resultCount} response=${str(value)}`);
      } else {
        log(`[ERR] action=${req.action} duration=${duration}ms error=${value.message || value}`);
      }
      type === 'resolve' ? resolve(value) : reject(value);
    };

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        done('reject', new Error('Request timeout'));
      }
    }, timeout);

    socket.connect(PORT, HOST, () => {
      socket.write(JSON.stringify(req) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim() && !resolved) {
          resolved = true;
          clearTimeout(timer);
          socket.destroy();
          try {
            const response = JSON.parse(line);
            if (response.success) {
              done('resolve', response);
            } else {
              done('reject', new Error(response.error || 'Unknown error'));
            }
          } catch (e) {
            done('reject', new Error('Invalid response'));
          }
        }
      }
    });

    socket.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        done('reject', err);
      }
    });
  });
}

async function search(query, limit = 3, options = {}) {
  const response = await sendRequest({ action: 'search', query, limit, options });
  return response.results;
}

async function quickSearch(query, limit = 3, options = {}) {
  const response = await sendRequest({ action: 'quickSearch', query, limit, options });
  return response.results;
}

async function ping() {
  try {
    const response = await sendRequest({ action: 'ping' }, 200);
    return response.ready === true;
  } catch (e) {
    return false;
  }
}

async function getStats() {
  const response = await sendRequest({ action: 'stats' });
  return response.stats;
}

async function shutdown() {
  try { await sendRequest({ action: 'shutdown' }, 200); } catch (e) {}
}

async function isServerRunning() {
  return await ping();
}

module.exports = { search, quickSearch, ping, getStats, shutdown, isServerRunning, PORT, HOST };
