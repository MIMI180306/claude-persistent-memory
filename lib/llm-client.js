const net = require('net');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const LLM_PORT = config.llmPort;
const TIMEOUT_MS = config.timeout.llmDefault;
const LOG_FILE = path.join(config.logDir, 'llm-calls.log');

const { ensureDir } = require('./utils');
ensureDir(path.dirname(LOG_FILE));

function str(v) { return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); }

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

async function request(action, params, timeout = TIMEOUT_MS) {
  const startTime = Date.now();
  log(`[REQ] action=${action} params=${str(params)}`);
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let response = '';
    let resolved = false;
    const done = (type, value) => {
      const duration = Date.now() - startTime;
      if (type === 'resolve') { log(`[RES] action=${action} duration=${duration}ms response=${str(value)}`); }
      else { log(`[ERR] action=${action} duration=${duration}ms error=${value.message || value}`); }
      type === 'resolve' ? resolve(value) : reject(value);
    };
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; client.destroy(); done('reject', new Error('LLM service timeout')); }
    }, timeout);
    client.connect(LLM_PORT, '127.0.0.1', () => { client.write(JSON.stringify({ action, ...params }) + '\n'); });
    client.on('data', (data) => {
      response += data.toString();
      if (response.endsWith('\n')) {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true; client.destroy();
          try {
            const result = JSON.parse(response.trim());
            if (result.success) { done('resolve', result); }
            else { done('reject', new Error(result.error || 'LLM request failed')); }
          } catch (e) { done('reject', new Error('Invalid response from LLM service')); }
        }
      }
    });
    client.on('error', (err) => { clearTimeout(timer); if (!resolved) { resolved = true; done('reject', err); } });
    client.on('close', () => { clearTimeout(timer); if (!resolved) { resolved = true; done('reject', new Error('Connection closed')); } });
  });
}

async function isAvailable() { try { const result = await request('ping', {}, 2000); return result.success; } catch (e) { return false; } }
async function analyze(text) { try { const result = await request('analyze', { text }, 10000); return { type: result.type || 'context', typeConfidence: result.typeConfidence || 0.5, domain: result.domain || 'general', domainConfidence: result.domainConfidence || 0.5, keywords: result.keywords || [], shouldCapture: result.shouldCapture || false, captureReason: result.captureReason || '' }; } catch (e) { return null; } }
async function structurize(text, type) { try { const result = await request('structurize', { text, type }, 15000); if (result.success && result.structured) return result.structured; return null; } catch (e) { return null; } }
async function merge(memories, domain) { try { const result = await request('merge', { memories, domain }, 20000); if (result.success && result.merged) return result.merged; return null; } catch (e) { return null; } }
async function analyzeFeedback(text) { try { const result = await request('analyzeFeedback', { text }, 10000); return { sentiment: result.sentiment || 'neutral' }; } catch (e) { return null; } }
async function analyzeError(text) { try { const result = await request('analyzeError', { text }, 10000); return { isError: result.isError || false, errorType: result.errorType || '' }; } catch (e) { return null; } }
async function analyzeSession(transcript) { try { const result = await request('analyzeSession', { transcript }, 30000); return { memories: result.memories || [] }; } catch (e) { return { memories: [] }; } }

module.exports = { isAvailable, analyze, structurize, merge, analyzeFeedback, analyzeError, analyzeSession, LLM_PORT };
