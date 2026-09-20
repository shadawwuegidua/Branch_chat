# 枝语 Branch Chat

一个轻量的多模型网页聊天客户端。前端使用原生 HTML/CSS/JavaScript，Node.js 服务端负责安全地转发 API 请求。

## 功能

- 在顶部切换 GLM-5.2、DeepSeek V4 Flash 和 DeepSeek V4 Pro
- GLM 与 DeepSeek 流式输出
- 上传文本、Markdown、代码、JSON、CSV 等文件，让模型结合附件内容回答
- 编辑历史消息时可添加、保留或移除附件，并从该处创建新分支
- 完整渲染 GFM Markdown，并对模型生成的 HTML 做安全清洗
- 显示当前分支的上下文窗口估算用量和剩余容量
- 可拖动调整历史记录栏和分支面板宽度，并自动保存尺寸
- 支持按钮或 Ctrl/⌘ + 滚轮缩放分支树状图
- 可按模型范围以 0.01 精度调节或直接输入 Temperature
- 深度思考开关，以及思考过程折叠展示
- 完整对话树和当前路径高亮
- 点击树节点或消息旁的左右按钮切换分支
- 编辑旧问题、重新生成回答时保留原分支
- 可删除任意消息节点及其全部后续分支，并在删除前确认
- 将当前分支导出为 Markdown，可选仅模型输出或完整对话
- 对话与分支自动保存在项目目录的本地 SQLite 数据库
- 可在历史记录栏中修改标题或删除整个对话
- 桌面端和移动端自适应界面

## 启动

需要 Node.js 22.5 或更高版本（本地数据库使用 Node 内置 SQLite）。

```bash
npm install
npm run dev
```

然后访问 <http://localhost:8787>。

## 配置

服务端从项目根目录的 `.env` 读取配置：

```env
GLM_API_KEY=你的密钥
GLM_API_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions
GLM_MODEL=glm-5.2
DEEPSEEK_API_KEY=你的DeepSeek密钥
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash
DEEPSEEK_PRO_MODEL=deepseek-v4-pro
GLM_CONTEXT_WINDOW=1000000
DEEPSEEK_CONTEXT_WINDOW=1000000
GLM_MAX_TOKENS=65536
GLM_TIMEOUT_MS=600000
DEEPSEEK_MAX_TOKENS=393216
DEEPSEEK_TIMEOUT_MS=1800000
PORT=8787
```

`.env` 已被 `.gitignore` 排除，不会被 Git 提交，也不会通过网页服务器公开。只配置其中一个服务的 Key 也可以使用；对应的未配置模型会在选择菜单中禁用。不要把 API Key 写入前端 JavaScript。

## 本地数据库

对话数据保存在 `data/branch-chat.sqlite`。首次升级后打开 `http://localhost:8787` 时，网页会自动把该地址下 `branch-chat-v1` 的 LocalStorage 对话迁移到 SQLite；只有数据库写入成功后才会移除原 LocalStorage 数据。服务默认只监听 `127.0.0.1`，数据库暂时只服务当前本机实例，不包含账号或多用户隔离。

附件在浏览器中读取并作为文本加入模型上下文，不会作为文件写入服务器。最多同时上传 5 个文件，单个文件不超过 300 KB，总大小不超过 750 KB。目前不支持 PDF、Word、图片等二进制附件。

如果仍有旧的 `glm5.2apikey.txt`，可以运行 `npm run migrate-key` 自动迁移；脚本会在成功创建 `.env` 后删除旧文件。

## 分支逻辑

每条消息是树中的一个节点。修改历史问题或重新生成回答会在原节点旁创建兄弟节点；旧内容不会被覆盖。右上角的分支按钮可打开整棵对话树，点击任意节点会沿该节点恢复对应路径，并继续显示该分支下最后选中的后续对话。
