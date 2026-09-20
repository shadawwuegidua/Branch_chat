import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const oldPath = path.join(root, 'glm5.2apikey.txt')
const envPath = path.join(root, '.env')

if (!fs.existsSync(oldPath)) {
  console.log('未发现旧的 glm5.2apikey.txt，无需迁移。')
  process.exit(0)
}
if (fs.existsSync(envPath)) {
  console.error('.env 已存在，为避免覆盖已停止迁移。')
  process.exit(1)
}

const key = fs.readFileSync(oldPath, 'utf8').trim()
if (!key) {
  console.error('旧密钥文件为空。')
  process.exit(1)
}

fs.writeFileSync(
  envPath,
  `GLM_API_KEY=${key}\nGLM_API_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions\nGLM_MODEL=glm-5.2\nPORT=8787\n`,
  { encoding: 'utf8', mode: 0o600, flag: 'wx' },
)
fs.rmSync(oldPath)
console.log('密钥已迁移到 .env，旧 txt 文件已删除。')
