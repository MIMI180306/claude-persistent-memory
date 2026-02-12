#!/usr/bin/env node
/**
 * LLM Server (Azure OpenAI) - LLM classification service using Azure OpenAI API
 *
 * Same functionality as llm-server.js, but uses Azure OpenAI instead of local llama-server
 */

const net = require('net');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');
const { ensureDir } = require('../lib/utils');

const PORT = config.llmPort;
const PID_FILE = path.join(config.pidDir, 'claude-llm.pid');

// Azure OpenAI Configuration
const AZURE_CONFIG = {
  endpoint: config.azure.endpoint,
  apiKey: config.azure.apiKey,
  deployment: config.azure.deployment,
  apiVersion: config.azure.apiVersion,
};

if (!AZURE_CONFIG.endpoint || !AZURE_CONFIG.apiKey) {
  console.error('[LLMServer] Error: Azure OpenAI endpoint and apiKey must be configured.');
  console.error('[LLMServer] Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_KEY environment variables,');
  console.error('[LLMServer] or configure them in config.js');
  process.exit(1);
}

let isReady = false;
let server = null;

const LOG_FILE = path.join(config.logDir, 'llm-server.log');
ensureDir(config.logDir);

function str(v) { return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); }

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

// ============== Azure OpenAI API ==============

async function callAzureOpenAI(messages, maxTokens = 200) {
  const startTime = Date.now();
  const userMsg = messages.find(m => m.role === 'user');
  const sysMsg = messages.find(m => m.role === 'system');
  log(`[AZURE-REQ] system=${str(sysMsg?.content)} user=${str(userMsg?.content)} max_tokens=${maxTokens}`);

  return new Promise((resolve, reject) => {
    const url = new URL(
      `/openai/deployments/${AZURE_CONFIG.deployment}/chat/completions?api-version=${AZURE_CONFIG.apiVersion}`,
      AZURE_CONFIG.endpoint
    );

    const postData = JSON.stringify({
      messages,
      max_tokens: maxTokens || 32768,
      temperature: 0.1
    });

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_CONFIG.apiKey
      },
      timeout: 60000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const duration = Date.now() - startTime;
        try {
          const json = JSON.parse(data);
          if (json.error) {
            log(`[AZURE-ERR] duration=${duration}ms error=${json.error.message || 'Azure API error'}`);
            reject(new Error(json.error.message || 'Azure API error'));
          } else {
            const content = json.choices?.[0]?.message?.content || '';
            const usage = json.usage || {};
            log(`[AZURE-RES] duration=${duration}ms tokens=${usage.prompt_tokens||'-'}/${usage.completion_tokens||'-'}/${usage.total_tokens||'-'} response=${str(content)}`);
            resolve(content);
          }
        } catch (e) {
          log(`[AZURE-ERR] duration=${duration}ms parse_error=${e.message} raw=${str(data)}`);
          reject(new Error(`Invalid response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', (e) => {
      const duration = Date.now() - startTime;
      log(`[AZURE-ERR] duration=${duration}ms network_error=${e.message}`);
      reject(e);
    });
    req.on('timeout', () => {
      const duration = Date.now() - startTime;
      log(`[AZURE-ERR] duration=${duration}ms timeout`);
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

// ============== Request Handling ==============

async function handleRequest(data) {
  const { action, text } = data;

  switch (action) {
    case 'ping':
      return { success: true, ready: isReady };

    case 'analyze': {
      const messages = [
        {
          role: 'system',
          content: `You are a memory value assessment assistant. Strictly determine whether user input is worth saving as long-term memory.

Classification fields:
- type: preference/decision/pattern/fact/context (temporary context)
- domain: frontend/backend/database/devops/testing/memory/general
- capture: true (worth long-term saving) / false (do not save)
- reason: brief explanation of the judgment
- keywords: array of 3-5 keywords

[Criteria for capture=true] Only the following are worth saving:
1. User's explicit preferences/habits (applicable across sessions): "I like using TypeScript", "don't use var", "always use this format from now on"
2. Architectural decisions and their reasons: "use Redis for caching because...", "chose option A over option B"
3. Recurring error patterns and their solutions
4. Project-level facts/conventions: "this project uses Vue 2", "API must return { code, msg, data }"
5. User explicitly says "remember", "from now on", "always", "never" and other persistence directives

[Criteria for capture=false] Do not save the following:
1. One-off operation instructions: "optimize xxx", "change xxx to yyy", "add xxx feature", "modify xxx"
2. Specific implementation steps for the current task
3. Questions or inquiries
4. Debugging commands, temporary tests
5. Context that only makes sense in the current session
6. Descriptions of already completed tasks

Default tendency: when in doubt, choose capture=false. Better to miss something than to save low-value content.

Return only JSON, nothing else.`
        },
        {
          role: 'user',
          content: text
        }
      ];

      try {
        const response = await callAzureOpenAI(messages, 200);

        // Parse JSON
        const result = {
          success: true,
          type: 'context',
          typeConfidence: 0.5,
          domain: 'general',
          domainConfidence: 0.5,
          shouldCapture: false,
          captureReason: '',
          keywords: []
        };

        try {
          const jsonMatch = response.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);

            const validTypes = ['preference', 'decision', 'pattern', 'fact', 'context'];
            const validDomains = ['frontend', 'backend', 'database', 'devops', 'testing', 'memory', 'general'];

            if (parsed.type) {
              const t = parsed.type.toLowerCase();
              result.type = validTypes.includes(t) ? t : 'context';
              result.typeConfidence = validTypes.includes(t) ? 0.9 : 0.5;
            }
            if (parsed.domain) {
              const d = parsed.domain.toLowerCase();
              result.domain = validDomains.includes(d) ? d : 'general';
              result.domainConfidence = validDomains.includes(d) ? 0.9 : 0.5;
            }
            if (parsed.capture !== undefined) {
              result.shouldCapture = parsed.capture === true || parsed.capture === 'true';
            }
            if (parsed.reason) result.captureReason = parsed.reason;
            if (parsed.keywords && Array.isArray(parsed.keywords)) {
              result.keywords = parsed.keywords.slice(0, 5);
            }
          }
        } catch (e) {
          console.error('[LLMServer-Azure] JSON parse failed:', e.message);
        }

        return result;
      } catch (e) {
        console.error('[LLMServer-Azure] API error:', e.message);
        return {
          success: false,
          error: e.message,
          type: 'context',
          typeConfidence: 0.5,
          domain: 'general',
          domainConfidence: 0.5,
          shouldCapture: false,
          captureReason: '',
          keywords: []
        };
      }
    }

    case 'structurize': {
      const { type: memType } = data;
      const typeRules = {
        fact: 'only <what>',
        pattern: '<what> + <when> + <do> + <warn>',
        decision: '<what> + <warn>',
        preference: '<what> + <warn>',
        bug: '<what> + <do>',
        context: '<what> + <when>'
      };
      const rule = typeRules[memType] || typeRules.context;

      const messages = [
        {
          role: 'system',
          content: `You are a memory structuring assistant. Structure content into XML-formatted persistent memory.

First determine: is this worth saving long-term?
- One-off operation instructions ("change A to B") -> return REJECT
- Temporary conversation/debugging requests -> return REJECT
- Only meaningful in the current session -> return REJECT

If it has value, output XML (do not output anything else):
<memory type="${memType || 'context'}" domain="choose one: frontend/backend/database/devops/testing/memory/general">
  <what>Core fact, 1-2 sentences, remove redundant words (required)</what>
  <when>When to trigger/apply (use | to separate multiple scenarios)</when>
  <do>Specific operation steps or commands (use ; to separate)</do>
  <warn>Prohibited actions or common pitfalls</warn>
</memory>

Current type ${memType || 'context'} uses fields: ${rule}
Omit fields that are not needed.`
        },
        {
          role: 'user',
          content: text
        }
      ];

      try {
        const response = await callAzureOpenAI(messages, 300);
        const trimmed = response.trim();

        if (/REJECT/i.test(trimmed) && !trimmed.includes('<memory')) {
          return { success: true, structured: { __rejected: true, reason: 'low value' } };
        }

        const xmlMatch = trimmed.match(/<memory[\s\S]*?<\/memory>/);
        if (xmlMatch) {
          return { success: true, structured: xmlMatch[0] };
        }
        return { success: false, error: 'No XML found in response' };
      } catch (e) {
        console.error('[LLMServer-Azure] Structurize error:', e.message);
        return { success: false, error: e.message };
      }
    }

    case 'merge': {
      const { memories, domain: mergeDomain } = data;
      if (!memories || !Array.isArray(memories) || memories.length === 0) {
        return { success: false, error: 'memories array required' };
      }

      const d = mergeDomain || 'general';
      const memoriesText = memories.map((m, i) => `[${i + 1}] ${m}`).join('\n');
      const messages = [
        {
          role: 'system',
          content: `You are a knowledge aggregation assistant. Deduplicate and merge multiple related memories into a single XML memory.

Merge rules:
- <what> Summarize the core theme of all memories in 1-2 sentences
- <when> Merge all applicable scenarios (use | to separate)
- <do> Merge all specific operations (use ; to separate), remove duplicates
- <warn> Merge all warnings, remove duplicates

Output only XML:
<memory type="pattern" domain="${d}">
  <what>...</what>
  <when>...</when>
  <do>...</do>
  <warn>...</warn>
</memory>`
        },
        {
          role: 'user',
          content: `Merge the following ${memories.length} memories:\n\n${memoriesText}`
        }
      ];

      try {
        const response = await callAzureOpenAI(messages, 500);
        const xmlMatch = response.match(/<memory[\s\S]*?<\/memory>/);
        if (xmlMatch) {
          return { success: true, merged: xmlMatch[0] };
        }

        // fallback
        return {
          success: true,
          merged: {
            summary: memories[0].slice(0, 100),
            content: memories.join('\n---\n'),
            scenarios: [], rules: { must: [], must_not: [], prefer: [] }, triggers: []
          }
        };
      } catch (e) {
        console.error('[LLMServer-Azure] Merge error:', e.message);
        return { success: false, error: e.message };
      }
    }

    case 'analyzeFeedback': {
      const messages = [
        { role: 'system', content: 'Determine the sentiment of the user message. Return only one word: positive / negative / neutral' },
        { role: 'user', content: text }
      ];
      try {
        const response = await callAzureOpenAI(messages, 20);
        const lower = response.trim().toLowerCase();
        const sentiment = ['positive', 'negative', 'neutral'].find(s => lower.includes(s)) || 'neutral';
        return { success: true, sentiment };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    case 'analyzeSession': {
      const { transcript } = data;
      if (!transcript || transcript.length < 50) {
        return { success: true, memories: [] };
      }

      const messages = [
        {
          role: 'system',
          content: `You are a development session analysis assistant. Analyze session transcripts and extract content worth saving as long-term memory.

[Extraction criteria] Only extract:
1. bug: error encountered -> fix experience (including error message and fix method)
2. decision: user's explicitly stated technical decisions or preferences ("always use X from now on", "don't use Y")
3. pattern: reusable development patterns or operational workflows
4. preference: user's coding habits, tool preferences

[Do NOT extract]
- One-off operation instructions ("add a button", "modify the API", "optimize xxx")
- Code snapshots or specific implementation details (code changes, not worth memorizing)
- Routine file viewing/searching/installing dependencies/starting services
- Information queries and Q&A
- Specific steps of the current task

[Output format]
Return a <memory> block for each memory:
<memory type="choose one: bug/decision/pattern/preference" domain="choose one: frontend/backend/database/devops/testing/memory/general" confidence="0.7-0.9">
  <summary>Plain text summary (one sentence)</summary>
  <what>Core fact (1-2 sentences)</what>
  <when>Trigger scenarios (optional, use | to separate)</when>
  <do>Specific operations (optional, use ; to separate)</do>
  <warn>Caveats (optional)</warn>
</memory>

If there is nothing worth saving, return only NONE.
Better to extract fewer items than to extract low-value content. Return at most 3 items.`
        },
        {
          role: 'user',
          content: `=== Session Transcript ===\n${transcript}`
        }
      ];

      try {
        const response = await callAzureOpenAI(messages, null);
        const trimmed = response.trim();

        if (/^NONE$/i.test(trimmed)) {
          return { success: true, memories: [] };
        }

        // Extract all <memory> blocks
        const memoryBlocks = [];
        const regex = /<memory\s+([^>]+)>([\s\S]*?)<\/memory>/g;
        let match;
        while ((match = regex.exec(trimmed)) !== null) {
          const attrs = match[1];
          const body = match[2];

          // Parse attributes
          const type = (attrs.match(/type="([^"]+)"/) || [])[1] || 'pattern';
          const domain = (attrs.match(/domain="([^"]+)"/) || [])[1] || 'general';
          const confidence = parseFloat((attrs.match(/confidence="([^"]+)"/) || [])[1] || '0.8');

          // Extract summary
          const summaryMatch = body.match(/<summary>([\s\S]*?)<\/summary>/);
          const summary = summaryMatch ? summaryMatch[1].trim() : '';

          // Build structured_content (remove summary tag, keep the rest)
          const structuredBody = body.replace(/<summary>[\s\S]*?<\/summary>\s*/, '');
          const structuredContent = `<memory type="${type}" domain="${domain}">\n${structuredBody.trim()}\n</memory>`;

          if (summary) {
            memoryBlocks.push({ type, domain, confidence, summary, structuredContent });
          }
        }

        return { success: true, memories: memoryBlocks };
      } catch (e) {
        console.error('[LLMServer-Azure] analyzeSession error:', e.message);
        return { success: false, error: e.message, memories: [] };
      }
    }

    case 'analyzeError': {
      const messages = [
        { role: 'system', content: 'Determine whether the following command output contains an error. Return only JSON: {"isError": true/false, "errorType": "brief description"}' },
        { role: 'user', content: text }
      ];
      try {
        const response = await callAzureOpenAI(messages, 60);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return { success: true, isError: !!parsed.isError, errorType: parsed.errorType || '' };
        }
        return { success: true, isError: false, errorType: '' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

// ============== Server Startup ==============

async function checkAzureConnection() {
  try {
    const messages = [{ role: 'user', content: 'ping' }];
    await callAzureOpenAI(messages, 10);
    return true;
  } catch (e) {
    console.error('[LLMServer-Azure] Connection check failed:', e.message);
    return false;
  }
}

async function startServer() {
  console.error('[LLMServer-Azure] Starting...');
  console.error(`[LLMServer-Azure] Endpoint: ${AZURE_CONFIG.endpoint}`);
  console.error(`[LLMServer-Azure] Deployment: ${AZURE_CONFIG.deployment}`);

  // Check connection
  const connected = await checkAzureConnection();
  if (!connected) {
    console.error('[LLMServer-Azure] Failed to connect to Azure OpenAI');
    process.exit(1);
  }
  console.error('[LLMServer-Azure] Azure OpenAI connected');
  isReady = true;

  // Create TCP server
  server = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', async (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.trim()) {
          try {
            const data = JSON.parse(line);
            const response = await handleRequest(data);
            socket.write(JSON.stringify(response) + '\n');
          } catch (e) {
            socket.write(JSON.stringify({ success: false, error: e.message }) + '\n');
          }
        }
      }
    });

    socket.on('error', () => {});
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[LLMServer-Azure] Port ${PORT} already in use`);
      process.exit(0);
    }
    console.error('[LLMServer-Azure] Server error:', err.message);
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.error(`[LLMServer-Azure] Listening on port ${PORT}`);
    fs.writeFileSync(PID_FILE, process.pid.toString());
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.error('[LLMServer-Azure] SIGTERM received');
    cleanup();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.error('[LLMServer-Azure] SIGINT received');
    cleanup();
    process.exit(0);
  });
}

function cleanup() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch (e) {}
}

startServer().catch((err) => {
  console.error('[LLMServer-Azure] Failed to start:', err.message);
  process.exit(1);
});
