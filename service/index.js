'use strict'

// com.mangrids.workitem 的 service 后端。
//
// 职责只有一个：确保本机 workitem UI 服务（<repo>/workitems_ui/server.js，默认 4777）在跑。
// - 宿主启动后端时（x-hub 启动且扩展被常驻/随应用启动）立刻探活，没跑就从仓库拉起；
// - 扩展页面每次打开也会调 /api/ensure，双保险；
// - 只监听宿主分配的 127.0.0.1 端口（process.env.PORT），不对外。
//
// 拉起方式与 workitems_ui/start-ui.js 一致（detached + 独立日志），但：
// - 不打开浏览器（设 WORKITEMS_UI_NO_OPEN=1）；
// - 不做 start-ui.js 那种「杀所有 server.js 进程」的重启，避免误伤别的进程；
// - 必须显式覆盖 WORKITEMS_UI_PORT，并清掉宿主注入的 PORT —— server.js 会读 process.env.PORT，
//   不覆盖会让 workitem 抢宿主分配给本后端的端口。

const http = require('http')
const net = require('net')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const HOST = '127.0.0.1'
const PORT = parseInt(process.env.PORT || '0', 10)
const EXT_ID = process.env.XHUB_EXT_ID || 'com.mangrids.workitem'

const EXT_DIR = path.resolve(__dirname, '..')
const DATA_DIR = path.join(EXT_DIR, '.data')
const LOG_DIR = path.join(DATA_DIR, 'logs')
const OUT_LOG = path.join(LOG_DIR, 'workitems-ui.out.log')
const ERR_LOG = path.join(LOG_DIR, 'workitems-ui.err.log')

// workitem 前端的同源副本：宿主只允许扩展页在同源里导航（frame-src 'none'），
// 所以把 <repo>/workitems_ui/public 同步到 <扩展目录>/web，由注入的 shim 把 /api 转走。
const WEB_DIR = path.join(EXT_DIR, 'web')
const SHIM_SRC = path.join(EXT_DIR, 'assets', 'xhub-shim.js')
const SHIM_NAME = 'xhub-shim.js'
const SHIM_MARK = 'data-xhub-workitem-shim'
const ALLVIEW_SRC = path.join(EXT_DIR, 'assets', 'xhub-allview.js')
const ALLVIEW_NAME = 'xhub-allview.js'
const ALLVIEW_MARK = 'data-xhub-allview'

const site = { syncedAt: 0, copied: 0, skipped: 0, bytes: 0, error: '' }

const DEFAULT_REPO = 'D:\\TimeMachine\\sr_workitem'
const DEFAULT_UI_PORT = 4777
const START_TIMEOUT_MS = 90000
const PROBE_TIMEOUT_MS = 1500

function plainPath(p) {
  if (typeof p !== 'string') return ''
  let s = p.trim()
  if (s.startsWith('\\\\?\\UNC\\')) s = '\\\\' + s.slice(8)
  else if (s.startsWith('\\\\?\\')) s = s.slice(4)
  return s
}

function log(...args) {
  console.log(new Date().toISOString(), '[workitem-ext]', ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tail(file, maxBytes = 2400) {
  try {
    const stat = fs.statSync(file)
    const size = Math.min(stat.size, maxBytes)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, stat.size - size)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch (_) {
    return ''
  }
}

function getJson(url, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(null)
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (_) {
          finish(null)
        }
      })
      res.on('error', () => finish(null))
    })
    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })
    req.on('error', () => finish(null))
  })
}

function tcpOpen(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

const state = {
  status: 'idle', // idle | checking | starting | running | error
  repoPath: plainPath(process.env.WORKITEM_REPO_PATH || DEFAULT_REPO),
  uiPort: Number(process.env.WORKITEM_UI_PORT || DEFAULT_UI_PORT) || DEFAULT_UI_PORT,
  url: '',
  pid: null,
  lastError: '',
  lastProbeAt: 0,
  health: null,
  startingSince: 0,
}
state.url = `http://127.0.0.1:${state.uiPort}`

function summarizeHealth(health) {
  if (!health || typeof health !== 'object') return null
  const sync = health.sync && typeof health.sync === 'object' ? health.sync : null
  return {
    ok: health.ok === true,
    serverVersion: health.serverVersion || '',
    repoPath: health.repoPath || '',
    gitEnabled: health.gitEnabled === true,
    autoSyncEnabled: health.autoSyncEnabled === true,
    gitOk: !health.gitAvailability || health.gitAvailability.ok !== false,
    gitReason: (health.gitAvailability && health.gitAvailability.reason) || '',
    syncAt: (sync && sync.at) || '',
    syncOk: sync ? sync.ok === true : null,
    syncSkipped: sync ? sync.skipped === true : null,
    syncReason: (sync && sync.reason) || '',
  }
}

function resolveRepo(raw) {
  const input = plainPath(raw || state.repoPath || DEFAULT_REPO)
  const abs = path.resolve(input)
  const entry = path.join(abs, 'workitems_ui', 'server.js')
  if (!fs.existsSync(entry)) {
    throw new Error(`仓库路径无效：找不到 ${entry}`)
  }
  return abs
}

// ---------- 同源副本同步 ----------

// 同步清单放在 .data（宿主的打包与热重载都跳过点目录）：
// 只有源文件真的变了才写 web/，避免「写入 → 宿主热重载 → 再同步」的循环。
const MANIFEST_PATH = path.join(DATA_DIR, 'site-manifest.json')

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) || {}
  } catch (_) {
    return {}
  }
}

function writeManifest(manifest) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest))
  } catch (_) {
    /* 清单写不进去只是多拷一次，不致命 */
  }
}

function writeIfChanged(filePath, content) {
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) return false
  } catch (_) {
    /* 目标不存在按需要写 */
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return true
}

function copyTree(srcDir, dstDir, manifest, relBase) {
  fs.mkdirSync(dstDir, { recursive: true })
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  const keep = new Set()
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name)
    const dst = path.join(dstDir, entry.name)
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    keep.add(entry.name)
    if (entry.isDirectory()) {
      copyTree(src, dst, manifest, rel)
      continue
    }
    if (!entry.isFile()) continue
    if (rel === 'index.html') continue // index.html 由 injectShim 统一生成
    const stat = fs.statSync(src)
    site.bytes += stat.size
    const prev = manifest[rel]
    if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs && fs.existsSync(dst)) {
      site.skipped += 1
      continue
    }
    fs.copyFileSync(src, dst)
    manifest[rel] = { size: stat.size, mtimeMs: stat.mtimeMs }
    site.copied += 1
  }
  // 清理上游已删除的文件
  for (const name of fs.readdirSync(dstDir)) {
    if (keep.has(name)) continue
    if (name === SHIM_NAME || name === ALLVIEW_NAME) continue
    const stale = path.join(dstDir, name)
    try {
      fs.rmSync(stale, { recursive: true, force: true })
    } catch (_) {
      /* 删不掉就算了 */
    }
  }
}

function buildIndexHtml(sourceIndex) {
  let html = fs.readFileSync(sourceIndex, 'utf8')
  if (!html.includes(SHIM_MARK)) {
    const tag = `<script src="./${SHIM_NAME}" ${SHIM_MARK}></script>`
    const marker = /<script\s+src="\.\/app\.js/i
    if (marker.test(html)) html = html.replace(marker, `${tag}\n  <script src="./app.js`)
    else html = html.replace('</head>', `${tag}\n</head>`)
  }
  if (!html.includes(ALLVIEW_MARK)) {
    const allTag = `<script src="./${ALLVIEW_NAME}" ${ALLVIEW_MARK}></script>`
    if (html.includes('</body>')) html = html.replace('</body>', `${allTag}\n</body>`)
    else html += `\n${allTag}`
  }
  return html
}

function syncSite() {
  const repo = resolveRepo(state.repoPath)
  const srcDir = path.join(repo, 'workitems_ui', 'public')
  const sourceIndex = path.join(srcDir, 'index.html')
  if (!fs.existsSync(sourceIndex)) {
    throw new Error(`找不到 workitem 前端目录：${srcDir}`)
  }
  site.copied = 0
  site.skipped = 0
  site.bytes = 0
  fs.mkdirSync(WEB_DIR, { recursive: true })

  const manifest = readManifest()
  copyTree(srcDir, WEB_DIR, manifest, '')
  writeManifest(manifest)

  if (!fs.existsSync(SHIM_SRC)) throw new Error(`缺少 shim：${SHIM_SRC}`)
  if (!fs.existsSync(ALLVIEW_SRC)) throw new Error(`缺少全部视图脚本：${ALLVIEW_SRC}`)
  if (writeIfChanged(path.join(WEB_DIR, SHIM_NAME), fs.readFileSync(SHIM_SRC, 'utf8'))) site.copied += 1
  else site.skipped += 1
  if (writeIfChanged(path.join(WEB_DIR, ALLVIEW_NAME), fs.readFileSync(ALLVIEW_SRC, 'utf8'))) site.copied += 1
  else site.skipped += 1
  if (writeIfChanged(path.join(WEB_DIR, 'index.html'), buildIndexHtml(sourceIndex))) site.copied += 1
  else site.skipped += 1

  site.syncedAt = Date.now()
  site.error = ''
  return { ok: true, copied: site.copied, skipped: site.skipped, bytes: site.bytes, syncedAt: site.syncedAt }
}
// ---------- 反代 workitem 的 /api 与 /attachments ----------

function proxyToWorkitem(targetPath, payload) {
  return new Promise((resolve) => {
    let bodyBuf = null
    if (payload.bodyBase64) bodyBuf = Buffer.from(String(payload.bodyBase64), 'base64')
    else if (payload.body != null) bodyBuf = Buffer.from(String(payload.body), 'utf8')

    const headers = {}
    const inbound = payload.headers && typeof payload.headers === 'object' ? payload.headers : {}
    Object.keys(inbound).forEach((key) => {
      const lower = key.toLowerCase()
      if (lower === 'host' || lower === 'connection' || lower === 'content-length' || lower === 'accept-encoding') return
      headers[key] = inbound[key]
    })
    if (bodyBuf) headers['Content-Length'] = String(bodyBuf.length)

    const req = http.request(
      {
        host: '127.0.0.1',
        port: state.uiPort,
        path: targetPath,
        method: String(payload.method || 'GET').toUpperCase(),
        headers,
        timeout: 60000,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const contentType = String(res.headers['content-type'] || 'application/octet-stream')
          const isText = /^(application\/(json|javascript|xml|x-ndjson)|text\/|image\/svg)/i.test(contentType)
          resolve({
            status: res.statusCode || 500,
            headers: {
              'content-type': contentType,
              'content-disposition': String(res.headers['content-disposition'] || ''),
            },
            encoding: isText ? 'utf8' : 'base64',
            body: isText ? buf.toString('utf8') : buf.toString('base64'),
            bytes: buf.length,
          })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ error: 'workitem 服务响应超时' })
    })
    req.on('error', (err) => resolve({ error: `连不上 workitem 服务：${err.message}` }))
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}

function snapshot() {
  return {
    status: state.status,
    url: state.url,
    repoPath: state.repoPath,
    uiPort: state.uiPort,
    pid: state.pid,
    health: state.health,
    lastError: state.lastError,
    lastProbeAt: state.lastProbeAt,
    startedAt: state.startingSince,
    extId: EXT_ID,
    node: process.version,
    logs: { out: OUT_LOG, err: ERR_LOG },
    site: {
      dir: WEB_DIR,
      exists: fs.existsSync(path.join(WEB_DIR, 'index.html')),
      syncedAt: site.syncedAt,
      copied: site.copied,
      skipped: site.skipped,
      bytes: site.bytes,
      error: site.error,
    },
  }
}

let inflight = null
let inflightTarget = ''

// 只探活、不改状态机：供 /api/status 在轮询时刷新健康信息。
async function refreshProbe() {
  if (state.status === 'starting') return
  const health = await getJson(`${state.url}/api/health`)
  state.lastProbeAt = Date.now()
  if (health && health.ok === true) {
    state.status = 'running'
    state.health = summarizeHealth(health)
    state.lastError = ''
    return
  }
  if (state.status === 'running') {
    state.status = 'idle'
    state.health = null
  }
}

function ensure(options = {}) {
  if (options.repoPath) {
    try {
      state.repoPath = resolveRepo(options.repoPath)
    } catch (err) {
      state.status = 'error'
      state.lastError = err.message
      return Promise.resolve(snapshot())
    }
  }
  if (options.uiPort !== undefined && options.uiPort !== null && options.uiPort !== '') {
    const next = Number(options.uiPort)
    if (Number.isInteger(next) && next > 0 && next < 65536) {
      state.uiPort = next
      state.url = `http://127.0.0.1:${next}`
    }
  }
  if (inflight) {
    if (inflightTarget === `${state.repoPath}|${state.uiPort}`) return inflight
    // 参数变了（比如刚保存了新的仓库路径/端口）：等这一轮结束再按新参数补一次
    return inflight.then(() => ensure({}))
  }
  inflightTarget = `${state.repoPath}|${state.uiPort}`
  inflight = doEnsure().finally(() => {
    inflight = null
  })
  return inflight
}

async function doEnsure() {
  if (state.status !== 'starting') state.status = 'checking'
  const health = await getJson(`${state.url}/api/health`)
  state.lastProbeAt = Date.now()
  if (health && health.ok === true) {
    state.status = 'running'
    state.health = summarizeHealth(health)
    state.lastError = ''
    return snapshot()
  }
  if (await tcpOpen(state.uiPort)) {
    state.status = 'error'
    state.health = null
    state.lastError = `端口 ${state.uiPort} 已被其它进程占用，但它不是可用的 workitem 服务（/api/health 不通）`
    return snapshot()
  }
  return startUiServer()
}

async function startUiServer() {
  let repo
  try {
    repo = resolveRepo(state.repoPath)
  } catch (err) {
    state.status = 'error'
    state.lastError = err.message
    return snapshot()
  }

  const cwd = path.join(repo, 'workitems_ui')
  const depsDir = path.join(repo, 'manager_agent', 'node_modules')
  if (!fs.existsSync(depsDir)) {
    state.status = 'error'
    state.lastError = `manager_agent 依赖未安装（缺少 ${depsDir}），请先在仓库根执行 npm install`
    return snapshot()
  }

  state.status = 'starting'
  state.startingSince = Date.now()
  state.lastError = ''
  state.pid = null

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  } catch (_) {
    /* 日志目录建不出来也继续，交给 spawn 报错 */
  }

  let outFd = null
  let errFd = null
  try {
    outFd = fs.openSync(OUT_LOG, 'a')
    errFd = fs.openSync(ERR_LOG, 'a')
    fs.writeSync(outFd, `\n----- ${new Date().toISOString()} 由 x-hub 扩展 ${EXT_ID} 拉起 -----\n`)
  } catch (err) {
    state.status = 'error'
    state.lastError = `无法写日志文件：${err.message}`
    return snapshot()
  }

  // server.js 读 process.env.PORT，必须先删掉宿主注入的 PORT，再显式给 WORKITEMS_UI_PORT。
  const env = {
    ...process.env,
    WORKITEMS_REPO_PATH: repo,
    WORKITEMS_UI_PORT: String(state.uiPort),
    WORKITEMS_UI_NO_OPEN: '1',
  }
  delete env.PORT
  delete env.XHUB_LISTEN_HOST
  delete env.WORKITEMS_UI_NO_GIT
  delete env.WORKITEMS_UI_NO_SYNC

  let child
  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    })
  } catch (err) {
    state.status = 'error'
    state.lastError = `拉起 workitem 服务失败：${err.message}`
    return snapshot()
  }

  let exitInfo = null
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal }
  })
  child.once('error', (err) => {
    exitInfo = { error: err.message }
  })
  child.unref()

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const health = await getJson(`${state.url}/api/health`)
    if (health && health.ok === true) {
      state.status = 'running'
      state.health = summarizeHealth(health)
      state.pid = child.pid || null
      state.lastError = ''
      log('workitem 服务已就绪', state.url, 'pid=', state.pid)
      return snapshot()
    }
    if (exitInfo) break
    await sleep(500)
  }

  state.status = 'error'
  state.health = null
  if (exitInfo) {
    const reason = exitInfo.error || `退出码 ${exitInfo.code}${exitInfo.signal ? ` (${exitInfo.signal})` : ''}`
    const detail = tail(ERR_LOG, 1200).trim()
    state.lastError = `workitem 服务启动失败（${reason}）${detail ? `\n${detail}` : ''}`
  } else {
    const detail = tail(ERR_LOG, 1200).trim()
    state.lastError = `workitem 服务在 ${Math.round(START_TIMEOUT_MS / 1000)}s 内未就绪${detail ? `\n${detail}` : ''}`
  }
  log('workitem 服务启动失败', state.lastError)
  return snapshot()
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let body = ''
    let overflow = false
    req.on('data', (chunk) => {
      if (overflow) return
      body += chunk
      if (body.length > limit) {
        overflow = true
        body = body.slice(0, limit)
      }
    })
    req.on('end', () => resolve({ body, overflow }))
    req.on('error', () => resolve({ body, overflow }))
  })
}

function sendJson(res, statusCode, payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`)
  const pathname = url.pathname

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true, workitem: state.status, extId: EXT_ID })
    return
  }

  if (pathname === '/api/status') {
    // 轻量探活后返回快照：页面在启动过程中每 ~900ms 轮询一次，靠它推进状态。
    await refreshProbe()
    sendJson(res, 200, snapshot())
    return
  }

  if (pathname === '/api/ensure' && (req.method === 'POST' || req.method === 'GET')) {
    let options = {}
    if (req.method === 'POST') {
      const { body } = await readBody(req)
      try {
        const parsed = body ? JSON.parse(body) : {}
        if (parsed && typeof parsed === 'object') options = parsed
      } catch (_) {
        /* 非法 body 按空参数处理 */
      }
    }
    if (state.status !== 'starting') state.status = 'checking'
    state.lastError = ''
    // 不阻塞请求：拉起 workitem 可能要十几秒，页面改用 /api/status 轮询，避免代理超时。
    ensure(options).catch((err) => log('ensure 异常：', err && err.message))
    sendJson(res, 200, { ...snapshot(), accepted: true })
    return
  }

  if (pathname === '/api/logs') {
    sendJson(res, 200, {
      out: tail(OUT_LOG, 4000),
      err: tail(ERR_LOG, 4000),
      paths: { out: OUT_LOG, err: ERR_LOG },
    })
    return
  }

  if (pathname === '/api/sync' && (req.method === 'POST' || req.method === 'GET')) {
    if (req.method === 'POST') {
      const { body } = await readBody(req)
      try {
        const parsed = body ? JSON.parse(body) : {}
        if (parsed && typeof parsed === 'object' && parsed.repoPath) state.repoPath = resolveRepo(parsed.repoPath)
      } catch (err) {
        sendJson(res, 200, { ok: false, error: err.message })
        return
      }
    }
    try {
      const result = syncSite()
      log('同源副本已同步：', `copied=${result.copied}`, `skipped=${result.skipped}`, `bytes=${result.bytes}`)
      sendJson(res, 200, { ...result, site: snapshot().site })
    } catch (err) {
      site.error = err.message
      log('同源副本同步失败：', err.message)
      sendJson(res, 200, { ok: false, error: err.message, site: snapshot().site })
    }
    return
  }

  if (pathname === '/api/proxy' && req.method === 'POST') {
    const { body, overflow } = await readBody(req, 48 * 1024 * 1024)
    if (overflow) {
      sendJson(res, 200, { error: '请求体过大' })
      return
    }
    let payload = {}
    try {
      payload = body ? JSON.parse(body) : {}
    } catch (_) {
      sendJson(res, 200, { error: '请求体不是合法 JSON' })
      return
    }
    const targetPath = String(payload.path || '')
    if (!/^\/(api|attachments)\//.test(targetPath)) {
      sendJson(res, 200, { error: '只允许代理 /api/ 与 /attachments/' })
      return
    }
    const result = await proxyToWorkitem(targetPath, payload)
    sendJson(res, 200, result)
    return
  }

  sendJson(res, 404, { error: 'NOT_FOUND', path: pathname })
})

server.listen(PORT, HOST, () => {
  const actual = server.address().port
  log(`listening on http://${HOST}:${actual}`, 'repo=', state.repoPath)
  // 后端一启动就确保 workitem 服务在跑：x-hub 启动时宿主会拉起 service 后端，就等于自动拉起 workitem。
  ensure({ repoPath: state.repoPath, uiPort: state.uiPort })
    .then((snap) => {
      log('启动探活结果：', snap.status, snap.lastError || '')
      try {
        const result = syncSite()
        log('启动同步同源副本：', `copied=${result.copied}`, `skipped=${result.skipped}`, `bytes=${result.bytes}`)
      } catch (err) {
        site.error = err.message
        log('启动同步同源副本失败：', err.message)
      }
    })
    .catch((err) => log('启动探活异常：', err && err.message))
})

process.on('SIGTERM', () => {
  // workitem 服务是 detached 的独立进程，不随本后端退出而退出（用户下次开 x-hub 直接复用）。
  server.close(() => process.exit(0))
})
