<p align="center">
  <img src="./assets/logo.png" alt="Claude Persistent Memory" width="120" />
</p>

<h1 align="center">Claude Persistent Memory</h1>

<p align="center">
  <strong>让 Claude Code 拥有跨会话的持久记忆。</strong><br/>
  BM25 + 向量混合语义搜索 · LLM 驱动的结构化 · 4 通道检索（MCP + Hooks）
</p>

<p align="center">
  <a href="https://github.com/MIMI180306/claude-persistent-memory/blob/main/LICENSE"><img src="https://img.shields.io/github/license/MIMI180306/claude-persistent-memory?style=flat-square&color=blue" alt="License"></a>
  <a href="https://github.com/MIMI180306/claude-persistent-memory/stargazers"><img src="https://img.shields.io/github/stars/MIMI180306/claude-persistent-memory?style=flat-square&color=yellow" alt="Stars"></a>
  <a href="https://github.com/MIMI180306/claude-persistent-memory/issues"><img src="https://img.shields.io/github/issues/MIMI180306/claude-persistent-memory?style=flat-square" alt="Issues"></a>
  <a href="https://github.com/MIMI180306/claude-persistent-memory/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/MIMI180306/claude-persistent-memory/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" alt="Node >= 18">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform">
</p>

<p align="center">
  <a href="./README.md">English</a> | <strong>中文</strong>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#系统架构">系统架构</a> •
  <a href="#mcp-工具">MCP 工具</a> •
  <a href="#配置说明">配置说明</a> •
  <a href="#参与贡献">参与贡献</a>
</p>

---

## 功能特性

🧠 **混合搜索** — BM25 全文检索（FTS5）+ 向量语义相似度（sqlite-vec），融合排序

📡 **4 通道检索** — 拉取（MCP 工具按需调用）+ 推送（通过 Hooks 在用户输入、工具调用前后自动注入）

🏗️ **LLM 结构化** — 记忆自动结构化为 `<what>/<when>/<do>/<warn>` XML 格式

📦 **自动聚类** — 相似记忆自动分组，成熟聚类晋升为可复用的技能（Skill）

📊 **置信度评分** — 记忆通过验证反馈和使用频率动态调整置信度

⏳ **时间衰减** — 按记忆类型配置半衰期（事实：90天，上下文：30天，技能：永不衰减）

🔒 **本地优先** — 所有数据存储在本地 SQLite，你的记忆永远不会离开你的设备

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Code 会话                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  拉取通道（按需）                   推送通道（自动）          │
│  ┌───────────────────┐    ┌──────────────────────────────┐  │
│  │ MCP 服务器         │    │ UserPromptSubmit Hook        │  │
│  │ memory_search     │    │ PreToolUse Hook              │  │
│  │ memory_save       │    │ PostToolUse Hook             │  │
│  │ memory_validate   │    │ PreCompact Hook (分析)       │  │
│  │ memory_stats      │    │ SessionEnd Hook (聚类)       │  │
│  └────────┬──────────┘    └──────────────┬───────────────┘  │
│           │                              │                  │
│           └──────────┬───────────────────┘                  │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              SQLite + FTS5 + sqlite-vec                 ││
│  │              (memory.db)                                ││
│  └─────────────────────────────────────────────────────────┘│
│                      ▲                                      │
│           ┌──────────┴───────────────────┐                  │
│           │                              │                  │
│  ┌────────┴──────────┐    ┌──────────────┴───────────────┐  │
│  │ 向量嵌入服务器     │    │ LLM 服务器                   │  │
│  │ TCP :23811        │    │ TCP :23812                   │  │
│  │ bge-m3 (1024维)   │    │ Azure OpenAI GPT-4.1        │  │
│  └───────────────────┘    └──────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 快速开始

### 1. 安装

```bash
git clone https://github.com/MIMI180306/claude-persistent-memory.git
cd claude-persistent-memory
npm install
```

### 2. 配置

```bash
cp config.default.js config.js
```

编辑 `config.js`，设置 Azure OpenAI 凭据（或使用环境变量）：

```bash
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"
export AZURE_OPENAI_KEY="your-api-key"
export AZURE_OPENAI_DEPLOYMENT="gpt-4.1"
```

### 3. 启动服务

```bash
# 终端 1：向量嵌入服务器（加载 bge-m3 模型，约 2GB 内存）
npm run embedding-server

# 终端 2：LLM 服务器（代理 Azure OpenAI）
npm run llm-server
```

### 4. 配置 Claude Code

在项目的 `.mcp.json` 中添加 MCP 服务器：

```json
{
  "mcpServers": {
    "memory": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to>/claude-persistent-memory/services/memory-mcp-server.js"]
    }
  }
}
```

在项目的 `.claude/settings.json` 中添加 Hooks：

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "type": "command",
      "command": "node <path-to>/claude-persistent-memory/hooks/user-prompt-hook.js"
    }],
    "PreToolUse": [{
      "type": "command",
      "command": "node <path-to>/claude-persistent-memory/hooks/pre-tool-memory-hook.js"
    }],
    "PostToolUse": [{
      "type": "command",
      "command": "node <path-to>/claude-persistent-memory/hooks/post-tool-memory-hook.js"
    }],
    "PreCompact": [{
      "type": "command",
      "command": "node <path-to>/claude-persistent-memory/hooks/pre-compact-hook.js"
    }],
    "SessionEnd": [{
      "type": "command",
      "command": "node <path-to>/claude-persistent-memory/hooks/session-end-hook.js"
    }]
  }
}
```

## MCP 工具

| 工具 | 说明 |
|------|------|
| `memory_search` | 混合 BM25 + 向量搜索。参数：`query`、`limit?`、`type?`、`domain?` |
| `memory_save` | 保存新记忆。参数：`content`、`type?`、`domain?`、`confidence?` |
| `memory_validate` | 反馈循环 — 有帮助（+0.1）或无帮助（-0.05）。参数：`memory_id`、`is_valid` |
| `memory_stats` | 系统统计：记忆总数、类型/领域分布、聚类状态 |

## Hooks

| Hook | 事件 | 超时 | 功能 |
|------|------|------|------|
| `user-prompt-hook.js` | UserPromptSubmit | 1500ms | 嵌入用户查询 → 搜索 → 通过 stdout 注入最相关的记忆 |
| `pre-tool-memory-hook.js` | PreToolUse | 300ms | 嵌入工具上下文 → 搜索 → 通过 `additionalContext` 注入 |
| `post-tool-memory-hook.js` | PostToolUse | 300ms | 嵌入工具上下文 + 结果 → 搜索 → 通过 `additionalContext` 注入 |
| `pre-compact-hook.js` | PreCompact | 异步 | 启动 LLM 分析完整对话记录 → 提取记忆 |
| `session-end-hook.js` | SessionEnd | 异步 | 增量对话分析 + 聚类 + 成熟聚类合并 |

## 记忆类型

| 类型 | 半衰期 | 用途 |
|------|--------|------|
| `fact` | 90 天 | 代码库的稳定事实 |
| `decision` | 90 天 | 架构决策及其理由 |
| `bug` | 60 天 | Bug 修复和根本原因 |
| `pattern` | 90 天 | 常见代码模式 |
| `context` | 30 天 | 会话特定上下文 |
| `preference` | 60 天 | 用户工作流偏好 |
| `skill` | 永不衰减 | 从成熟聚类晋升而来 |

## 记忆生命周期

```
1. 保存       → memory_save 或从对话记录自动提取
2. 结构化     → LLM 转换为 <what>/<when>/<do>/<warn> XML
3. 嵌入       → bge-m3 生成 1024 维向量
4. 搜索       → BM25 + 向量相似度，融合排序
5. 验证       → memory_validate 调整置信度 ±
6. 聚类       → 相似记忆自动分组
7. 晋升       → 成熟聚类 → 技能记忆
8. 衰减       → 低置信度记忆随时间淡化
```

## 配置说明

所有配置项在 `config.js` 中（从 `config.default.js` 复制）：

```js
module.exports = {
  embeddingPort: 23811,          // 向量嵌入服务器 TCP 端口
  llmPort: 23812,                // LLM 服务器 TCP 端口
  dataDir: './data',             // memory.db 存储目录
  azure: {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    apiKey: process.env.AZURE_OPENAI_KEY || '',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1',
  },
  embedding: {
    model: 'Xenova/bge-m3',     // 1024 维，8192 token 上下文
    dimensions: 1024,
  },
  search: {
    maxResults: 3,               // 每次查询返回 top-K 结果
    minSimilarity: 0.6,          // 向量相似度阈值
  },
  cluster: {
    similarityThreshold: 0.70,   // 加入聚类的最低相似度
    maturityCount: 5,            // 聚类成熟所需的记忆数
  },
};
```

## 项目结构

```
claude-persistent-memory/
├── hooks/                        # Claude Code 生命周期 Hooks
│   ├── user-prompt-hook.js       # UserPromptSubmit → 记忆注入
│   ├── pre-tool-memory-hook.js   # PreToolUse → 记忆注入
│   ├── post-tool-memory-hook.js  # PostToolUse → 记忆注入
│   ├── pre-compact-hook.js       # PreCompact → 对话分析
│   └── session-end-hook.js       # SessionEnd → 聚类
├── lib/                          # 核心库
│   ├── memory-db.js              # SQLite + FTS5 + sqlite-vec
│   ├── embedding-client.js       # 向量嵌入服务器 TCP 客户端
│   ├── llm-client.js             # LLM 服务器 TCP 客户端
│   ├── compact-analyzer.js       # 对话记录 → 记忆提取
│   └── utils.js                  # 工具函数
├── services/                     # 后台服务
│   ├── embedding-server.js       # TCP 向量嵌入服务（bge-m3）
│   ├── llm-server.js             # TCP LLM 代理（Azure OpenAI）
│   └── memory-mcp-server.js      # Claude Code MCP 服务器
├── tools/
│   └── rebuild-vectors.js        # 重建所有向量嵌入
├── config.default.js             # 配置模板
├── CLAUDE.md                     # Claude Code 项目指令
└── package.json
```

## 环境要求

- Node.js >= 18
- macOS 或 Linux
- 约 2GB 内存（用于加载 bge-m3 向量嵌入模型）
- Azure OpenAI API 访问权限（用于 LLM 结构化）

## 注意事项

- **LLM 提供商**：目前仅支持 Azure OpenAI。如需使用标准 OpenAI 或其他提供商，请修改 `services/llm-server.js`。
- **端口**：向量嵌入和 LLM 服务器默认使用 TCP 23811 / 23812 端口，如有冲突请在 `config.js` 中修改。
- **数据存储**：`data/` 目录（包含 `memory.db` 和日志）在首次运行时自动创建，已加入 gitignore。

## 参与贡献

欢迎贡献代码！请在提交 PR 前阅读 [贡献指南](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE) © MIMI180306