import { marked } from '/vendor/marked.js'
import DOMPurify from '/vendor/dompurify.js'

const $ = (selector) => document.querySelector(selector)
const uid = () => crypto.randomUUID()
const ROOT = 'root'
const STORAGE_KEY = 'branch-chat-v1'
const MAX_FILE_SIZE = 300 * 1024
const MAX_TOTAL_SIZE = 750 * 1024
const MAX_FILES = 5
const DEFAULT_SIDEBAR_WIDTH = 252
const DEFAULT_TREE_WIDTH = 374
const MIN_MAIN_WIDTH = 640
const TEXT_EXTENSIONS = new Set(['txt','md','markdown','csv','json','jsonl','xml','html','htm','css','js','mjs','cjs','ts','tsx','jsx','py','java','c','cpp','h','hpp','cs','go','rs','php','rb','swift','kt','kts','sh','ps1','yaml','yml','toml','ini','conf','log','sql','srt'])

marked.setOptions({ gfm: true, breaks: true })
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
  if (node.tagName === 'IMG') {
    node.setAttribute('loading', 'lazy')
    node.setAttribute('referrerpolicy', 'no-referrer')
  }
})

const els = {
  shell: $('.app-shell'), main: $('.main'), sidebar: $('#sidebar'), overlay: $('#overlay'), history: $('#history'),
  messages: $('#messages'), empty: $('#emptyState'), prompt: $('#prompt'), send: $('#sendButton'),
  think: $('#thinkToggle'), scroll: $('#chatScroll'), tree: $('#treeCanvas'), treeSummary: $('#treeSummary'),
  toast: $('#toast'), status: $('#apiStatus'), dot: $('#statusDot'), model: $('#modelName'), headerModel: $('#headerModel'),
  modelSelect: $('#modelSelect'), modelButton: $('#modelButton'), modelMenu: $('#modelMenu'), modelBrandDot: $('#modelBrandDot'),
  composer: $('#composer'), attach: $('#attachButton'), fileInput: $('#fileInput'), attachmentList: $('#attachmentList'),
  contextMeter: $('#contextMeter'), contextGauge: $('#contextGauge'), contextRemaining: $('#contextRemaining'), contextPopover: $('#contextPopover'),
  contextUsed: $('#contextUsed'), contextLeft: $('#contextLeft'), contextTotal: $('#contextTotal'),
  sidebarCollapse: $('#sidebarCollapse'), menuButton: $('#menuButton'),
  sidebarResizer: $('#sidebarResizer'), treeResizer: $('#treeResizer'),
  treeZoomOut: $('#treeZoomOut'), treeZoomIn: $('#treeZoomIn'), treeZoomReset: $('#treeZoomReset'), treeZoomLabel: $('#treeZoomLabel'),
  temperatureButton: $('#temperatureButton'), temperatureButtonValue: $('#temperatureButtonValue'), temperaturePopover: $('#temperaturePopover'),
  temperatureSlider: $('#temperatureSlider'), temperatureValue: $('#temperatureValue'), temperatureNotice: $('#temperatureNotice'),
  deleteDialog: $('#deleteDialog'), deleteDescription: $('#deleteDialogDescription'), deletePreview: $('#deleteDialogPreview'),
  deleteTitle: $('#deleteDialogTitle'), deleteCancel: $('#deleteCancel'), deleteConfirm: $('#deleteConfirm'),
  historyActionMenu: $('#historyActionMenu'), historyMenuRename: $('#historyMenuRename'), historyMenuDelete: $('#historyMenuDelete'),
}

const blankChat = () => ({ id: uid(), title: '新对话', nodes: {}, rootChildren: [], selected: {}, activeLeaf: ROOT, createdAt: Date.now() })
function normalizeState(candidate) {
  const normalized = candidate?.chats?.length ? candidate : { chats: [blankChat()], currentId: null, thinking: true }
  normalized.currentId = normalized.chats.some((chat) => chat.id === normalized.currentId) ? normalized.currentId : normalized.chats[0].id
  normalized.modelId ||= 'glm'
  normalized.sidebarCollapsed = Boolean(normalized.sidebarCollapsed)
  normalized.sidebarWidth = Number.isFinite(Number(normalized.sidebarWidth)) ? Math.min(420, Math.max(190, Number(normalized.sidebarWidth))) : DEFAULT_SIDEBAR_WIDTH
  normalized.treeWidth = Number.isFinite(Number(normalized.treeWidth)) ? Math.min(720, Math.max(280, Number(normalized.treeWidth))) : DEFAULT_TREE_WIDTH
  normalized.treeZoom = Number.isFinite(Number(normalized.treeZoom)) ? Math.min(2, Math.max(.01, Number(normalized.treeZoom))) : 1
  if (!normalized.temperatures || typeof normalized.temperatures !== 'object') normalized.temperatures = {}
  return normalized
}
let browserState
try { browserState = JSON.parse(localStorage.getItem(STORAGE_KEY)) } catch { browserState = null }
let state = normalizeState(browserState)
let controller = null
let models = []
let pendingAttachments = []
let streamingFrame = null
let editingNodeId = null
let editingDraft = ''
let editingAttachments = []
let nodeFocusTimer = null
let pendingDeleteNodeId = null
let pendingDeleteChatId = null
let deleteReturnFocus = null
let renamingChatId = null
let historyMenuChatId = null
let databaseReady = false
let savePendingBeforeDatabase = false
let saveTimer = null
let saveQueue = Promise.resolve()

const current = () => state.chats.find((c) => c.id === state.currentId)
const childrenOf = (chat, id) => id === ROOT ? chat.rootChildren : (chat.nodes[id]?.children || [])
const parentOf = (chat, id) => chat.nodes[id]?.parentId || ROOT
function persistSnapshot(snapshot) {
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const response = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: snapshot,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `保存失败（${response.status}）`)
    }
  }).catch((error) => {
    console.error('保存本地数据库失败', error)
    toast('本地数据库保存失败')
  })
}
function save() {
  if (!databaseReady) {
    savePendingBeforeDatabase = true
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    return
  }
  clearTimeout(saveTimer)
  const snapshot = JSON.stringify(state)
  saveTimer = setTimeout(() => persistSnapshot(snapshot), 120)
}
async function initializeDatabase() {
  try {
    const response = await fetch('/api/state')
    if (!response.ok) throw new Error(`读取失败（${response.status}）`)
    const stored = await response.json()
    if (stored.state?.chats?.length) {
      state = normalizeState(stored.state)
    } else {
      const migration = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      })
      if (!migration.ok) throw new Error(`迁移失败（${migration.status}）`)
      if (savePendingBeforeDatabase) {
        const latest = await fetch('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state),
        })
        if (!latest.ok) throw new Error(`同步迁移期间的修改失败（${latest.status}）`)
      }
      localStorage.removeItem(STORAGE_KEY)
      if (browserState?.chats?.length) toast('历史对话已迁移到本地数据库')
    }
    databaseReady = true
    savePendingBeforeDatabase = false
    applyPanelSizes(); syncResponsiveLayout(); applySidebarState(); render()
  } catch (error) {
    console.error('本地数据库初始化失败', error)
    toast('数据库不可用，暂时使用浏览器存储')
  }
}

function isCompactLayout() {
  return els.shell.classList.contains('layout-compact')
}
function syncResponsiveLayout() {
  const sidebarWidth = state.sidebarCollapsed ? 0 : state.sidebarWidth
  const treeWidth = els.shell.classList.contains('tree-open') ? state.treeWidth : 0
  const compact = window.innerWidth <= 900 || window.innerWidth - sidebarWidth - treeWidth < MIN_MAIN_WIDTH
  els.shell.classList.toggle('layout-compact', compact)
  if (!compact) els.sidebar.classList.remove('open')
  els.overlay.classList.toggle('show', compact && (els.sidebar.classList.contains('open') || els.shell.classList.contains('tree-open')))
}
function applySidebarState() {
  els.shell.classList.toggle('sidebar-collapsed', state.sidebarCollapsed && !isCompactLayout())
}
function panelWidthLimit(kind) {
  const minimum = kind === 'sidebar' ? 190 : 280
  const hardMaximum = kind === 'sidebar' ? 420 : 720
  const otherWidth = kind === 'sidebar'
    ? (els.shell.classList.contains('tree-open') ? state.treeWidth : 0)
    : (state.sidebarCollapsed ? 0 : state.sidebarWidth)
  return { minimum, maximum: Math.max(minimum, Math.min(hardMaximum, window.innerWidth - otherWidth - MIN_MAIN_WIDTH)) }
}
function applyPanelSizes() {
  els.shell.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`)
  els.shell.style.setProperty('--tree-width', `${state.treeWidth}px`)
  els.sidebarResizer.setAttribute('aria-valuenow', String(Math.round(state.sidebarWidth)))
  els.treeResizer.setAttribute('aria-valuenow', String(Math.round(state.treeWidth)))
}
function setPanelWidth(kind, value, persist = false) {
  const { minimum, maximum } = panelWidthLimit(kind)
  const width = Math.round(Math.min(maximum, Math.max(minimum, value)))
  if (kind === 'sidebar') state.sidebarWidth = width
  else state.treeWidth = width
  applyPanelSizes()
  if (persist) save()
}
function setupPanelResizer(handle, kind) {
  handle.addEventListener('pointerdown', (event) => {
    if (isCompactLayout() || event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = kind === 'sidebar' ? state.sidebarWidth : state.treeWidth
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('active'); els.shell.classList.add('resizing')
    const move = (moveEvent) => setPanelWidth(kind, startWidth + (kind === 'sidebar' ? moveEvent.clientX - startX : startX - moveEvent.clientX))
    const finish = () => {
      handle.classList.remove('active'); els.shell.classList.remove('resizing')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      save()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
  })
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || isCompactLayout()) return
    event.preventDefault()
    const currentWidth = kind === 'sidebar' ? state.sidebarWidth : state.treeWidth
    setPanelWidth(kind, currentWidth + (event.key === 'ArrowRight' ? 10 : -10), true)
  })
  handle.addEventListener('dblclick', () => setPanelWidth(kind, kind === 'sidebar' ? DEFAULT_SIDEBAR_WIDTH : DEFAULT_TREE_WIDTH, true))
}
function collapseSidebar() {
  if (isCompactLayout()) {
    els.sidebar.classList.remove('open')
    syncResponsiveLayout(); applySidebarState()
    return
  }
  state.sidebarCollapsed = true
  save(); syncResponsiveLayout(); applySidebarState()
}
function openSidebar() {
  if (isCompactLayout()) {
    els.shell.classList.remove('tree-open')
    if (window.innerWidth > 900) { state.sidebarCollapsed = false; save() }
    els.sidebar.classList.add('open')
    syncResponsiveLayout(); applySidebarState()
    return
  }
  state.sidebarCollapsed = false
  save(); syncResponsiveLayout(); applySidebarState()
}

function activePath(chat = current()) {
  const path = []
  let id = ROOT
  const seen = new Set()
  while (!seen.has(id)) {
    seen.add(id)
    const kids = childrenOf(chat, id)
    if (!kids.length) break
    const next = kids.includes(chat.selected[id]) ? chat.selected[id] : kids[kids.length - 1]
    path.push(next); id = next
  }
  chat.activeLeaf = path.at(-1) || ROOT
  return path
}

function focusMessageNode(nodeId) {
  requestAnimationFrame(() => {
    const message = els.messages.querySelector(`.message[data-id="${nodeId}"]`)
    if (!message) return
    message.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    message.classList.add('jump-target')
    clearTimeout(nodeFocusTimer)
    nodeFocusTimer = setTimeout(() => message.classList.remove('jump-target'), 1400)
  })
}

function selectNode(chat, nodeId, { focus = false } = {}) {
  const ancestry = []
  let id = nodeId
  while (id && id !== ROOT) { ancestry.unshift(id); id = parentOf(chat, id) }
  let parent = ROOT
  ancestry.forEach((child) => { chat.selected[parent] = child; parent = child })
  let leaf = nodeId
  while (childrenOf(chat, leaf).length) {
    const kids = childrenOf(chat, leaf)
    const next = kids.includes(chat.selected[leaf]) ? chat.selected[leaf] : kids[kids.length - 1]
    chat.selected[leaf] = next; leaf = next
  }
  chat.activeLeaf = leaf
  save(); render({ scrollToBottom: !focus })
  if (focus) focusMessageNode(nodeId)
}

function addNode(chat, role, content, parentId, extras = {}) {
  const node = { id: uid(), role, content, parentId, children: [], createdAt: Date.now(), ...extras }
  chat.nodes[node.id] = node
  if (parentId === ROOT) chat.rootChildren.push(node.id)
  else chat.nodes[parentId].children.push(node.id)
  chat.selected[parentId] = node.id
  chat.activeLeaf = node.id
  return node
}

function escapeHtml(value = '') { return value.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]) }
function formatBytes(bytes) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` }
function attachmentCards(attachments = []) {
  if (!attachments.length) return ''
  return `<div class="message-attachments">${attachments.map((file) => `<div class="message-attachment"><span>DOC</span><div><b>${escapeHtml(file.name)}</b><small>${formatBytes(file.size)}</small></div></div>`).join('')}</div>`
}
function attachmentChip(file, removeAttribute) {
  return `<div class="attachment-chip"><span class="file-icon">DOC</span><span class="file-meta"><b>${escapeHtml(file.name)}</b><small>${formatBytes(file.size)}</small></span><button type="button" ${removeAttribute}="${file.id}" aria-label="移除 ${escapeHtml(file.name)}">×</button></div>`
}
function inlineAttachmentEditor(attachments = []) {
  return `<div class="inline-edit-attachments ${attachments.length ? '' : 'hidden'}" data-edit-attachments>${attachments.map((file) => attachmentChip(file, 'data-remove-edit-file')).join('')}</div>`
}
function apiContent(node) {
  if (node.role !== 'user' || !node.attachments?.length) return node.content
  const files = node.attachments.map((file) => `[附件开始：${file.name}]\n${file.content}\n[附件结束：${file.name}]`).join('\n\n')
  return `${node.content}\n\n以下是用户上传的参考文件。请结合问题阅读文件内容：\n\n${files}`
}
function estimateTokens(value = '') {
  const text = String(value)
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length
  const ascii = (text.match(/[\x00-\x7f]/g) || []).length
  const other = Math.max(0, text.length - cjk - ascii)
  return Math.ceil(cjk / 1.55 + ascii / 4 + other / 2)
}
function formatTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`
  return String(tokens)
}
function contextUsage() {
  const chat = current()
  const path = activePath(chat)
  const editingIndex = editingNodeId ? path.indexOf(editingNodeId) : -1
  const countedPath = editingIndex >= 0 ? path.slice(0, editingIndex) : path
  const nodes = countedPath.map((id) => chat.nodes[id]).filter((node) => node?.content)
  let used = nodes.reduce((total, node) => total + estimateTokens(apiContent(node)) + 4, 2)
  const editingNode = editingIndex >= 0 ? chat.nodes[editingNodeId] : null
  const draft = editingNode ? editingDraft.trim() : els.prompt.value.trim()
  const attachments = editingNode ? editingAttachments : pendingAttachments
  if (draft || attachments.length) {
    const content = apiContent({ role: 'user', content: draft || '请阅读并分析附件。', attachments })
    used += estimateTokens(content) + 4
  }
  return Math.max(0, used)
}
function renderContextMeter() {
  const model = selectedModel()
  if (!model) { els.contextRemaining.textContent = '—'; return }
  const total = Number(model.contextWindow) || 1_000_000
  const used = contextUsage()
  const left = Math.max(0, total - used)
  const percent = Math.min(100, (used / total) * 100)
  els.contextRemaining.textContent = `剩余 ${formatTokens(left)}`
  els.contextUsed.textContent = `${formatTokens(used)} tokens`
  els.contextLeft.textContent = `${formatTokens(left)} tokens`
  els.contextTotal.textContent = `${formatTokens(total)} tokens`
  els.contextGauge.style.setProperty('--context-progress', `${percent}%`)
  els.contextMeter.classList.toggle('warning', percent >= 75 && percent < 90)
  els.contextMeter.classList.toggle('danger', percent >= 90)
  els.contextMeter.setAttribute('aria-label', `上下文估算：已使用 ${formatTokens(used)}，剩余 ${formatTokens(left)}`)
}
function markdown(value = '') {
  const rendered = marked.parse(String(value), { async: false })
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel', 'loading', 'referrerpolicy'],
  })
}

function branchControls(chat, node) {
  const siblings = childrenOf(chat, node.parentId)
  if (siblings.length < 2) return ''
  const index = siblings.indexOf(node.id)
  return `<button class="action branch-prev" data-id="${node.id}" ${index === 0 ? 'disabled' : ''}>‹</button><span class="branch-nav">${index + 1} / ${siblings.length}</span><button class="action branch-next" data-id="${node.id}" ${index === siblings.length - 1 ? 'disabled' : ''}>›</button>`
}

function renderMessages(autoScroll = true) {
  const chat = current(), path = activePath(chat)
  els.empty.classList.toggle('hidden', path.length > 0)
  els.main.classList.toggle('empty-mode', path.length === 0)
  els.messages.innerHTML = path.map((id) => {
    const node = chat.nodes[id]
    const branch = branchControls(chat, node)
    if (node.role === 'user') {
      if (node.id === editingNodeId) return `<article class="message user editing" data-id="${id}"><div class="user-bubble inline-edit-bubble">${inlineAttachmentEditor(editingAttachments)}<textarea class="inline-edit-text" data-edit-id="${id}" aria-label="编辑消息">${escapeHtml(editingDraft)}</textarea><input class="inline-edit-file-input" data-edit-file-input="${id}" type="file" multiple hidden accept=".txt,.md,.markdown,.csv,.json,.jsonl,.xml,.html,.htm,.css,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.hpp,.cs,.go,.rs,.php,.rb,.swift,.kt,.kts,.sh,.ps1,.yaml,.yml,.toml,.ini,.conf,.log,.sql,.srt,text/*" /><div class="inline-edit-footer"><div class="inline-edit-tools"><button class="inline-edit-attach" data-id="${id}" type="button" title="添加文件"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 12.5 5.9-5.9a3 3 0 0 1 4.2 4.2l-8.1 8.1a5 5 0 0 1-7.1-7.1l8-8"/><path d="m7.1 14 7.2-7.2"/></svg><span>添加文件</span></button><span class="inline-edit-shortcut">Esc 取消 · Ctrl/⌘ + Enter 发送</span></div><div class="inline-edit-actions"><button class="inline-edit-cancel" data-id="${id}" type="button">取消</button><button class="inline-edit-submit" data-id="${id}" type="button">发送</button></div></div></div></article>`
      return `<article class="message user" data-id="${id}"><div class="user-bubble">${attachmentCards(node.attachments)}<div class="user-text">${escapeHtml(node.content)}</div></div><div class="message-actions ${branch ? 'has-branches' : ''}">${branch}<button class="action edit-action" data-id="${id}" title="从这里创建新分支">编辑</button><button class="action copy-action" data-id="${id}">复制</button><button class="action delete-branch-action" data-id="${id}" title="删除这条消息及后续分支">删除分支</button></div></article>`
    }
    const reasoning = node.reasoning ? `<details class="reasoning" ${node.streaming ? 'open' : ''}><summary>${node.streaming ? '正在深度思考…' : '查看思考过程'}</summary><div class="reasoning-text">${escapeHtml(node.reasoning)}</div></details>` : ''
    return `<article class="message assistant" data-id="${id}"><div class="assistant-head"><span class="ai-avatar">枝</span><span>${escapeHtml(node.model || 'GLM')}</span></div>${reasoning}<div class="answer">${markdown(node.content)}${node.streaming ? '<span class="cursor"></span>' : ''}</div><div class="message-actions ${branch ? 'has-branches' : ''}">${branch}<button class="action copy-action" data-id="${id}">复制</button><button class="action retry-action" data-id="${id}" title="生成另一条回答分支">重新生成</button><button class="action delete-branch-action" data-id="${id}" title="删除这条消息及后续分支">删除分支</button></div></article>`
  }).join('')
  if (autoScroll) requestAnimationFrame(() => { els.scroll.scrollTop = els.scroll.scrollHeight })
}

function updateStreamingMessage(assistant) {
  const article = els.messages.querySelector(`.message.assistant[data-id="${assistant.id}"]`)
  if (!article) return
  const distanceFromBottom = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight
  const shouldFollow = distanceFromBottom < 120
  const answer = article.querySelector('.answer')
  let reasoning = article.querySelector('.reasoning')
  if (assistant.reasoning && !reasoning) {
    reasoning = document.createElement('details')
    reasoning.className = 'reasoning'
    reasoning.innerHTML = '<summary></summary><div class="reasoning-text"></div>'
    answer.before(reasoning)
  }
  if (reasoning) {
    reasoning.open = assistant.streaming
    reasoning.querySelector('summary').textContent = assistant.streaming ? '正在深度思考…' : '查看思考过程'
    reasoning.querySelector('.reasoning-text').textContent = assistant.reasoning
  }
  answer.innerHTML = `${markdown(assistant.content)}${assistant.streaming ? '<span class="cursor"></span>' : ''}`
  renderContextMeter()
  if (shouldFollow) els.scroll.scrollTop = els.scroll.scrollHeight
}

function scheduleStreamingMessage(assistant) {
  if (streamingFrame) return
  streamingFrame = requestAnimationFrame(() => {
    streamingFrame = null
    updateStreamingMessage(assistant)
  })
}

function noContentExplanation(finishReason, provider = '上游模型') {
  switch (finishReason) {
    case 'content_filter':
      return '上游模型报告正文因内容过滤被省略。'
    case 'sensitive':
      return '上游模型将本次请求标记为敏感内容，因此没有返回正文。'
    case 'length':
      return '上游模型达到输出长度上限，正文可能尚未开始或未能返回。'
    case 'insufficient_system_resource':
      return '上游模型因推理资源不足中断了生成。'
    case 'tool_calls':
      return '上游模型请求调用工具，但当前页面没有提供可调用的工具。'
    case 'stop':
      return `${provider} 以 stop 结束了生成，但没有返回正文。接口没有提供更具体的原因；仅凭 stop 无法区分普通结束、拒答或其他上游处理。`
    default:
      return '上游流结束时没有收到正文，也没有提供可识别的停止原因；可能是流中断或上游协议异常。'
  }
}

function noContentMessage(finishReason, requestId, provider = '上游模型') {
  const reason = finishReason ? `${provider} 返回的 finish_reason：\`${finishReason}\`` : `${provider} 未返回 finish_reason`
  const request = requestId ? `请求 ID：\`${requestId}\`` : '请求 ID：未提供'
  return `> ⚠️ ${noContentExplanation(finishReason, provider)}\n>\n> ${reason}\n> ${request}`
}

function renderHistory() {
  els.history.innerHTML = [...state.chats].sort((a,b) => b.createdAt-a.createdAt).map((chat) => {
    if (chat.id === renamingChatId) {
      return `<div class="history-row history-editing">
        <input class="history-title-input" data-rename-input="${chat.id}" value="${escapeHtml(chat.title)}" maxlength="80" aria-label="对话标题" />
        <button class="history-edit-button save" data-rename-save="${chat.id}" type="button" title="保存标题" aria-label="保存标题">✓</button>
        <button class="history-edit-button cancel" data-rename-cancel type="button" title="取消" aria-label="取消">×</button>
      </div>`
    }
    return `<div class="history-row ${chat.id === state.currentId ? 'active' : ''}">
      <button class="history-item" data-open-chat="${chat.id}" type="button" title="${escapeHtml(chat.title)}"><span>${escapeHtml(chat.title)}</span></button>
      <button class="history-more" data-history-menu="${chat.id}" type="button" title="对话选项" aria-label="“${escapeHtml(chat.title)}”的对话选项" aria-haspopup="menu" aria-expanded="${historyMenuChatId === chat.id}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>
      </button>
    </div>`
  }).join('')
}

function beginRenameChat(chatId) {
  if (!state.chats.some((chat) => chat.id === chatId)) return
  closeHistoryMenu()
  renamingChatId = chatId
  renderHistory()
  requestAnimationFrame(() => {
    const input = els.history.querySelector(`[data-rename-input="${chatId}"]`)
    input?.focus()
    input?.select()
  })
}

function cancelRenameChat() {
  if (!renamingChatId) return
  renamingChatId = null
  renderHistory()
}

function commitRenameChat(chatId) {
  const chat = state.chats.find((item) => item.id === chatId)
  const input = els.history.querySelector(`[data-rename-input="${chatId}"]`)
  if (!chat || !input) return
  const title = input.value.replace(/\s+/g, ' ').trim()
  if (!title) return toast('标题不能为空')
  chat.title = title.slice(0, 80)
  renamingChatId = null
  save(); renderHistory(); toast('标题已更新')
}

function openHistoryMenu(chatId, trigger) {
  const chat = state.chats.find((item) => item.id === chatId)
  if (!chat) return
  if (historyMenuChatId === chatId && els.historyActionMenu.classList.contains('open')) return closeHistoryMenu()
  historyMenuChatId = chatId
  const rect = trigger.getBoundingClientRect()
  const menuWidth = 154, menuHeight = 86, gap = 5
  const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth))
  const top = rect.bottom + menuHeight + gap <= window.innerHeight ? rect.bottom + gap : rect.top - menuHeight - gap
  els.historyActionMenu.style.left = `${left}px`
  els.historyActionMenu.style.top = `${Math.max(8, top)}px`
  els.historyActionMenu.classList.add('open')
  els.historyActionMenu.setAttribute('aria-hidden', 'false')
  trigger.setAttribute('aria-expanded', 'true')
}

function closeHistoryMenu() {
  if (historyMenuChatId) els.history.querySelector(`[data-history-menu="${historyMenuChatId}"]`)?.setAttribute('aria-expanded', 'false')
  historyMenuChatId = null
  els.historyActionMenu.classList.remove('open')
  els.historyActionMenu.setAttribute('aria-hidden', 'true')
}

function treeLayout(chat) {
  const nodes = Object.values(chat.nodes)
  if (!nodes.length) return { positioned: [], width: 300, height: 300 }
  const depth = {}; const visitDepth = (id, d) => { depth[id] = d; childrenOf(chat, id).forEach((k) => visitDepth(k, d + 1)) }
  chat.rootChildren.forEach((id) => visitDepth(id, 0))
  let nextY = 36; const y = {}
  const setY = (id) => { const kids = childrenOf(chat,id); if (!kids.length) y[id] = nextY, nextY += 58; else { kids.forEach(setY); y[id] = kids.reduce((s,k)=>s+y[k],0)/kids.length } }
  chat.rootChildren.forEach(setY)
  return { positioned: nodes.map((n) => ({ ...n, x: 38 + depth[n.id] * 90, y: y[n.id] })), width: Math.max(310, 95 + Math.max(...Object.values(depth)) * 90), height: Math.max(300, nextY + 20) }
}

function setTreeZoom(value) {
  const previous = state.treeZoom
  const next = Math.round(Math.min(2, Math.max(.01, value)) * 100) / 100
  if (next === previous) return
  const centerX = (els.tree.scrollLeft + els.tree.clientWidth / 2) / previous
  const centerY = (els.tree.scrollTop + els.tree.clientHeight / 2) / previous
  state.treeZoom = next
  save(); renderTree()
  requestAnimationFrame(() => {
    els.tree.scrollLeft = Math.max(0, centerX * next - els.tree.clientWidth / 2)
    els.tree.scrollTop = Math.max(0, centerY * next - els.tree.clientHeight / 2)
  })
}

function renderTree() {
  const chat = current(), path = new Set(activePath(chat)), { positioned, width, height } = treeLayout(chat)
  const map = Object.fromEntries(positioned.map((n) => [n.id,n]))
  const lines = positioned.filter((n) => n.parentId !== ROOT && map[n.parentId]).map((n) => { const p=map[n.parentId], active=path.has(n.id)&&path.has(p.id); return `<path d="M${p.x},${p.y} C${p.x+45},${p.y} ${n.x-45},${n.y} ${n.x},${n.y}" fill="none" stroke="${active?'#8aa6ff':'#292929'}" stroke-width="${active?2:1.2}"/>` }).join('')
  const dots = positioned.map((n) => { const active=path.has(n.id), label=n.content.replace(/\s+/g,' ').slice(0,13); return `<g class="tree-node" data-tree-id="${n.id}"><circle cx="${n.x}" cy="${n.y}" r="${active?8:6}" fill="${n.role==='user'?'#aaa':'#525252'}" stroke="${active?'#8aa6ff':'#090909'}" stroke-width="${active?3:2}"/><text x="${n.x+13}" y="${n.y+3}">${escapeHtml(label)}${n.content.length>13?'…':''}</text></g>` }).join('')
  const scaledWidth = Math.round(width * state.treeZoom), scaledHeight = Math.round(height * state.treeZoom)
  els.tree.innerHTML = positioned.length ? `<svg width="${scaledWidth}" height="${scaledHeight}" viewBox="0 0 ${width} ${height}">${lines}${dots}</svg>` : '<div class="empty-tree">发送消息后，这里会长出对话树。</div>'
  const branches = positioned.filter((n) => childrenOf(chat,n.id).length > 1).length + (chat.rootChildren.length > 1 ? 1 : 0)
  els.treeSummary.textContent = `${positioned.length} 个节点 · ${branches} 个分岔点`
  els.treeZoomLabel.textContent = `${Math.round(state.treeZoom * 100)}%`
  els.treeZoomOut.disabled = state.treeZoom <= .01
  els.treeZoomIn.disabled = state.treeZoom >= 2
}

function render({ scrollToBottom = true } = {}) { renderHistory(); renderMessages(scrollToBottom); renderTree(); renderContextMeter(); renderTemperatureControl(); els.think.classList.toggle('active', state.thinking); els.think.setAttribute('aria-pressed', String(state.thinking)) }

function selectedModel() { return models.find((item) => item.id === state.modelId) || models[0] }
function currentTemperature() {
  const model = selectedModel()
  if (!model) return 1
  const maximum = Number(model.temperatureMax) || 1
  const stored = Number(state.temperatures[model.id])
  return Number.isFinite(stored) ? Math.min(maximum, Math.max(0, stored)) : 1
}
function renderTemperatureControl() {
  const model = selectedModel()
  if (!model) return
  const maximum = Number(model.temperatureMax) || 1
  const value = currentTemperature()
  const ignored = model.provider === 'DeepSeek' && state.thinking
  els.temperatureSlider.max = String(maximum)
  els.temperatureSlider.value = String(value)
  els.temperatureValue.max = String(maximum)
  els.temperatureSlider.style.setProperty('--temperature-progress', `${maximum ? value / maximum * 100 : 0}%`)
  els.temperatureButtonValue.textContent = value.toFixed(2)
  els.temperatureValue.value = value.toFixed(2)
  els.temperatureButton.classList.toggle('inactive', ignored)
  els.temperatureNotice.textContent = ignored ? 'DeepSeek 思考模式下此参数不生效' : `当前模型范围：0.0–${maximum.toFixed(1)}`
  els.temperatureButton.setAttribute('aria-label', `调节 Temperature，当前 ${value.toFixed(2)}${ignored ? '，思考模式下不生效' : ''}`)
}
function renderModelSelector() {
  const selected = selectedModel()
  if (!selected) return
  els.headerModel.textContent = selected.label
  els.model.textContent = selected.label
  els.modelBrandDot.classList.toggle('deepseek', selected.provider === 'DeepSeek')
  els.status.textContent = selected.configured ? `${selected.provider} API 已就绪` : `${selected.provider} API Key 未配置`
  els.dot.className = `status-dot ${selected.configured ? 'ok' : 'bad'}`
  els.modelMenu.innerHTML = models.map((item) => `
    <button class="model-option ${item.id === selected.id ? 'selected' : ''}" data-model-id="${item.id}" role="menuitemradio" aria-checked="${item.id === selected.id}" ${item.configured ? '' : 'disabled'}>
      <span class="option-dot ${item.provider === 'DeepSeek' ? 'deepseek' : ''}"></span>
      <span><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.provider)} · ${item.configured ? item.model : 'API Key 未配置'}</small></span>
      <i>${item.id === selected.id ? '✓' : ''}</i>
    </button>`).join('')
  renderContextMeter()
  renderTemperatureControl()
}

async function streamReply(chat, assistant, messages, thinking) {
  controller = new AbortController(); els.send.classList.add('stop'); els.send.disabled = false; els.scroll.classList.add('streaming')
  try {
    const response = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ messages, thinking, modelId: state.modelId, temperature: currentTemperature() }), signal:controller.signal })
    assistant.requestId = response.headers.get('X-Branch-Chat-Request-Id') || ''
    if (!response.ok) {
      const body = await response.json().catch(()=>({}))
      assistant.requestId ||= body.requestId || ''
      throw new Error(body.error || `请求失败（${response.status}）`)
    }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', finishReason = null
    const consumeEvent = (event) => {
      const data = event.split(/\r?\n/).filter((line)=>line.startsWith('data:')).map((line)=>line.slice(5).trimStart()).join('\n').trim()
      if (!data || data === '[DONE]') return
      let parsed
      try { parsed = JSON.parse(data) } catch { return }
      if (parsed.proxy_error) throw new Error(parsed.proxy_error)
      const choice = parsed?.choices?.[0]
      if (!choice) return
      const delta = choice.delta || {}
      assistant.reasoning += delta.reasoning_content || ''
      assistant.content += delta.content || ''
      finishReason = choice.finish_reason || finishReason
    }
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      buffer += decoder.decode(value, { stream:true })
      const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || ''
      for (const event of events) consumeEvent(event)
      scheduleStreamingMessage(assistant)
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeEvent(buffer)
    const interrupted = {
      length: '生成达到输出长度上限。深度思考可能占满了输出额度，请缩短上下文后重新生成。',
      content_filter: '正文因内容安全策略被过滤。',
      insufficient_system_resource: 'DeepSeek 推理资源暂时不足，生成被中断，请稍后重新生成。',
      tool_calls: '模型请求调用工具，但当前页面尚未提供对应工具。',
    }[finishReason]
    assistant.finishReason = finishReason
    if (interrupted) assistant.content += `${assistant.content ? '\n\n' : ''}> ⚠️ ${interrupted}`
    else if (!assistant.content) assistant.content = noContentMessage(finishReason, assistant.requestId, selectedModel()?.provider)
  } catch (error) {
    if (error.name === 'AbortError') assistant.content ||= '（已停止生成）'
    else { assistant.content = `请求出错：${error.message}`; assistant.error = true }
  } finally {
    assistant.streaming = false
    if (streamingFrame) { cancelAnimationFrame(streamingFrame); streamingFrame = null }
    updateStreamingMessage(assistant)
    controller = null; els.send.classList.remove('stop'); els.scroll.classList.remove('streaming'); save(); renderTree()
  }
}

async function submit(text, parentId = current().activeLeaf, attachmentsOverride = null) {
  const attachmentSource = attachmentsOverride ?? pendingAttachments
  text = text.trim(); if ((!text && !attachmentSource.length) || controller) return
  if (attachmentsOverride === null) { editingNodeId = null; editingDraft = '' }
  if (!text) text = '请阅读并分析附件。'
  const attachments = attachmentSource.map((file) => ({ ...file }))
  const chat = current(), user = addNode(chat, 'user', text, parentId, { attachments })
  if (chat.title === '新对话') chat.title = text.replace(/\s+/g,' ').slice(0,28)
  const assistant = addNode(chat, 'assistant', '', user.id, { reasoning:'', streaming:true, model:els.headerModel.textContent })
  const path = activePath(chat).filter((id) => id !== assistant.id).map((id) => chat.nodes[id]).filter((n) => n.content).map((node)=>({role:node.role,content:apiContent(node)}))
  if (attachmentsOverride === null) { pendingAttachments = []; renderPendingAttachments(); els.prompt.value = ''; resizePrompt() }
  save(); render()
  await streamReply(chat, assistant, path, state.thinking)
}

async function retry(nodeId) {
  if (controller) return
  const chat=current(), old=chat.nodes[nodeId], user=chat.nodes[old.parentId]; if (!user) return
  selectNode(chat,user.id)
  const assistant=addNode(chat,'assistant','',user.id,{reasoning:'',streaming:true,model:els.headerModel.textContent})
  const path=activePath(chat).filter((id)=>id!==assistant.id).map((id)=>chat.nodes[id]).filter((n)=>n.content).map((node)=>({role:node.role,content:apiContent(node)}))
  save(); render(); await streamReply(chat,assistant,path,state.thinking)
}

function switchSibling(nodeId, offset) { const chat=current(), node=chat.nodes[nodeId], siblings=childrenOf(chat,node.parentId), next=siblings[siblings.indexOf(nodeId)+offset]; if (next) selectNode(chat,next,{focus:true}) }

function branchNodeIds(chat, nodeId) {
  const ids = [], stack = [nodeId], seen = new Set()
  while (stack.length) {
    const id = stack.pop()
    if (!id || seen.has(id) || !chat.nodes[id]) continue
    seen.add(id); ids.push(id)
    stack.push(...childrenOf(chat, id))
  }
  return ids
}

function openDeleteDialog(nodeId, trigger) {
  if (controller) return toast('请先停止当前生成')
  const chat = current(), node = chat.nodes[nodeId]
  if (!node) return
  const count = branchNodeIds(chat, nodeId).length
  pendingDeleteNodeId = nodeId
  pendingDeleteChatId = null
  deleteReturnFocus = trigger || null
  els.deleteTitle.textContent = '删除这个分支？'
  els.deleteConfirm.textContent = '删除分支'
  els.deleteDescription.textContent = count > 1
    ? `将永久删除这条消息及其后续 ${count - 1} 条消息。此操作无法撤销。`
    : '将永久删除这条消息。此操作无法撤销。'
  els.deletePreview.textContent = node.content.replace(/\s+/g, ' ').trim().slice(0, 140) || '（空消息）'
  els.deleteDialog.classList.add('open')
  els.deleteDialog.setAttribute('aria-hidden', 'false')
  requestAnimationFrame(() => els.deleteCancel.focus())
}

function openDeleteChatDialog(chatId) {
  if (controller) return toast('请先停止当前生成')
  const chat = state.chats.find((item) => item.id === chatId)
  if (!chat) return
  closeHistoryMenu()
  pendingDeleteNodeId = null
  pendingDeleteChatId = chatId
  deleteReturnFocus = els.history.querySelector(`[data-history-menu="${chatId}"]`)
  els.deleteTitle.textContent = '删除这个对话？'
  els.deleteDescription.textContent = `将永久删除整个对话及其中 ${Object.keys(chat.nodes).length} 个消息节点。此操作无法撤销。`
  els.deletePreview.textContent = chat.title || '（无标题对话）'
  els.deleteConfirm.textContent = '删除对话'
  els.deleteDialog.classList.add('open')
  els.deleteDialog.setAttribute('aria-hidden', 'false')
  requestAnimationFrame(() => els.deleteCancel.focus())
}

function closeDeleteDialog(restoreFocus = true) {
  els.deleteDialog.classList.remove('open')
  els.deleteDialog.setAttribute('aria-hidden', 'true')
  pendingDeleteNodeId = null
  pendingDeleteChatId = null
  if (restoreFocus && deleteReturnFocus?.isConnected) deleteReturnFocus.focus()
  deleteReturnFocus = null
}

function deleteChat() {
  if (!pendingDeleteChatId || controller) return
  const index = state.chats.findIndex((chat) => chat.id === pendingDeleteChatId)
  if (index < 0) return closeDeleteDialog(false)
  const [removed] = state.chats.splice(index, 1)
  if (!state.chats.length) state.chats.push(blankChat())
  if (state.currentId === removed.id) state.currentId = state.chats[Math.min(index, state.chats.length - 1)].id
  if (renamingChatId === removed.id) renamingChatId = null
  closeDeleteDialog(false)
  save(); render(); toast('对话已删除')
}

function deleteBranch() {
  if (!pendingDeleteNodeId || controller) return
  const chat = current(), node = chat.nodes[pendingDeleteNodeId]
  if (!node) return closeDeleteDialog(false)
  const removedIds = branchNodeIds(chat, node.id)
  const removed = new Set(removedIds)
  const siblings = node.parentId === ROOT ? chat.rootChildren : chat.nodes[node.parentId]?.children
  if (!siblings) return closeDeleteDialog(false)
  const index = siblings.indexOf(node.id)
  if (index >= 0) siblings.splice(index, 1)
  if (siblings.length) chat.selected[node.parentId] = siblings[Math.min(Math.max(index, 0), siblings.length - 1)]
  else delete chat.selected[node.parentId]
  removedIds.forEach((id) => { delete chat.nodes[id]; delete chat.selected[id] })
  Object.keys(chat.selected).forEach((parentId) => { if (removed.has(chat.selected[parentId])) delete chat.selected[parentId] })
  if (removed.has(editingNodeId)) { editingNodeId = null; editingDraft = ''; editingAttachments = [] }
  if (!chat.rootChildren.length) chat.title = '新对话'
  closeDeleteDialog(false)
  save(); render(); toast(`已删除 ${removedIds.length} 个节点`)
}

function confirmDeletion() {
  if (pendingDeleteChatId) return deleteChat()
  deleteBranch()
}

function resizePrompt() { els.prompt.style.height='auto'; els.prompt.style.height=`${Math.min(els.prompt.scrollHeight,180)}px` }
function toast(message) { els.toast.textContent=message; els.toast.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>els.toast.classList.remove('show'),1600) }

function resizeInlineEditor(textarea) {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 112), 320)}px`
}

function beginInlineEdit(nodeId) {
  if (controller) return toast('请先停止当前生成')
  const node = current().nodes[nodeId]
  if (!node || node.role !== 'user') return
  editingNodeId = nodeId
  editingDraft = node.content
  editingAttachments = (node.attachments || []).map((file) => ({ ...file }))
  renderMessages(false)
  renderContextMeter()
  requestAnimationFrame(() => {
    const textarea = els.messages.querySelector(`[data-edit-id="${nodeId}"]`)
    if (!textarea) return
    resizeInlineEditor(textarea)
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    textarea.scrollIntoView({ block: 'nearest' })
  })
}

function cancelInlineEdit() {
  if (!editingNodeId) return
  editingNodeId = null
  editingDraft = ''
  editingAttachments = []
  renderMessages(false)
  renderContextMeter()
}

async function commitInlineEdit(nodeId) {
  if (controller) return toast('请先停止当前生成')
  const node = current().nodes[nodeId]
  const textarea = els.messages.querySelector(`[data-edit-id="${nodeId}"]`)
  if (!node || !textarea) return
  const changed = textarea.value.trim()
  const attachments = editingAttachments.map((file) => ({ ...file }))
  if (!changed && !attachments.length) return toast('消息不能为空')
  const originalAttachments = node.attachments || []
  const attachmentsUnchanged = attachments.length === originalAttachments.length && attachments.every((file, index) => file.id === originalAttachments[index]?.id)
  if (changed === node.content.trim() && attachmentsUnchanged) return cancelInlineEdit()
  const parentId = node.parentId
  editingNodeId = null
  editingDraft = ''
  editingAttachments = []
  await submit(changed, parentId, attachments)
}

function renderPendingAttachments() {
  els.attachmentList.classList.toggle('hidden', pendingAttachments.length === 0)
  els.attachmentList.innerHTML = pendingAttachments.map((file) => attachmentChip(file, 'data-remove-file')).join('')
  renderContextMeter()
}

function renderEditingAttachments() {
  const list = els.messages.querySelector('[data-edit-attachments]')
  if (!list) return
  list.classList.toggle('hidden', editingAttachments.length === 0)
  list.innerHTML = editingAttachments.map((file) => attachmentChip(file, 'data-remove-edit-file')).join('')
  renderContextMeter()
}

async function appendFiles(fileList, target) {
  const files = [...fileList]
  if (!files.length) return 0
  let added = 0
  for (const file of files) {
    if (target.length >= MAX_FILES) { toast(`最多上传 ${MAX_FILES} 个文件`); break }
    const extension = file.name.split('.').pop()?.toLowerCase() || ''
    if (!TEXT_EXTENSIONS.has(extension) && !file.type.startsWith('text/')) { toast(`${file.name} 不是支持的文本文件`); continue }
    if (file.size > MAX_FILE_SIZE) { toast(`${file.name} 超过 300 KB`); continue }
    if (target.reduce((sum, item) => sum + item.size, 0) + file.size > MAX_TOTAL_SIZE) { toast('附件总大小不能超过 750 KB'); break }
    if (target.some((item) => item.name === file.name && item.size === file.size)) { toast(`${file.name} 已添加`); continue }
    try {
      const buffer = await file.arrayBuffer()
      let content
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
      catch { content = new TextDecoder('gb18030').decode(buffer) }
      if (content.includes('\0')) { toast(`${file.name} 似乎是二进制文件`); continue }
      target.push({ id: uid(), name: file.name, type: file.type || 'text/plain', size: file.size, content })
      added += 1
    } catch { toast(`无法读取 ${file.name}`) }
  }
  return added
}

async function addFiles(fileList) {
  const added = await appendFiles(fileList, pendingAttachments)
  renderPendingAttachments()
  if (added) { toast(`已添加 ${added} 个文件`); els.prompt.focus() }
}

async function addEditingFiles(fileList) {
  if (!editingNodeId) return
  const added = await appendFiles(fileList, editingAttachments)
  renderEditingAttachments()
  if (added) {
    toast(`已添加 ${added} 个文件`)
    els.messages.querySelector(`[data-edit-id="${editingNodeId}"]`)?.focus()
  }
}

function exportCurrentBranch(includeUser) {
  const chat = current()
  const nodes = activePath(chat).map((id) => chat.nodes[id]).filter((node) => node.content?.trim())
  const exported = includeUser ? nodes : nodes.filter((node) => node.role === 'assistant')
  if (!exported.length) return toast('当前分支没有可导出的内容')

  let answerNumber = 0
  const sections = exported.map((node) => {
    let heading
    if (includeUser) heading = node.role === 'user' ? '## 用户' : '## 模型'
    else heading = `## 回答 ${++answerNumber}`
    return `${heading}\n\n${node.content.trim()}`
  })
  const title = chat.title.replace(/[\r\n]+/g, ' ').trim() || '对话记录'
  const markdown = `# ${title}\n\n${sections.join('\n\n---\n\n')}\n`
  const blob = new Blob(['\ufeff', markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.md`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast(includeUser ? '已导出完整对话' : '已导出模型输出')
}

els.send.addEventListener('click',()=> controller ? controller.abort() : submit(els.prompt.value))
els.prompt.addEventListener('input',()=>{resizePrompt();renderContextMeter()})
els.prompt.addEventListener('keydown',(e)=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit(els.prompt.value)} })
els.attach.addEventListener('click',()=>els.fileInput.click())
els.fileInput.addEventListener('change',async()=>{await addFiles(els.fileInput.files);els.fileInput.value=''})
els.attachmentList.addEventListener('click',(e)=>{const button=e.target.closest('[data-remove-file]');if(!button)return;pendingAttachments=pendingAttachments.filter((file)=>file.id!==button.dataset.removeFile);renderPendingAttachments();toast('已移除附件')})
els.composer.addEventListener('dragover',(e)=>{e.preventDefault();if(e.dataTransfer?.types.includes('Files'))els.composer.classList.add('dragging')})
els.composer.addEventListener('dragleave',(e)=>{if(!els.composer.contains(e.relatedTarget))els.composer.classList.remove('dragging')})
els.composer.addEventListener('drop',async(e)=>{e.preventDefault();els.composer.classList.remove('dragging');await addFiles(e.dataTransfer.files)})
els.think.addEventListener('click',()=>{state.thinking=!state.thinking;save();render();toast(state.thinking?'已开启深度思考':'已关闭深度思考')})
$('#newChat').addEventListener('click',()=>{const chat=blankChat();state.chats.push(chat);state.currentId=chat.id;save();render();els.prompt.focus()})
document.addEventListener('keydown',(e)=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#newChat').click()}})
$('#treeButton').addEventListener('click',()=>{
  els.shell.classList.toggle('tree-open')
  syncResponsiveLayout()
  if (isCompactLayout() && els.shell.classList.contains('tree-open')) els.sidebar.classList.remove('open')
  syncResponsiveLayout()
})
$('#exportButton').addEventListener('click',(e)=>{e.stopPropagation();const menu=$('#exportMenu');const open=menu.classList.toggle('open');$('#exportButton').setAttribute('aria-expanded',String(open))})
$('#exportMenu').addEventListener('click',(e)=>{const option=e.target.closest('[data-export]');if(!option)return;exportCurrentBranch(option.dataset.export==='all');$('#exportMenu').classList.remove('open');$('#exportButton').setAttribute('aria-expanded','false')})
document.addEventListener('click',(e)=>{if(!e.target.closest('.export-wrap')){$('#exportMenu').classList.remove('open');$('#exportButton').setAttribute('aria-expanded','false')}})
els.modelButton.addEventListener('click',(e)=>{e.stopPropagation();const open=els.modelMenu.classList.toggle('open');els.modelButton.setAttribute('aria-expanded',String(open))})
els.modelMenu.addEventListener('click',(e)=>{const option=e.target.closest('[data-model-id]');if(!option||option.disabled)return;if(controller)return toast('请先停止当前生成');state.modelId=option.dataset.modelId;save();renderModelSelector();els.modelMenu.classList.remove('open');els.modelButton.setAttribute('aria-expanded','false');toast(`已切换到 ${selectedModel().label}`)})
document.addEventListener('click',(e)=>{if(!e.target.closest('.model-select')){els.modelMenu.classList.remove('open');els.modelButton.setAttribute('aria-expanded','false')}})
els.temperatureButton.addEventListener('click',(e)=>{e.stopPropagation();const open=els.temperaturePopover.classList.toggle('open');els.temperatureButton.setAttribute('aria-expanded',String(open));if(open){els.contextPopover.classList.remove('open');els.contextMeter.setAttribute('aria-expanded','false')}})
els.temperatureSlider.addEventListener('input',()=>{const model=selectedModel();if(!model)return;state.temperatures[model.id]=Number(els.temperatureSlider.value);renderTemperatureControl()})
els.temperatureSlider.addEventListener('change',save)
els.temperatureValue.addEventListener('change',()=>{const model=selectedModel();if(!model)return;const maximum=Number(model.temperatureMax)||1;const entered=Number(els.temperatureValue.value);if(!Number.isFinite(entered)){renderTemperatureControl();return toast('请输入有效数字')}state.temperatures[model.id]=Math.round(Math.min(maximum,Math.max(0,entered))*100)/100;save();renderTemperatureControl()})
els.temperatureValue.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();els.temperatureValue.blur()}})
document.addEventListener('click',(e)=>{if(!e.target.closest('.temperature-wrap')){els.temperaturePopover.classList.remove('open');els.temperatureButton.setAttribute('aria-expanded','false')}})
els.contextMeter.addEventListener('click',(e)=>{e.stopPropagation();const open=els.contextPopover.classList.toggle('open');els.contextMeter.setAttribute('aria-expanded',String(open));if(open){els.temperaturePopover.classList.remove('open');els.temperatureButton.setAttribute('aria-expanded','false')}})
document.addEventListener('click',(e)=>{if(!e.target.closest('.context-wrap')){els.contextPopover.classList.remove('open');els.contextMeter.setAttribute('aria-expanded','false')}})
$('#closeTree').addEventListener('click',()=>{els.shell.classList.remove('tree-open');syncResponsiveLayout();applySidebarState()})
els.treeZoomOut.addEventListener('click',()=>setTreeZoom(state.treeZoom-.1))
els.treeZoomIn.addEventListener('click',()=>setTreeZoom(state.treeZoom+.1))
els.treeZoomReset.addEventListener('click',()=>setTreeZoom(1))
els.tree.addEventListener('wheel',(e)=>{if(!(e.ctrlKey||e.metaKey))return;e.preventDefault();setTreeZoom(state.treeZoom+(e.deltaY<0 ? .1 : -.1))},{passive:false})
els.sidebarCollapse.addEventListener('click',collapseSidebar)
els.menuButton.addEventListener('click',openSidebar)
els.overlay.addEventListener('click',()=>{$('#sidebar').classList.remove('open');els.shell.classList.remove('tree-open');syncResponsiveLayout();applySidebarState()})
els.history.addEventListener('click',(e)=>{
  const menu=e.target.closest('[data-history-menu]');if(menu)return openHistoryMenu(menu.dataset.historyMenu,menu)
  if(e.target.closest('[data-rename-cancel]'))return cancelRenameChat()
  const saveButton=e.target.closest('[data-rename-save]');if(saveButton)return commitRenameChat(saveButton.dataset.renameSave)
  const button=e.target.closest('[data-open-chat]');if(!button)return
  renamingChatId=null;state.currentId=button.dataset.openChat;save();render();els.sidebar.classList.remove('open');els.overlay.classList.remove('show')
})
els.history.addEventListener('dblclick',(e)=>{const button=e.target.closest('[data-open-chat]');if(button)beginRenameChat(button.dataset.openChat)})
els.history.addEventListener('keydown',(e)=>{
  if(!e.target.matches('[data-rename-input]'))return
  if(e.key==='Enter'){e.preventDefault();commitRenameChat(e.target.dataset.renameInput)}
  else if(e.key==='Escape'){e.preventDefault();cancelRenameChat()}
})
els.historyMenuRename.addEventListener('click',()=>{if(historyMenuChatId)beginRenameChat(historyMenuChatId)})
els.historyMenuDelete.addEventListener('click',()=>{if(historyMenuChatId)openDeleteChatDialog(historyMenuChatId)})
document.addEventListener('click',(e)=>{if(!e.target.closest('#historyActionMenu')&&!e.target.closest('[data-history-menu]'))closeHistoryMenu()})
els.history.addEventListener('scroll',closeHistoryMenu,{passive:true})
els.tree.addEventListener('click',(e)=>{const node=e.target.closest('[data-tree-id]');if(!node)return;selectNode(current(),node.dataset.treeId,{focus:true});if(isCompactLayout()){els.shell.classList.remove('tree-open');syncResponsiveLayout();applySidebarState()}})
els.messages.addEventListener('click',async(e)=>{
  const target=e.target.closest('button');if(!target)return;const id=target.dataset.id, node=current().nodes[id]
  if(target.classList.contains('inline-edit-attach'))return els.messages.querySelector(`[data-edit-file-input="${id}"]`)?.click()
  if(target.hasAttribute('data-remove-edit-file')){editingAttachments=editingAttachments.filter((file)=>file.id!==target.dataset.removeEditFile);renderEditingAttachments();return}
  if(target.classList.contains('inline-edit-cancel'))return cancelInlineEdit()
  if(target.classList.contains('inline-edit-submit'))return commitInlineEdit(id)
  if(target.classList.contains('delete-branch-action'))return openDeleteDialog(id,target)
  if(target.classList.contains('copy-action')){await navigator.clipboard.writeText(node.content);toast('已复制')}
  if(target.classList.contains('retry-action'))retry(id)
  if(target.classList.contains('branch-prev'))switchSibling(id,-1)
  if(target.classList.contains('branch-next'))switchSibling(id,1)
  if(target.classList.contains('edit-action'))beginInlineEdit(id)
})
els.messages.addEventListener('change',async(e)=>{if(!e.target.matches('[data-edit-file-input]'))return;await addEditingFiles(e.target.files);e.target.value=''})
els.deleteCancel.addEventListener('click',()=>closeDeleteDialog())
els.deleteConfirm.addEventListener('click',confirmDeletion)
els.deleteDialog.addEventListener('click',(e)=>{if(e.target===els.deleteDialog)closeDeleteDialog()})
document.addEventListener('keydown',(e)=>{
  if(e.key==='Escape'&&els.deleteDialog.classList.contains('open')){e.preventDefault();closeDeleteDialog()}
})
els.messages.addEventListener('input',(e)=>{if(!e.target.matches('.inline-edit-text'))return;editingDraft=e.target.value;resizeInlineEditor(e.target);renderContextMeter()})
els.messages.addEventListener('keydown',(e)=>{if(!e.target.matches('.inline-edit-text'))return;if(e.key==='Escape'){e.preventDefault();cancelInlineEdit()}else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();commitInlineEdit(e.target.dataset.editId)}})
document.querySelectorAll('.suggestions button').forEach((button)=>button.addEventListener('click',()=>{els.prompt.value=button.textContent;resizePrompt();els.prompt.focus()}))

fetch('/api/config').then((r)=>r.json()).then((config)=>{models=config.models||[];if(!models.some((item)=>item.id===state.modelId&&item.configured))state.modelId=config.defaultModelId;save();renderModelSelector()}).catch(()=>{els.headerModel.textContent='模型不可用';els.status.textContent='服务状态未知';els.dot.classList.add('bad')})
window.addEventListener('resize',()=>{syncResponsiveLayout();applySidebarState();applyPanelSizes()})
setupPanelResizer(els.sidebarResizer, 'sidebar')
setupPanelResizer(els.treeResizer, 'tree')
applyPanelSizes(); syncResponsiveLayout(); applySidebarState(); render(); initializeDatabase(); els.prompt.focus()
