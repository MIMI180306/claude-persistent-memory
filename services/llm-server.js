#!/usr/bin/env node
/**
 * LLM Server (Azure OpenAI) - 使用 Azure OpenAI API 的 LLM 分类服务
 *
 * 功能与 llm-server.js 相同，但使用 Azure OpenAI 而非本地 llama-server
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

// Azure OpenAI 配置
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

// ============== 请求处理 ==============

async function handleRequest(data) {
  const { action, text } = data;

  switch (action) {
    case 'ping':
      return { success: true, ready: isReady };

    case 'analyze': {
      const messages = [
        {
          role: 'system',
          content: `你是一个记忆价值评估助手。严格判断用户输入是否值得作为长期记忆保存。

分类字段：
- type: preference(偏好)/decision(决策)/pattern(模式)/fact(事实)/context(临时上下文)
- domain: frontend/backend/database/devops/testing/memory/general
- capture: true(值得长期保存)/false(不保存)
- reason: 简短说明判断理由
- keywords: 3-5个关键词数组

【capture=true 的标准】只有以下情况才值得保存：
1. 用户明确的偏好/习惯（跨会话通用）："我喜欢用 TypeScript"、"不要用 var"、"以后都用这种格式"
2. 架构决策及其原因："用 Redis 做缓存因为..."、"选择方案A而不是B"
3. 反复出现的错误模式和解决方案
4. 项目级别的事实/约定："这个项目用 Vue 2"、"API 必须返回 { code, msg, data }"
5. 用户明确说"记住"、"以后"、"总是"、"永远不要"等持久性指令

【capture=false 的标准】以下内容不保存：
1. 一次性操作指令："优化一下xxx"、"把xxx改成yyy"、"加一个xxx功能"、"修改xxx"
2. 当前任务的具体实现步骤
3. 提问或询问
4. 调试命令、临时测试
5. 只在当前会话有意义的上下文
6. 已经完成的任务描述

默认倾向：如果不确定，选择 capture=false。宁可漏掉也不要保存低价值内容。

只返回 JSON，不要其他内容。`
        },
        {
          role: 'user',
          content: text
        }
      ];

      try {
        const response = await callAzureOpenAI(messages, 200);

        // 解析 JSON
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
        fact: '只需 <what>',
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
          content: `你是一个记忆结构化助手。将内容结构化为XML格式的持久记忆。

首先判断：是否有长期保存价值？
- 一次性操作指令（"把A改成B"）→ 返回 REJECT
- 临时对话/调试请求 → 返回 REJECT
- 只在当前会话有意义 → 返回 REJECT

如果有价值，输出XML（不要输出其他内容）：
<memory type="${memType || 'context'}" domain="只选一个: frontend/backend/database/devops/testing/memory/general">
  <what>核心事实，1-2句，去掉冗余词（必填）</what>
  <when>何时触发/适用（用|分隔多个场景）</when>
  <do>具体操作步骤或命令（用；分隔）</do>
  <warn>禁止事项或易错点</warn>
</memory>

当前类型 ${memType || 'context'} 使用字段: ${rule}
不需要的字段直接省略。`
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
          content: `你是一个知识聚合助手。将多条相关记忆去重合并为一条XML记忆。

合并规则：
- <what> 用1-2句概括所有记忆的核心主题
- <when> 合并所有适用场景（用|分隔）
- <do> 合并所有具体操作（用；分隔），去掉重复
- <warn> 合并所有警告，去掉重复

只输出XML：
<memory type="pattern" domain="${d}">
  <what>...</what>
  <when>...</when>
  <do>...</do>
  <warn>...</warn>
</memory>`
        },
        {
          role: 'user',
          content: `合并以下 ${memories.length} 条记忆：\n\n${memoriesText}`
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
        { role: 'system', content: '判断用户消息的情感倾向。只返回一个词: positive / negative / neutral' },
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
          content: `你是一个开发会话分析助手。分析会话记录，提取值得长期记忆的内容。

【提取标准】只提取：
1. bug: 遇到错误→修复的经验（包含错误信息和修复方法）
2. decision: 用户明确表达的技术决策或偏好（"以后都用X"、"不要用Y"）
3. pattern: 可复用的开发模式或操作流程
4. preference: 用户的编码习惯、工具偏好

【不要提取】
- 一次性操作指令（"添加按钮"、"修改接口"、"优化xxx"）
- 代码快照或具体实现细节（代码会变，不值得记忆）
- 普通的文件查看/搜索/安装依赖/启动服务
- 信息查询和问答
- 当前任务的具体步骤

【输出格式】
对每条记忆返回一个 <memory> 块：
<memory type="只选一个: bug/decision/pattern/preference" domain="只选一个: frontend/backend/database/devops/testing/memory/general" confidence="0.7-0.9">
  <summary>纯文本摘要（一句话）</summary>
  <what>核心事实（1-2句）</what>
  <when>触发场景（可选，用|分隔）</when>
  <do>具体操作（可选，用；分隔）</do>
  <warn>注意事项（可选）</warn>
</memory>

如果没有值得保存的内容，只返回 NONE。
宁可少提取也不要提取低价值内容。最多返回 3 条。`
        },
        {
          role: 'user',
          content: `=== 会话记录 ===\n${transcript}`
        }
      ];

      try {
        const response = await callAzureOpenAI(messages, null);
        const trimmed = response.trim();

        if (/^NONE$/i.test(trimmed)) {
          return { success: true, memories: [] };
        }

        // 提取所有 <memory> 块
        const memoryBlocks = [];
        const regex = /<memory\s+([^>]+)>([\s\S]*?)<\/memory>/g;
        let match;
        while ((match = regex.exec(trimmed)) !== null) {
          const attrs = match[1];
          const body = match[2];

          // 解析属性
          const type = (attrs.match(/type="([^"]+)"/) || [])[1] || 'pattern';
          const domain = (attrs.match(/domain="([^"]+)"/) || [])[1] || 'general';
          const confidence = parseFloat((attrs.match(/confidence="([^"]+)"/) || [])[1] || '0.8');

          // 提取 summary
          const summaryMatch = body.match(/<summary>([\s\S]*?)<\/summary>/);
          const summary = summaryMatch ? summaryMatch[1].trim() : '';

          // 构建 structured_content（去掉 summary 标签，保留其他）
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
        { role: 'system', content: '判断以下命令输出是否包含错误。只返回JSON: {"isError": true/false, "errorType": "简短描述"}' },
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

// ============== 服务器启动 ==============

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

  // 检查连接
  const connected = await checkAzureConnection();
  if (!connected) {
    console.error('[LLMServer-Azure] Failed to connect to Azure OpenAI');
    process.exit(1);
  }
  console.error('[LLMServer-Azure] Azure OpenAI connected');
  isReady = true;

  // 创建 TCP 服务器
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

  // 优雅关闭
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
