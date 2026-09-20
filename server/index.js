import 'dotenv/config'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const app = express()
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const databasePath = path.resolve(process.env.BRANCH_CHAT_DATABASE_PATH || path.join(root, 'data', 'branch-chat.sqlite'))
const dataDirectory = path.dirname(databasePath)
fs.mkdirSync(dataDirectory, { recursive: true })
// 单机应用使用一份 SQLite 状态，保留完整的分支树结构。
const database = new DatabaseSync(databasePath)
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
const readStoredState = database.prepare('SELECT payload, updated_at FROM app_state WHERE id = 1')
const writeStoredState = database.prepare(`
  INSERT INTO app_state (id, payload, updated_at)
  VALUES (1, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
`)
const positiveNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
const positiveInteger = (value, fallback) => Math.floor(positiveNumber(value, fallback))
const modelOptions = [
  {
    id: 'glm',
    label: process.env.GLM_MODEL || 'glm-5.2',
    provider: '智谱',
    apiUrl: process.env.GLM_API_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKey: () => process.env.GLM_API_KEY,
    model: process.env.GLM_MODEL || 'glm-5.2',
    contextWindow: positiveNumber(process.env.GLM_CONTEXT_WINDOW, 1_000_000),
    maxTokens: positiveInteger(process.env.GLM_MAX_TOKENS, 65_536),
    timeoutMs: positiveInteger(process.env.GLM_TIMEOUT_MS, 10 * 60 * 1000),
    temperatureMax: 1,
  },
  {
    id: 'deepseek-flash',
    label: 'DeepSeek V4 Flash',
    provider: 'DeepSeek',
    apiUrl: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions',
    apiKey: () => process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash',
    contextWindow: positiveNumber(process.env.DEEPSEEK_CONTEXT_WINDOW, 1_000_000),
    maxTokens: positiveInteger(process.env.DEEPSEEK_MAX_TOKENS, 393_216),
    timeoutMs: positiveInteger(process.env.DEEPSEEK_TIMEOUT_MS, 30 * 60 * 1000),
    temperatureMax: 2,
  },
  {
    id: 'deepseek-pro',
    label: 'DeepSeek V4 Pro',
    provider: 'DeepSeek',
    apiUrl: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions',
    apiKey: () => process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro',
    contextWindow: positiveNumber(process.env.DEEPSEEK_CONTEXT_WINDOW, 1_000_000),
    maxTokens: positiveInteger(process.env.DEEPSEEK_MAX_TOKENS, 393_216),
    timeoutMs: positiveInteger(process.env.DEEPSEEK_TIMEOUT_MS, 30 * 60 * 1000),
    temperatureMax: 2,
  },
]

app.use(express.json({ limit: '50mb' }))
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  next()
})

app.get('/api/config', (_req, res) => {
  res.json({
    defaultModelId: modelOptions.find((item) => item.apiKey())?.id || modelOptions[0].id,
    models: modelOptions.map(({ id, label, provider, model, contextWindow, temperatureMax, apiKey }) => ({
      id, label, provider, model, contextWindow, temperatureMax, configured: Boolean(apiKey()),
    })),
  })
})

app.get('/api/state', (_req, res) => {
  const stored = readStoredState.get()
  if (!stored) return res.json({ state: null, updatedAt: null })
  try {
    res.json({ state: JSON.parse(stored.payload), updatedAt: stored.updated_at })
  } catch {
    console.error('数据库中的应用状态无法解析')
    res.status(500).json({ error: '本地数据库中的对话记录已损坏' })
  }
})

app.put('/api/state', (req, res) => {
  const nextState = req.body
  if (!nextState || !Array.isArray(nextState.chats) || typeof nextState.currentId !== 'string') {
    return res.status(400).json({ error: '对话状态格式无效' })
  }
  try {
    writeStoredState.run(JSON.stringify(nextState))
    res.status(204).end()
  } catch (error) {
    console.error(`保存本地数据库失败: ${error.message}`)
    res.status(500).json({ error: '无法保存到本地数据库' })
  }
})

app.post('/api/chat', async (req, res) => {
  const requestId = crypto.randomUUID().slice(0, 8)
  const startedAt = Date.now()
  const { messages, thinking = false, modelId = 'glm', temperature = 1 } = req.body || {}
  const selectedModel = modelOptions.find((item) => item.id === modelId)
  if (!selectedModel) return res.status(400).json({ error: '不支持所选模型' })
  const safeTemperature = Number(temperature)
  if (!Number.isFinite(safeTemperature) || safeTemperature < 0 || safeTemperature > selectedModel.temperatureMax) {
    return res.status(400).json({ error: `temperature 必须在 0 到 ${selectedModel.temperatureMax} 之间` })
  }
  const apiKey = selectedModel.apiKey()
  if (!apiKey) return res.status(503).json({ error: `${selectedModel.provider} API Key 尚未配置` })
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 不能为空' })
  }

  const safeMessages = messages
    .filter((item) => ['user', 'assistant', 'system'].includes(item?.role))
    .map(({ role, content }) => ({ role, content: String(content || '') }))

  try {
    console.log(`[${requestId}] 请求 ${selectedModel.label}：${safeMessages.length} 条消息，深度思考=${thinking ? '开启' : '关闭'}`)
    const upstream = await fetch(selectedModel.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: selectedModel.model,
        messages: safeMessages,
        thinking: { type: thinking ? 'enabled' : 'disabled' },
        reasoning_effort: thinking ? (selectedModel.provider === 'DeepSeek' ? 'high' : 'max') : undefined,
        stream: true,
        temperature: selectedModel.provider === 'DeepSeek' && thinking ? undefined : Math.round(safeTemperature * 100) / 100,
        max_tokens: selectedModel.maxTokens,
      }),
      signal: AbortSignal.timeout(selectedModel.timeoutMs),
    })

    if (!upstream.ok) {
      const detail = await upstream.text()
      let message = `上游 API 请求失败（${upstream.status}）`
      try {
        const parsed = JSON.parse(detail)
        message = parsed?.error?.message || parsed?.message || message
      } catch { /* upstream may return plain text */ }
      console.error(`[${requestId}] 上游错误 ${upstream.status}: ${message}`)
      return res.status(upstream.status).json({ error: message, requestId })
    }

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Branch-Chat-Request-Id', requestId)
    res.flushHeaders()

    const reader = upstream.body.getReader()
    res.on('close', () => reader.cancel().catch(() => {}))
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
    res.end()
    console.log(`[${requestId}] 响应完成，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`)
  } catch (error) {
    const cause = error.cause?.message ? `：${error.cause.message}` : ''
    const message = `${error.message || '无法连接模型服务'}${cause}`
    console.error(`[${requestId}] 代理错误: ${message}`)
    if (!res.headersSent) res.status(502).json({ error: `无法连接 ${selectedModel.provider} 服务（${message}）`, requestId })
    else {
      res.write(`\ndata: ${JSON.stringify({ proxy_error: `连接中断：${message}`, requestId })}\n\n`)
      res.end()
    }
  }
})

app.get('/vendor/marked.js', (_req, res) => res.sendFile(path.join(root, 'node_modules', 'marked', 'lib', 'marked.esm.js')))
app.get('/vendor/dompurify.js', (_req, res) => res.sendFile(path.join(root, 'node_modules', 'dompurify', 'dist', 'purify.es.mjs')))
app.use('/src', express.static(path.join(root, 'src'), { dotfiles: 'deny' }))
app.get('/', (_req, res) => res.sendFile(path.join(root, 'index.html')))

app.listen(port, host, () => console.log(`Branch Chat server: http://localhost:${port}`))
