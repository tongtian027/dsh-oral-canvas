/**
 * dsh-oral-canvas — host half.
 *
 * Owns everything the canvas cannot do in a browser:
 *   - project documents (JSON on disk) and media files,
 *   - the model registry (OpenAI-compatible text / TTS / ASR, command and HTTP
 *     video providers, ffmpeg settings),
 *   - generation jobs (LLM script, TTS audio, SRT alignment/ASR, video
 *     providers, motion params),
 *   - final composition with ffmpeg (per-sentence clips → concat → audio → burn
 *     subtitles).
 *
 * Routes are all below /oral-canvas so one prefix registration is enough.
 */
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, stat, unlink, rm, copyFile, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const inject = ['webServer']

const ROOT = '/oral-canvas'
const KNOWN_KINDS = new Set(['text', 'tts', 'asr', 'video', 'motion'])
const MEDIA_KINDS = new Set(['video', 'audio', 'image', 'srt', 'file'])

const DEFAULTS = {
  text: { name: '文本模型（OpenAI 兼容）', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  tts: { name: '语音合成 TTS', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' },
  asr: { name: '语音识别 Whisper', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  video: { name: '数字人视频（命令）', provider: 'command', command: '' },
  motion: { name: '动效参数生成', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`
}

function nowISO() {
  return new Date().toISOString()
}

function clamp(n, min, max) {
  const v = Number(n)
  if (!Number.isFinite(v)) return min
  return Math.min(max, Math.max(min, v))
}

function secondsToSrt(t) {
  const v = Math.max(0, Number(t) || 0)
  const h = Math.floor(v / 3600)
  const m = Math.floor((v % 3600) / 60)
  const s = Math.floor(v % 60)
  const ms = Math.round((v - Math.floor(v)) * 1000)
  const p = (n, l = 2) => String(n).padStart(l, '0')
  return `${p(h)}:${p(m)}:${p(s)},${String(ms).padStart(3, '0')}`
}

function srtToSeconds(text) {
  const m = String(text).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
}

function parseSrtText(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = text.split(/\n{2,}/)
  const cues = []
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) continue
    let idx = null
    let timeLine = null
    let at = 0
    if (/^\d+$/.test(lines[0])) {
      idx = Number(lines[0])
      at = 1
    }
    for (let i = at; i < lines.length; i++) {
      if (lines[i].includes('-->')) { timeLine = lines[i]; at = i + 1; break }
    }
    if (!timeLine) continue
    const m = timeLine.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/)
    if (!m) continue
    const start = srtToSeconds(m[1])
    const end = srtToSeconds(m[2])
    if (start == null || end == null) continue
    const body = lines.slice(at).join(' ').replace(/<[^>]+>/g, '').trim()
    cues.push({ index: cues.length + 1, start, end: Math.max(end, start + 0.2), text: body })
  }
  return cues
}

function formatSrtText(cues) {
  return cues.map((c, i) => `${i + 1}\n${secondsToSrt(c.start)} --> ${secondsToSrt(c.end)}\n${String(c.text || '').replace(/\n/g, ' ')}\n`).join('\n')
}

function assTime(sec) {
  const s = Math.max(0, Number(sec) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = (s % 60).toFixed(2).padStart(5, '0')
  return `${h}:${String(m).padStart(2, '0')}:${rest}`
}

// Burn-in uses a real ASS header so libass sizes text in video pixels (PlayRes = frame size)
// instead of the 384x288 default that makes SRT-derived styles wildly oversized.
function formatAssText(cues, W, H, options = {}) {
  const fontSize = Number(options.fontSize) || Math.round(Math.min(W, H) * 0.052)
  const marginV = Number(options.marginV) || Math.round(H * 0.094)
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Microsoft YaHei,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(fontSize / 22))},0,2,${Math.round(W * 0.055)},${Math.round(W * 0.055)},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const events = cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${String(c.text || '').replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '')}`)
  return head.concat(events).join('\n') + '\n'
}

function splitSentences(text) {
  const normalized = String(text || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const parts = normalized.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || []
  const out = []
  for (const raw of parts) {
    const s = raw.trim()
    if (!s) continue
    if (s.length > 60) {
      // Very long sentence: cut at commas so a shot never covers a paragraph.
      const pieces = s.split(/(?<=[，,、])/)
      let buf = ''
      for (const piece of pieces) {
        if ((buf + piece).length > 40 && buf) { out.push(buf.trim()); buf = piece }
        else buf += piece
      }
      if (buf.trim()) out.push(buf.trim())
    } else out.push(s)
  }
  return out
}

function sanitizeName(name, fallback = 'file') {
  const base = String(name || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120).trim()
  return base || fallback
}

function extOf(name, mime) {
  const ext = path.extname(name || '').toLowerCase()
  if (ext) return ext
  const map = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a', 'image/png': '.png', 'image/jpeg': '.jpg' }
  return map[mime] || ''
}

function kindOfMime(mime, name) {
  const m = String(mime || '').toLowerCase()
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('image/')) return 'image'
  if (/\.srt$/i.test(name || '')) return 'srt'
  return 'file'
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file, data) {
  const body = JSON.stringify(data, null, 2)
  const tmp = `${file}.${crypto.randomBytes(3).toString('hex')}.tmp`
  await writeFile(tmp, body, 'utf8')
  try { await rename(tmp, file) } catch {
    await writeFile(file, body, 'utf8')
    await unlink(tmp).catch(() => {})
  }
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  })
  res.end(body)
}

function sendText(res, status, text) {
  const body = Buffer.from(String(text), 'utf8')
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length })
  res.end(body)
}

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase()
  return ({
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.srt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  })[ext] || 'application/octet-stream'
}

function maskKey(key) {
  const k = String(key || '')
  if (!k) return ''
  if (k.length <= 8) return '••••'
  return `${k.slice(0, 3)}…${k.slice(-4)}`
}

export function apply(ctx, config = {}) {
  const web = ctx.webServer || ctx.get('webServer')
  if (!web) return

  const dataDir = config.dataDir ? path.resolve(String(config.dataDir)) : path.join(os.homedir(), '.dsh', 'oral-canvas')
  const projectsDir = path.join(dataDir, 'projects')
  const filesDir = path.join(dataDir, 'files')
  const tmpDir = path.join(dataDir, 'tmp')
  const modelsFile = path.join(dataDir, 'models.json')

  const ensureDirs = (async () => {
    await mkdir(projectsDir, { recursive: true })
    await mkdir(filesDir, { recursive: true })
    await mkdir(tmpDir, { recursive: true })
  })()

  const projectLocks = new Map()
  function withLock(id, fn) {
    const prev = projectLocks.get(id) || Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {})
    projectLocks.set(id, tail)
    tail.then(() => { if (projectLocks.get(id) === tail) projectLocks.delete(id) })
    return run
  }

  // ---------------------------------------------------------------- projects
  function blankProject(name) {
    const id = uid('proj')
    const ts = nowISO()
    return {
      id,
      name: String(name || '未命名口播项目').slice(0, 80),
      createdAt: ts,
      updatedAt: ts,
      script: { text: '', sentences: [] },
      srt: { raw: '', cues: [] },
      nodes: [
        {
          id: uid('n'), kind: 'script', title: '口播稿', sentenceIndex: null,
          x: 120, y: 140, w: 320, h: 220, status: 'idle', modelId: null,
          params: {}, assets: [], log: '', error: null, createdAt: ts, updatedAt: ts,
        },
      ],
      edges: [],
      view: { x: 0, y: 0, zoom: 0.9 },
      settings: {
        size: '1080x1920', fps: 30, burnSubtitles: true,
        materialPriority: ['dhvideo', 'motion', 'screen'],
      },
    }
  }

  function projectPath(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) throw new Error('项目 id 非法')
    return path.join(projectsDir, `${id}.json`)
  }

  async function readProject(id) {
    const p = projectPath(id)
    const doc = await readJson(p, null)
    if (!doc) throw new Error('项目不存在')
    return doc
  }

  async function saveProject(doc) {
    doc.updatedAt = nowISO()
    const file = projectPath(doc.id)
    await writeJsonAtomic(file, doc)
    return doc
  }

  async function listProjects() {
    const files = await readdir(projectsDir).catch(() => [])
    const out = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const doc = await readJson(path.join(projectsDir, f), null)
      if (!doc || !doc.id) continue
      const final = (doc.nodes || []).find((n) => n.kind === 'compose' && (n.assets || []).length)
      out.push({ id: doc.id, name: doc.name, updatedAt: doc.updatedAt, nodes: (doc.nodes || []).length, hasFinal: Boolean(final) })
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return out
  }

  // ------------------------------------------------------------------ models
  async function readModels() {
    const doc = await readJson(modelsFile, null)
    if (!doc || !Array.isArray(doc.models)) {
      // First run: seed one disabled-until-filled entry per capability so the
      // model panel opens on something instead of an empty list.
      const models = Object.entries(DEFAULTS).map(([kind, d]) => ({
        id: `m_${kind}`, kind, enabled: true, apiKey: '', command: d.command || '', statusUrl: '', voice: d.voice || '', ...d,
      }))
      const defaults = {}
      for (const m of models) if (!defaults[m.kind]) defaults[m.kind] = m.id
      const seed = { models, defaults }
      await writeModels(seed).catch(() => {})
      return seed
    }
    const base = doc
    base.defaults = base.defaults && typeof base.defaults === 'object' ? base.defaults : {}
    return base
  }

  async function writeModels(doc) {
    await ensureDirs
    await writeJsonAtomic(modelsFile, doc)
  }

  function publicModels(doc) {
    return {
      models: (doc.models || []).map((m) => ({ ...m, apiKey: maskKey(m.apiKey) })),
      defaults: doc.defaults || {},
    }
  }

  function resolveModel(doc, kind, id) {
    const models = (doc.models || []).filter((m) => m && m.enabled !== false)
    if (id) {
      const hit = models.find((m) => m.id === id)
      if (hit) return hit
    }
    const def = doc.defaults?.[kind]
    if (def) {
      const hit = models.find((m) => m.id === def)
      if (hit) return hit
    }
    return models.find((m) => m.kind === kind) || null
  }

  // --------------------------------------------------------------- ffmpeg
  let ffCache = null
  async function canExec(file, args) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(file, args, { windowsHide: true, stdio: 'ignore' })
      } catch {
        resolve(false)
        return
      }
      const timer = setTimeout(() => { try { child.kill() } catch {} ; resolve(false) }, 4000)
      child.on('error', () => { clearTimeout(timer); resolve(false) })
      child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
    })
  }

  async function resolveFF() {
    if (ffCache) return ffCache
    const configured = config.ffmpeg ? String(config.ffmpeg) : ''
    const candidates = [
      configured,
      process.env.FFMPEG_PATH || '',
      'ffmpeg',
      'D:\\ffmpeg-8.0.1-full_build\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe',
    ].filter(Boolean)
    for (const ff of candidates) {
      if (ff !== 'ffmpeg' && !existsSync(ff)) continue
      if (await canExec(ff, ['-version'])) {
        const ffprobe = ff === 'ffmpeg'
          ? 'ffprobe'
          : path.join(path.dirname(ff), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
        const okProbe = await canExec(ffprobe, ['-version'])
        ffCache = { ffmpeg: ff, ffprobe: okProbe ? ffprobe : null }
        return ffCache
      }
    }
    throw new Error('未找到 ffmpeg：请在模型配置里填写 ffmpeg 路径，或安装 ffmpeg 到 PATH。')
  }

  function runProcess(file, args, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn(file, args, { windowsHide: true, ...(opts.shell ? { shell: true } : {}) })
      let stdout = ''
      let stderr = ''
      let lineBuf = ''
      let killed = false
      const timer = opts.timeoutMs ? setTimeout(() => { killed = true; try { child.kill('SIGKILL') } catch {} }, opts.timeoutMs) : null
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => {
        const text = d.toString()
        stderr += text
        if (stderr.length > 120000) stderr = stderr.slice(-60000)
        if (opts.onStderr) {
          lineBuf += text
          const lines = lineBuf.split(/\r?\n/)
          lineBuf = lines.pop() || ''
          for (const line of lines) opts.onStderr(line)
        }
      })
      child.on('error', (err) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(err?.message || err), killed }) })
      child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, killed }) })
    })
  }

  async function probeDuration(file) {
    try {
      const { ffprobe } = await resolveFF()
      if (!ffprobe) return null
      const r = await runProcess(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 30000 })
      if (r.code !== 0) return null
      const info = JSON.parse(r.stdout || '{}')
      const d = Number(info?.format?.duration)
      if (Number.isFinite(d) && d > 0) return d
      const sd = (info.streams || []).map((s) => Number(s.duration)).find((n) => Number.isFinite(n) && n > 0)
      return Number.isFinite(sd) ? sd : null
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------------- jobs
  const jobs = new Map()
  function runJob(projectId, nodeId, label, work) {
    const job = {
      id: uid('job'), projectId, nodeId, label, status: 'running',
      progress: 0, message: '开始…', error: null, result: null,
      startedAt: nowISO(), finishedAt: null,
    }
    jobs.set(job.id, job)
    const report = (progress, message) => {
      job.progress = clamp(progress, 0, 100)
      if (message) job.message = String(message)
    }
    ;(async () => {
      try {
        const result = await work(report)
        job.result = result || null
        job.status = 'done'
        job.progress = 100
        job.message = '完成'
      } catch (err) {
        job.status = 'error'
        job.error = String(err?.message || err)
        job.message = job.error
      } finally {
        job.finishedAt = nowISO()
        if (jobs.size > 80) {
          const old = [...jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(0, jobs.size - 60)
          for (const j of old) jobs.delete(j.id)
        }
      }
    })()
    return job
  }

  // -------------------------------------------------------------------- HTTP
  function assetUrl(rel) {
    return `${ROOT}/files/${String(rel).split('/').map(encodeURIComponent).join('/')}`
  }

  async function makeAsset(rel, name, mime, extra = {}) {
    const { duration: hintDuration, ...rest } = extra
    const abs = path.join(filesDir, rel)
    let size = null
    try { size = (await stat(abs)).size } catch {}
    const kind = rest.kind || kindOfMime(mime, name)
    let duration = hintDuration
    if ((duration == null) && (kind === 'video' || kind === 'audio')) duration = await probeDuration(abs)
    return {
      id: uid('asset'), name: sanitizeName(name), kind, mime: mime || mimeOf(abs),
      size,
      duration: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
      rel, url: assetUrl(rel), createdAt: nowISO(), ...rest,
    }
  }

  async function saveBufferToFiles(projectId, name, buf, extra = {}) {
    const dir = path.join(filesDir, projectId)
    await mkdir(dir, { recursive: true })
    const file = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${sanitizeName(name)}`
    await writeFile(path.join(dir, file), buf)
    return makeAsset(`${projectId}/${file}`, name, extra.mime || mimeOf(name), extra)
  }

  // ---------------------------------------------------------------- generate
  function sentenceText(project, index) {
    if (index == null) return project.script?.text || ''
    const cues = project.srt?.cues || []
    const cue = cues.find((c) => Number(c.sentence) === Number(index)) || cues[index]
    if (cue?.text) return cue.text
    const s = project.script?.sentences || []
    if (s[index]) return s[index].text
    return project.script?.text || ''
  }

  // A shot may cover several sentences (`sentences`), so every per-sentence
  // lookup goes through this instead of reading `sentenceIndex` directly.
  function nodeSentences(node) {
    if (!node) return []
    if (Array.isArray(node.sentences)) return node.sentences.map(Number).filter((n) => Number.isFinite(n))
    return node.sentenceIndex == null ? [] : [Number(node.sentenceIndex)]
  }

  function coversSentence(node, index) {
    if (index == null) return false
    return nodeSentences(node).includes(Number(index))
  }

  function nodeAudio(project, index) {
    const nodes = (project.nodes || []).filter((n) => n.kind === 'audio' && coversSentence(n, index) && (n.assets || []).some((a) => a.kind === 'audio'))
    const n = nodes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]
    return n ? { node: n, asset: n.assets.find((a) => a.kind === 'audio') } : null
  }

  function latestAudioFull(project) {
    const nodes = (project.nodes || []).filter((n) => n.kind === 'audio' && n.sentenceIndex == null && (n.assets || []).some((a) => a.kind === 'audio'))
    const n = nodes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]
    return n ? { node: n, asset: n.assets.find((a) => a.kind === 'audio') } : null
  }

  function cueForSentence(project, index) {
    if (index == null) return null
    const cues = project.srt?.cues || []
    return cues.find((c) => Number(c.sentence) === Number(index)) || cues[Number(index)] || null
  }

  async function chatComplete(model, messages, opts = {}) {
    const base = String(model.baseUrl || '').replace(/\/+$/, '')
    if (!base) throw new Error('模型缺少 baseUrl')
    const url = `${base}/chat/completions`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}) },
      body: JSON.stringify({ model: model.model, messages, temperature: opts.temperature ?? 0.7, max_tokens: opts.maxTokens ?? 2000 }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
    })
    if (!res.ok) throw new Error(`文本模型返回 ${res.status}：${(await res.text()).slice(0, 400)}`)
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content
    if (!text) throw new Error('文本模型没有返回内容')
    return String(text).trim()
  }

  async function speechToFile(model, text, dest) {
    const base = String(model.baseUrl || '').replace(/\/+$/, '')
    if (!base) throw new Error('TTS 模型缺少 baseUrl')
    const res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}) },
      body: JSON.stringify({ model: model.model, input: text, voice: model.voice || 'alloy', response_format: 'mp3', speed: model.speed || 1 }),
      signal: AbortSignal.timeout(180000),
    })
    if (!res.ok) throw new Error(`TTS 返回 ${res.status}：${(await res.text()).slice(0, 400)}`)
    const type = res.headers.get('content-type') || ''
    if (type.includes('application/json')) throw new Error(`TTS 返回了 JSON 而不是音频：${(await res.text()).slice(0, 400)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('TTS 返回空音频')
    await writeFile(dest, buf)
    return buf.length
  }

  async function transcribe(model, file) {    const base = String(model.baseUrl || '').replace(/\/+$/, '')
    if (!base) throw new Error('ASR 模型缺少 baseUrl')
    const buf = await readFile(file)
    const form = new FormData()
    form.append('file', new Blob([buf]), path.basename(file))
    form.append('model', model.model || 'whisper-1')
    form.append('response_format', 'verbose_json')
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(600000),
    })
    if (!res.ok) throw new Error(`ASR 返回 ${res.status}：${(await res.text()).slice(0, 400)}`)
    return await res.json()
  }

  // One round of "tell this node what you want" chat: the model answers in
  // Chinese and ends with a JSON patch that the client merges into node.params.
  const CHAT_PATCH_SCHEMA = {
    motion: '{"reply":"一句话说明","params":{"template":"kinetic|typewriter|particles|lowerthird|spotlight","title":"主标题","subtitle":"副标题","color1":"#rrggbb","color2":"#rrggbb","textColor":"#rrggbb","fontSize":72,"duration":3.5}}',
    dhvideo: '{"reply":"一句话说明","params":{"prompt":"交给数字人视频模型的画面、动作、口型要求"}}',
    screen: '{"reply":"一句话说明","params":{"prompt":"这段实录拍什么、镜头怎么走"}}',
    reference: '{"reply":"一句话说明","params":{"note":"这条参考最值得复用的点"}}',
  }
  const CHAT_KIND_LABEL = {
    motion: '画面动效', dhvideo: '数字人视频', screen: '软件实录', reference: '参考素材',
  }

  function nodeChatSystem(node, project) {
    const label = CHAT_KIND_LABEL[node.kind] || '素材'
    const sentences = nodeSentences(node).map((i) => sentenceText(project, i)).filter(Boolean)
    const cue = nodeSentences(node).length ? cueForSentence(project, nodeSentences(node)[0]) : null
    const lines = [
      `你在一条口播短视频的无限画布上工作。当前节点是「${label}」，${sentences.length ? `对应第 ${nodeSentences(node).map((i) => i + 1).join('、')} 句台词：${sentences.join(' / ')}` : '不绑定具体句子'}。`,
      cue ? `这句在 SRT 里的时间是 ${cue.start}s–${cue.end}s（时长约 ${(Number(cue.end) - Number(cue.start)).toFixed(2)} 秒），画面必须撑满这个时长。` : '',
      `项目画面：${project.settings?.size || '1080x1920'}，${project.settings?.fps || 30}fps。`,
      `节点当前参数：${JSON.stringify(node.params || {})}`,
      '用户会用中文提修改要求。先用一两句中文说明你打算怎么改，然后单独输出一行 JSON（可被 JSON.parse 解析，不要注释、不要代码块以外的东西）：',
      CHAT_PATCH_SCHEMA[node.kind] || '{"reply":"一句话说明","params":{}}',
    ]
    return lines.filter(Boolean).join('\n')
  }

  function extractChatPatch(text) {
    const raw = String(text || '')
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const candidates = []
    if (fenced) candidates.push(fenced[1])
    const tail = raw.match(/\{[\s\S]*\}\s*$/)
    if (tail) candidates.push(tail[0])
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c)
        if (parsed && typeof parsed === 'object') return parsed
      } catch { /* try next */ }
    }
    return null
  }

  async function nodeChat({ project, node, message, model }) {
    const messages = [
      { role: 'system', content: nodeChatSystem(node, project) },
      ...(node.chat || []).slice(-6).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.text || '') })),
      { role: 'user', content: message },
    ]
    const text = await chatComplete(model, messages, { temperature: 0.6, maxTokens: 1200 })
    const parsed = extractChatPatch(text)
    const reply = parsed && parsed.reply ? String(parsed.reply) : String(text).replace(/```[\s\S]*?```/g, '').trim()
    const patch = parsed && parsed.params && typeof parsed.params === 'object' ? parsed.params : null
    return { reply: reply || '已收到', patch }
  }

  function substitute(template, vars) {
    return String(template || '').replace(/\{(\w+)\}/g, (m, key) => (vars[key] != null ? String(vars[key]) : m))
  }

  async function download(url, dest, headers) {
    const res = await fetch(url, { headers: headers || {}, signal: AbortSignal.timeout(600000) })
    if (!res.ok) throw new Error(`下载素材失败 ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await mkdir(path.dirname(dest), { recursive: true })
    await writeFile(dest, buf)
    return dest
  }

  async function generateForNode(projectId, nodeId, opts, report) {
    await ensureDirs
    const project = await readProject(projectId)
    const node = (project.nodes || []).find((n) => n.id === nodeId)
    if (!node) throw new Error('节点不存在')
    const models = await readModels()
    node.status = 'running'
    node.error = null
    node.updatedAt = nowISO()
    await saveProject(project)
    report(3, '读取项目')

    try {
      if (node.kind === 'script') {
        const model = resolveModel(models, 'text', node.modelId)
        if (!model || model.provider === 'command') throw new Error('请先在「模型配置」里添加一个文本模型，再生成口播稿。')
        const topic = String(opts.prompt || node.params?.prompt || project.script.text || '').trim()
        if (!topic) throw new Error('请填写主题或提示词（也可以在节点里先手写口播稿）。')
        report(15, '调用文本模型…')
        const text = await chatComplete(model, [
          { role: 'system', content: '你是短视频口播文案专家。只输出口播稿正文，不要标题，不要解释，不要分镜。口语化，每句话尽量不超过30个字，句子之间用中文句号分隔。' },
          { role: 'user', content: `请为下面这个主题写一段 30-60 秒的口播稿：\n${topic}` },
        ], { maxTokens: 1600, temperature: 0.8 })
        const clean = text.replace(/^["'“”]+|["'“”]+$/g, '').trim()
        const sentences = splitSentences(clean)
        if (!sentences.length) throw new Error('模型没有产出可用句子')
        node.text = clean
        node.params = { ...(node.params || {}), prompt: topic }
        project.script = {
          text: clean,
          sentences: sentences.map((s, i) => ({ id: `s${i + 1}`, text: s })),
        }
        // Keep existing SRT text in sync when the sentence count matches; a
        // different sentence count means those timings belong to another script,
        // so drop them and let the SRT node rebuild the timeline.
        if (project.srt?.cues?.length === sentences.length) {
          project.srt.cues.forEach((c, i) => { c.text = sentences[i]; c.sentence = i })
          project.srt.raw = formatSrtText(project.srt.cues)
        } else if (project.srt?.cues?.length) {
          project.srt = { cues: [], raw: '', stale: true }
        }
        node.status = 'done'
        node.log = `生成 ${sentences.length} 句，${clean.length} 字`
        report(90, '写回句子')
      } else if (node.kind === 'storyboard') {
        // Derived node: timings come from the SRT cues, text edits are written
        // straight into those cues by the client. "Sync" just re-reads them.
        const cues = project.srt?.cues || []
        if (!cues.length) throw new Error('还没有字幕时间轴：先生成「字幕 SRT」，分镜时间戳由它衍生。')
        const sentences = project.script?.sentences || []
        for (const c of cues) {
          const i = c.sentence != null ? Number(c.sentence) : Number(c.index) - 1
          if (sentences[i] && (!c.text || opts.fromScript)) c.text = String(sentences[i].text || '')
        }
        project.srt.raw = formatSrtText(cues)
        node.status = 'done'
        node.log = `${cues.length} 句已按时间戳对齐`
        report(95, '同步完成')
      } else if (node.kind === 'audio') {
        const model = resolveModel(models, 'tts', node.modelId)
        if (!model) throw new Error('请先在「模型配置」里添加一个 TTS 模型。')
        const index = node.sentenceIndex == null ? null : Number(node.sentenceIndex)
        const text = String(opts.text || sentenceText(project, index)).trim()
        if (!text) throw new Error('这句还没有口播文字，请先生成或编辑口播稿。')
        report(20, '合成语音…')
        const dir = path.join(filesDir, projectId)
        await mkdir(dir, { recursive: true })
        const name = `${node.id}-${index == null ? 'full' : `s${index}`}-${Date.now().toString(36)}.mp3`
        const abs = path.join(dir, name)
        const bytes = await speechToFile(model, text, abs)
        report(75, '探测音频时长')
        const duration = await probeDuration(abs)
        const asset = await makeAsset(`${projectId}/${name}`, `第${index == null ? '整段' : index + 1}句-配音.mp3`, 'audio/mpeg', { kind: 'audio', duration: duration || undefined })
        node.assets = [asset]
        node.duration = duration || null
        node.text = text
        node.status = 'done'
        node.log = `生成音频 ${(bytes / 1024).toFixed(0)} KB${duration ? `，${duration.toFixed(2)}s` : ''}`
      } else if (node.kind === 'srt') {
        const mode = String(opts.mode || node.params?.mode || 'auto')
        let cues = []
        let note = ''
        if (mode === 'paste') {
          const raw = String(opts.rawText || '').trim()
          if (!raw) throw new Error('请粘贴 SRT 内容')
          cues = parseSrtText(raw).map((c, i) => ({ ...c, sentence: i }))
          note = '来自粘贴的 SRT'
        } else if (mode === 'asr') {
          const model = resolveModel(models, 'asr', node.modelId)
          if (!model) throw new Error('请先在「模型配置」里添加一个 ASR（Whisper）模型。')
          const full = latestAudioFull(project)
          if (!full) throw new Error('需要一条整段音频节点（句子选择为「整段」）才能做 ASR。逐句音频请用「自动对齐」。')
          report(15, '上传音频做识别…')
          const data = await transcribe(model, path.join(filesDir, full.asset.rel))
          const segments = Array.isArray(data?.segments) ? data.segments : []
          if (segments.length) {
            cues = segments.map((s, i) => ({ index: i + 1, sentence: i, start: Number(s.start) || 0, end: Number(s.end) || (Number(s.start) + 2), text: String(s.text || '').trim() }))
          } else if (data?.text) {
            const parts = splitSentences(data.text)
            let t = 0
            const dur = full.asset.duration || 0
            const total = dur || parts.length * 2
            cues = parts.map((p, i) => { const d = total / Math.max(1, parts.length); const c = { index: i + 1, sentence: i, start: t, end: t + d, text: p }; t += d; return c })
          }
          note = '来自 Whisper 识别'
        } else {
          // auto: real per-sentence audio durations where they exist, and a
          // character-rate estimate for the remaining sentences, so the timeline
          // always covers every sentence (each sentence gets its own shot).
          const sentences = (project.script?.sentences || []).map((s) => String(s.text || ''))
          if (!sentences.length) throw new Error('还没有口播稿句子，无法对齐时间轴。')
          const perSentence = (project.nodes || [])
            .filter((n) => n.kind === 'audio' && nodeSentences(n).length && (n.assets || []).some((a) => a.kind === 'audio'))
          const seen = new Map()
          for (const n of perSentence) {
            const a = n.assets.find((x) => x.kind === 'audio')
            const idx = nodeSentences(n)[0]
            const existing = seen.get(idx)
            if (!existing || String(n.updatedAt) > String(existing.updatedAt)) seen.set(idx, { node: n, asset: a })
          }
          const audioDurs = sentences.map((_, i) => {
            const hit = seen.get(i)
            const d = hit ? Number(hit.asset.duration) : 0
            return Number.isFinite(d) && d > 0 ? d : 0
          })
          const realCount = audioDurs.filter((d) => d > 0).length
          const missing = audioDurs.map((d, i) => (d > 0 ? null : i)).filter((i) => i != null)
          const full = latestAudioFull(project)
          const total = Number(full?.asset?.duration) || Number(opts.totalDuration) || 0
          const missingChars = missing.reduce((a, i) => a + Math.max(4, sentences[i].length), 0)
          const budget = total > 0
            ? Math.max(total - audioDurs.reduce((a, d) => a + d, 0), missingChars / 4.2 * 0.6)
            : Math.max(1.6, missingChars / 4.2)
          let t = 0
          cues = sentences.map((text, i) => {
            const d = audioDurs[i] > 0
              ? audioDurs[i]
              : Math.max(1.2, (Math.max(4, text.length) / Math.max(1, missingChars)) * budget)
            const cue = { index: i + 1, sentence: i, start: Math.round(t * 1000) / 1000, end: Math.round((t + d) * 1000) / 1000, text }
            t += d
            return cue
          })
          note = realCount
            ? `逐句音频 ${realCount} 句${missing.length ? ` + 估算 ${missing.length} 句（约 4.2 字/秒）` : ''}`
            : `无逐句音频，按约 4.2 字/秒估算总长 ${t.toFixed(2)}s（生成逐句音频后重新生成可精确对齐）`
        }
        if (!cues.length) throw new Error('没有解析出任何字幕行')
        cues = cues.map((c, i) => ({
          index: i + 1,
          sentence: Number.isInteger(Number(c.sentence)) ? Number(c.sentence) : i,
          start: Math.max(0, Number(c.start) || 0),
          end: Math.max((Number(c.start) || 0) + 0.2, Number(c.end) || 0),
          text: String(c.text || '').trim(),
        }))
        project.srt = { raw: formatSrtText(cues), cues }
        // Write the .srt next to the project so it can be downloaded / burned.
        const dir = path.join(filesDir, projectId)
        await mkdir(dir, { recursive: true })
        const name = 'subtitles.srt'
        await writeFile(path.join(dir, name), project.srt.raw, 'utf8')
        const asset = await makeAsset(`${projectId}/${name}`, 'subtitles.srt', 'text/plain; charset=utf-8', { kind: 'srt' })
        node.assets = [asset]
        node.status = 'done'
        node.log = `${cues.length} 条字幕 · ${note}`
        report(92, '写入 SRT')
      } else if (node.kind === 'dhvideo') {
        const index = node.sentenceIndex == null ? null : Number(node.sentenceIndex)
        const text = String(opts.text || sentenceText(project, index)).trim()
        const cue = cueForSentence(project, index)
        const dur = Number(opts.duration || (cue ? cue.end - cue.start : 0)) || 3
        const model = resolveModel(models, 'video', node.modelId)
        if (!model) throw new Error('请先在「模型配置」里添加一个视频模型（命令或 HTTP），或直接在检查器里导入视频素材。')
        const dir = path.join(filesDir, projectId)
        await mkdir(dir, { recursive: true })
        const outName = `${node.id}-${Date.now().toString(36)}.mp4`
        const outAbs = path.join(dir, outName)
        const audio = nodeAudio(project, index)
        const vars = {
          text, sentence: index == null ? '' : String(index + 1), duration: dur.toFixed(2),
          out: outAbs, width: 1080, height: 1920,
          audio: audio ? path.join(filesDir, audio.asset.rel) : '',
          project: projectId, node: node.id,
        }
        if (model.provider === 'command') {
          const template = String(model.command || '').trim()
          if (!template) throw new Error('这个视频模型的命令模板为空')
          const cmd = substitute(template, vars)
          report(15, '执行视频生成命令…')
          // shell:true lets the shell parse quotes the way the user wrote them;
          // passing the string as an argv element would double-escape inner quotes.
          const r = await runProcess(cmd, [], { shell: true, timeoutMs: 600000, onStderr: (l) => { if (l.trim()) report(40, l.slice(0, 160)) } })
          if (r.code !== 0) throw new Error(`视频命令失败（${r.code}）：${r.stderr.slice(-800)}`)
          if (!existsSync(outAbs)) throw new Error(`命令执行了，但没有产出文件：${outAbs}`)
        } else if (model.provider === 'http') {
          const base = String(model.baseUrl || '').trim()
          if (!base) throw new Error('视频模型缺少请求地址（baseUrl）')
          const payload = {
            model: model.model, prompt: text, text, duration: dur,
            width: 1080, height: 1920,
            audio_url: audio ? assetUrl(audio.asset.rel) : null,
          }
          report(15, '请求视频生成 API…')
          const res = await fetch(base, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}) },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(600000),
          })
          if (!res.ok) throw new Error(`视频接口返回 ${res.status}：${(await res.text()).slice(0, 400)}`)
          const data = await res.json()
          let videoUrl = data.video_url || data.videoUrl || data.url || data?.data?.video_url || data?.data?.url
          if (!videoUrl && (data.task_id || data.taskId) && model.statusUrl) {
            const task = data.task_id || data.taskId
            const statusUrl = substitute(model.statusUrl, { ...vars, task })
            for (let i = 0; i < 120 && !videoUrl; i++) {
              await new Promise((r) => setTimeout(r, 5000))
              report(30 + Math.min(50, i), `等待视频任务 ${task}…`)
              const sres = await fetch(statusUrl, { headers: model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {} })
              const sdata = await sres.json().catch(() => ({}))
              videoUrl = sdata.video_url || sdata.videoUrl || sdata.url || sdata?.data?.video_url || sdata?.data?.url
              if (String(sdata.status || '').toLowerCase() === 'failed') throw new Error(`视频任务失败：${JSON.stringify(sdata).slice(0, 300)}`)
            }
          }
          if (!videoUrl) throw new Error(`视频接口没有返回视频地址：${JSON.stringify(data).slice(0, 300)}`)
          await download(videoUrl, outAbs, model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : undefined)
        } else {
          throw new Error('未知的视频模型类型')
        }
        report(85, '登记素材')
        const duration = await probeDuration(outAbs)
        const asset = await makeAsset(`${projectId}/${outName}`, `第${index == null ? '整段' : index + 1}句-数字人.mp4`, 'video/mp4', { kind: 'video', duration: duration || undefined })
        node.assets = [asset]
        node.status = 'done'
        node.log = `生成视频${duration ? ` ${duration.toFixed(2)}s` : ''}`
      } else if (node.kind === 'motion') {
        const index = node.sentenceIndex == null ? null : Number(node.sentenceIndex)
        const text = String(opts.text || sentenceText(project, index)).trim()
        const cue = cueForSentence(project, index)
        const duration = Number(opts.duration || (cue ? cue.end - cue.start : 0)) || 3
        // The inspector may have edited params after the last save; honour the
        // request body first so the design never runs on stale settings.
        const override = opts.params && typeof opts.params === 'object' ? opts.params : {}
        const pick = (key, fallback) => (override[key] != null && override[key] !== '' ? override[key] : (node.params?.[key] != null && node.params?.[key] !== '' ? node.params[key] : fallback))
        const base = {
          template: pick('template', 'kinetic'),
          title: text || pick('title', '画面文字'),
          subtitle: pick('subtitle', ''),
          color1: pick('color1', '#4f7cff'),
          color2: pick('color2', '#9b5cff'),
          textColor: pick('textColor', '#ffffff'),
          duration,
          fontSize: Number(pick('fontSize', 72)) || 72,
        }
        let params = base
        const model = resolveModel(models, 'text', node.modelId)
        if (model) {
          try {
            report(10, '让模型设计动效参数…')
            const raw = await chatComplete(model, [
              { role: 'system', content: '你是动效设计助手。只输出 JSON，不要 markdown。字段：template(kinetic|typewriter|particles|lowerthird|spotlight), title, subtitle, color1, color2, textColor, fontSize(40-120)。根据口播句子设计一个简洁竖屏动效。' },
              { role: 'user', content: `句子：${text}\n可用模板：kinetic 大字动效 / typewriter 打字机 / particles 粒子 / lowerthird 下三分之一 / spotlight 聚光灯。时长 ${duration.toFixed(1)} 秒。` },
            ], { maxTokens: 400, temperature: 0.6 })
            const jsonText = raw.replace(/```(?:json)?/gi, '').trim()
            const parsed = JSON.parse(jsonText)
            params = { ...base, ...parsed, duration, template: String(parsed.template || base.template) }
          } catch {
            params = base
          }
        }
        node.params = { ...(node.params || {}), ...params, mode: 'client-render' }
        node.text = text
        node.status = 'ready'
        node.log = `动效参数已准备（${params.template}）。在检查器里预览并录制。`
        report(100, '等待浏览器渲染')
      } else if (node.kind === 'screen') {
        const index = node.sentenceIndex == null ? null : Number(node.sentenceIndex)
        if (!(node.assets || []).some((a) => a.kind === 'video')) {
          throw new Error('软件实录节点需要导入视频素材（检查器 → 导入素材）。合成时会自动裁剪到这句的时间戳。')
        }
        node.status = 'done'
        node.log = '已导入实录素材，合成时按时间戳裁剪'
      } else if (node.kind === 'reference') {
      const refs = (node.assets || []).filter((a) => a.kind === 'image' || a.kind === 'video')
      if (!refs.length) throw new Error('参考节点还没有素材：先上传一张图片或一段视频')
      node.status = 'done'
      report(100, '已就绪')
      return { node, project, extras: { references: refs.length } }
    } else if (node.kind === 'compose') {
        const result = await composeProject(project, node, report)
        project.updatedAt = nowISO()
        node.updatedAt = nowISO()
        await saveProject(project)
        report(100, '成片已保存')
        return { node, project, extras: result.extras || {} }
      } else {
        throw new Error(`未知节点类型：${node.kind}`)
      }
      node.updatedAt = nowISO()
      project.updatedAt = nowISO()
      await saveProject(project)
      report(100, '已保存')
      return { node: project.nodes.find((n) => n.id === node.id), project, extras: {} }
    } catch (err) {
      node.status = 'error'
      node.error = String(err?.message || err)
      node.updatedAt = nowISO()
      await saveProject(project).catch(() => {})
      throw err
    }
  }

  // --------------------------------------------------------------- compose
  function pickMaterial(project, sentenceIndex) {
    if (sentenceIndex == null) return null
    const priority = project.settings?.materialPriority || ['dhvideo', 'motion', 'screen']
    for (const kind of priority) {
      const nodes = (project.nodes || [])
        .filter((n) => n.kind === kind && coversSentence(n, sentenceIndex) && (n.assets || []).some((a) => a.kind === 'video'))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      if (nodes.length) {
        const node = nodes[0]
        return { node, asset: node.assets.find((a) => a.kind === 'video') }
      }
    }
    return null
  }

  async function renderClip(src, out, duration, W, H, fps, onLine) {
    const { ffmpeg } = await resolveFF()
    const args = ['-y']
    if (src) {
      const isImage = /\.(png|jpe?g|webp|bmp)$/i.test(src)
      if (isImage) args.push('-loop', '1', '-i', src)
      else args.push('-stream_loop', '-1', '-i', src)
    } else {
      args.push('-f', 'lavfi', '-i', `color=c=0x0e1116:s=${W}x${H}:r=${fps}`)
    }
    args.push(
      '-t', duration.toFixed(3),
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}`,
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', out,
    )
    const r = await runProcess(ffmpeg, args, { timeoutMs: 600000, onStderr: onLine })
    if (r.code !== 0) throw new Error(`ffmpeg 渲染片段失败：${r.stderr.slice(-600)}`)
  }

  async function composeProject(project, node, report) {
    const { ffmpeg } = await resolveFF()
    const cues = (project.srt?.cues || []).slice().sort((a, b) => Number(a.start) - Number(b.start))
    if (!cues.length) throw new Error('还没有字幕时间轴：先生成一个 SRT 节点（自动对齐 / ASR / 粘贴），再合成。')
    const [wStr, hStr] = String(project.settings?.size || '1080x1920').split('x')
    const W = Number(wStr) || 1080
    const H = Number(hStr) || 1920
    const fps = Number(project.settings?.fps) || 30
    const total = Math.max(...cues.map((c) => Number(c.end) || 0))
    if (!(total > 0)) throw new Error('字幕时间轴时长为 0')

    const tmp = path.join(tmpDir, `compose-${crypto.randomBytes(4).toString('hex')}`)
    await mkdir(tmp, { recursive: true })
    const cleanup = () => rm(tmp, { recursive: true, force: true }).catch(() => {})

    try {
      report(2, '准备素材…')
      const clips = []
      let emptyShots = 0
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i]
        const dur = Math.max(0.2, Number(cue.end) - Number(cue.start))
        const pick = pickMaterial(project, cue.sentence != null ? cue.sentence : Number(cue.index) - 1)
        if (!pick) emptyShots += 1
        const src = pick ? path.join(filesDir, pick.asset.rel) : null
        const clip = path.join(tmp, `clip-${String(i).padStart(4, '0')}.mp4`)
        await renderClip(src, clip, dur, W, H, fps, (line) => {
          const m = line.match(/time=(\d+):(\d+):(\d+\.\d+)/)
          if (m) {
            const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
            const frac = Math.min(1, sec / Math.max(0.1, dur))
            report(3 + ((i + frac) / cues.length) * 52, `渲染第 ${i + 1}/${cues.length} 句${pick ? `（${pick.node.title}）` : '（空镜）'}`)
          }
        })
        clips.push(clip)
      }
      report(57, '拼接画面…')
      const listFile = path.join(tmp, 'list.txt')
      await writeFile(listFile, clips.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
      const videoOnly = path.join(tmp, 'video.mp4')
      const rr = await runProcess(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', videoOnly], { timeoutMs: 600000 })
      if (rr.code !== 0) throw new Error(`ffmpeg 拼接失败：${rr.stderr.slice(-600)}`)
      report(68, '混合音频…')

      // Per-sentence audio placed at each cue start.
      const perCue = new Map()
      for (const n of project.nodes || []) {
        if (n.kind !== 'audio') continue
        const idx = nodeSentences(n)[0]
        if (idx == null) continue
        const a = (n.assets || []).find((x) => x.kind === 'audio')
        if (!a) continue
        const cue = cueForSentence(project, idx)
        const start = cue ? Number(cue.start) : 0
        if (!perCue.has(idx) || String(n.updatedAt) > String(perCue.get(idx).updatedAt)) {
          perCue.set(idx, { node: n, asset: a, start, updatedAt: n.updatedAt })
        }
      }
      const full = latestAudioFull(project)
      const outAudio = path.join(tmp, 'muxed.mp4')
      const args = ['-y', '-i', videoOnly]
      let filter = ''
      if (perCue.size) {
        const entries = [...perCue.values()].sort((a, b) => a.start - b.start)
        const chains = []
        entries.forEach((e, k) => {
          args.push('-i', path.join(filesDir, e.asset.rel))
          const ms = Math.max(0, Math.round(e.start * 1000))
          chains.push(`[${k + 1}:a]adelay=${ms}|${ms},volume=1[a${k}]`)
        })
        const mixIn = entries.map((_, k) => `[a${k}]`).join('')
        if (entries.length === 1) {
          filter = `${chains[0]};[a0]apad=whole_dur=${total.toFixed(3)}[aout]`
        } else {
          filter = `${chains.join(';')};${mixIn}amix=inputs=${entries.length}:duration=longest:normalize=0,apad=whole_dur=${total.toFixed(3)}[aout]`
        }
        args.push('-filter_complex', filter, '-map', '0:v', '-map', '[aout]')
      } else if (full) {
        args.push('-i', path.join(filesDir, full.asset.rel), '-map', '0:v', '-map', '1:a', '-af', `apad=whole_dur=${total.toFixed(3)}`)
      } else {
        args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-map', '0:v', '-map', '1:a', '-shortest')
      }
      args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), outAudio)
      const mux = await runProcess(ffmpeg, args, { timeoutMs: 600000 })
      if (mux.code !== 0) throw new Error(`ffmpeg 音频合成失败：${mux.stderr.slice(-800)}`)
      report(82, '烧录字幕…')

      let result = outAudio
      if (project.settings?.burnSubtitles !== false) {
        const assPath = path.join(tmp, 'subs.ass')
        await writeFile(assPath, formatAssText(cues, W, H, project.settings?.subtitle || {}), 'utf8')
        const burned = path.join(tmp, 'burned.mp4')
        const esc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:')
        const vf = `subtitles='${esc}'`
        const burn = await runProcess(ffmpeg, ['-y', '-i', outAudio, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', burned], {
          timeoutMs: 900000,
          onStderr: (line) => {
            const m = line.match(/time=(\d+):(\d+):(\d+\.\d+)/)
            if (m) {
              const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
              report(82 + Math.min(16, (sec / Math.max(0.1, total)) * 16), '烧录字幕…')
            }
          },
        })
        if (burn.code === 0) result = burned
        else node.log = `字幕烧录失败，已跳过：${burn.stderr.slice(-300)}`
      }
      report(97, '保存成片…')
      const rel = `exports/${projectIdName(project)}-${Date.now().toString(36)}.mp4`
      const dest = path.join(filesDir, rel)
      await mkdir(path.dirname(dest), { recursive: true })
      await copyFile(result, dest)
      const asset = await makeAsset(rel, `${project.name}-成片.mp4`, 'video/mp4', { kind: 'video' })
      node.assets = [asset]
      node.status = 'done'
      node.log = `${cues.length} 句 · ${W}x${H} · ${total.toFixed(1)}s${emptyShots ? ` · 空镜 ${emptyShots} 句` : ''}${node.log ? ` · ${node.log}` : ''}`
      node.updatedAt = nowISO()
      return { node, extras: { url: asset.url } }
    } finally {
      await cleanup()
    }
  }

  function projectIdName(project) {
    return String(project.id || 'project').replace(/[^A-Za-z0-9_-]/g, '')
  }

  // ---------------------------------------------------------------- routing
  async function handleApi(req, res, seg, url) {
    const method = req.method || 'GET'

    if (seg[1] === 'bootstrap' && method === 'GET') {
      let ff = null
      let ffError = null
      try { ff = await resolveFF() } catch (err) { ffError = String(err?.message || err) }
      const models = await readModels()
      sendJson(res, 200, {
        projects: await listProjects(),
        models: publicModels(models).models,
        defaults: models.defaults || {},
        ffmpeg: { ok: Boolean(ff), path: ff?.ffmpeg || null, error: ffError },
        dataDir,
        version: 1,
      })
      return true
    }

    if (seg[1] === 'projects') {
      if (seg.length === 2) {
        if (method === 'GET') { sendJson(res, 200, { projects: await listProjects() }); return true }
        if (method === 'POST') {
          await ensureDirs
          const body = await readJsonBody(req)
          const doc = blankProject(body.name)
          await saveProject(doc)
          sendJson(res, 201, { project: doc })
          return true
        }
      }
      const id = seg[2]
      if (id && /^[A-Za-z0-9_-]+$/.test(id)) {
        if (seg.length === 3) {
          if (method === 'GET') { sendJson(res, 200, { project: await readProject(id) }); return true }
          if (method === 'PUT') {
            const body = await readJsonBody(req, 64 * 1024 * 1024)
            const saved = await withLock(id, async () => {
              const fresh = await readProject(id).catch(() => null)
              const doc = { ...(body.project || body) }
              doc.id = id
              doc.updatedAt = nowISO()
              if (!doc.createdAt) doc.createdAt = fresh?.createdAt || nowISO()
              await writeJsonAtomic(projectPath(id), doc)
              return doc
            })
            sendJson(res, 200, { project: saved })
            return true
          }
          if (method === 'DELETE') {
            await unlink(projectPath(id)).catch(() => {})
            sendJson(res, 200, { ok: true })
            return true
          }
        }
        if (seg[3] === 'srt' && method === 'GET') {
          const doc = await readProject(id)
          const raw = doc.srt?.raw || formatSrtText(doc.srt?.cues || [])
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': `attachment; filename="subtitles.srt"`,
          })
          res.end(raw)
          return true
        }
        if (seg[3] === 'import' && seg.length === 4 && method === 'POST') {
          const body = await readJsonBody(req)
          const src = String(body.path || '').trim()
          if (!src || !existsSync(src)) throw new Error('本地文件不存在')
          const nodeId = String(body.nodeId || '')
          const projectDoc = await readProject(id)
          const node = (projectDoc.nodes || []).find((n) => n.id === nodeId)
          if (!node) throw new Error('节点不存在')
          const name = path.basename(src)
          const dir = path.join(filesDir, id)
          await mkdir(dir, { recursive: true })
          const rel = `${id}/${Date.now().toString(36)}-${sanitizeName(name)}`
          await copyFile(src, path.join(filesDir, rel))
          const asset = await makeAsset(rel, name)
          sendJson(res, 200, { asset })
          return true
        }
        if (seg[3] === 'nodes' && seg[4] && seg[5] === 'chat' && method === 'POST') {
          const nodeId = seg[4]
          const body = await readJsonBody(req)
          const message = String(body.message || '').trim()
          if (!message) throw new Error('请输入你的要求')
          const projectDoc = await readProject(id)
          const node = (projectDoc.nodes || []).find((n) => n.id === nodeId)
          if (!node) throw new Error('节点不存在')
          const modelKind = node.kind === 'motion' ? 'motion' : 'text'
          const model = resolveModel(await readModels(), modelKind, node.modelId)
          if (!model) throw new Error(`还没有配置${modelKind === 'motion' ? '动效' : '文本'}模型，先到「模型配置」里加一个`)
          const result = await nodeChat({ project: projectDoc, node, message, model })
          const at = nowISO()
          node.chat = (node.chat || []).concat([{ role: 'user', text: message, at }, { role: 'assistant', text: result.reply, at }]).slice(-40)
          if (result.patch) node.params = { ...(node.params || {}), ...result.patch }
          node.updatedAt = at
          await saveProject(projectDoc)
          sendJson(res, 200, { reply: result.reply, patch: result.patch, node })
          return true
        }
        if (seg[3] === 'nodes' && seg[4] && seg[5] === 'generate' && method === 'POST') {
          const nodeId = seg[4]
          const body = await readJsonBody(req)
          const projectDoc = await readProject(id)
          const node = (projectDoc.nodes || []).find((n) => n.id === nodeId)
          if (!node) throw new Error('节点不存在')
          const job = runJob(id, nodeId, `生成 ${node.title || node.kind}`, (report) => generateForNode(id, nodeId, body || {}, report))
          sendJson(res, 202, { job })
          return true
        }
        if (seg[3] === 'assets' && seg[4] && method === 'DELETE') {
          const projectDoc = await readProject(id)
          let removed = null
          for (const n of projectDoc.nodes || []) {
            const i = (n.assets || []).findIndex((a) => a.id === seg[4])
            if (i >= 0) { removed = n.assets.splice(i, 1)[0]; break }
          }
          if (removed) await saveProject(projectDoc)
          sendJson(res, 200, { ok: Boolean(removed) })
          return true
        }
      }
    }

    if (seg[1] === 'jobs' && seg[2] && method === 'GET') {
      const job = jobs.get(seg[2])
      if (!job) { sendJson(res, 404, { error: '任务不存在' }); return true }
      sendJson(res, 200, { job })
      return true
    }

    if (seg[1] === 'upload' && (method === 'PUT' || method === 'POST')) {
      const projectId = String(url.searchParams.get('projectId') || '')
      const nodeId = String(url.searchParams.get('nodeId') || '')
      const name = sanitizeName(url.searchParams.get('name') || 'upload.bin')
      const mime = req.headers['x-file-type'] || req.headers['content-type'] || ''
      const hintDuration = Number(req.headers['x-duration'])
      if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('缺少 projectId')
      await readProject(projectId)
      const dir = path.join(filesDir, projectId)
      await mkdir(dir, { recursive: true })
      const filename = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${name}`
      const abs = path.join(dir, filename)
      await new Promise((resolve, reject) => {
        const out = createWriteStream(abs)
        let size = 0
        req.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024 * 1024) { reject(new Error('文件过大')); req.destroy() } })
        req.pipe(out)
        out.on('finish', resolve)
        out.on('error', reject)
        req.on('error', reject)
      })
      const kindHint = String(mime).toLowerCase()
      const extra = {
        kind: ['video', 'audio', 'image'].includes(kindHint) ? kindHint : kindOfMime(mime, name),
        mime: mime || mimeOf(name),
      }
      if (Number.isFinite(hintDuration) && hintDuration > 0) extra.duration = Math.round(hintDuration * 1000) / 1000
      const asset = await makeAsset(`${projectId}/${filename}`, name, mime, extra)
      sendJson(res, 200, { asset, nodeId })
      return true
    }

    if (seg[1] === 'models') {
      if (seg.length === 2) {
        if (method === 'GET') { sendJson(res, 200, publicModels(await readModels())); return true }
        if (method === 'PUT') {
          const body = await readJsonBody(req)
          const current = await readModels()
          const oldById = new Map((current.models || []).map((m) => [m.id, m]))
          const incoming = Array.isArray(body.models) ? body.models : []
          const models = incoming.map((m) => {
            const prev = oldById.get(m.id)
            const key = String(m.apiKey || '')
            const apiKey = key.includes('…') || key.includes('••') ? (prev?.apiKey || '') : key
            return {
              id: m.id && /^[A-Za-z0-9_-]+$/.test(m.id) ? m.id : uid('m'),
              kind: KNOWN_KINDS.has(m.kind) ? m.kind : 'text',
              name: String(m.name || DEFAULTS[m.kind]?.name || '模型').slice(0, 80),
              provider: ['openai', 'command', 'http'].includes(m.provider) ? m.provider : 'openai',
              baseUrl: String(m.baseUrl || '').trim(),
              model: String(m.model || '').trim(),
              voice: String(m.voice || '').trim(),
              command: String(m.command || ''),
              statusUrl: String(m.statusUrl || '').trim(),
              apiKey,
              enabled: m.enabled !== false,
            }
          })
          const defaults = {}
          for (const kind of KNOWN_KINDS) {
            const v = body.defaults?.[kind]
            if (v && models.some((m) => m.id === v)) defaults[kind] = v
          }
          await writeModels({ models, defaults })
          sendJson(res, 200, publicModels({ models, defaults }))
          return true
        }
      }
      if (seg[2] === 'test' && method === 'POST') {
        const body = await readJsonBody(req)
        const doc = await readModels()
        const model = (doc.models || []).find((m) => m.id === body.id)
        if (!model) { sendJson(res, 404, { error: '模型不存在' }); return true }
        const t0 = Date.now()
        try {
          if (model.kind === 'text' || model.kind === 'motion') {
            const text = await chatComplete(model, [{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 10, timeoutMs: 60000 })
            sendJson(res, 200, { ok: true, message: `返回：${text.slice(0, 60)}`, latency: Date.now() - t0 })
          } else if (model.kind === 'tts') {
            const tmp = path.join(tmpDir, `test-${Date.now()}.mp3`)
            await speechToFile(model, '你好，测试一下语音合成。', tmp)
            const d = await probeDuration(tmp)
            await unlink(tmp).catch(() => {})
            sendJson(res, 200, { ok: true, message: `音频 ${d ? d.toFixed(2) + 's' : '已生成'}`, latency: Date.now() - t0 })
          } else if (model.kind === 'asr') {
            sendJson(res, 200, { ok: true, message: 'ASR 无独立测试：在 SRT 节点选「Whisper 识别」时使用。', latency: 0 })
          } else {
            sendJson(res, 200, { ok: true, message: '视频模型无独立测试：在数字人节点生成时使用。', latency: 0 })
          }
        } catch (err) {
          sendJson(res, 200, { ok: false, message: String(err?.message || err), latency: Date.now() - t0 })
        }
        return true
      }
    }
    return false
  }

  async function handleFiles(req, res, sub) {
    const rel = decodeURIComponent(sub.replace(/^\/files\//, ''))
    if (!rel || rel.includes('\u0000')) { res.writeHead(400); res.end(); return }
    const abs = path.resolve(filesDir, rel)
    const base = path.resolve(filesDir) + path.sep
    if (!abs.startsWith(base)) { res.writeHead(403); res.end(); return }
    let info
    try { info = await stat(abs) } catch { res.writeHead(404); res.end(); return }
    if (!info.isFile()) { res.writeHead(404); res.end(); return }
    const total = info.size
    const mime = mimeOf(abs)
    const range = req.headers.range
    if (range) {
      const m = String(range).match(/bytes=(\d*)-(\d*)/)
      if (m) {
        let start = m[1] ? Number(m[1]) : 0
        let end = m[2] ? Number(m[2]) : total - 1
        if (!Number.isFinite(start) || start < 0) start = 0
        if (!Number.isFinite(end) || end >= total) end = total - 1
        if (start > end) { res.writeHead(416, { 'content-range': `bytes */${total}` }); res.end(); return }
        res.writeHead(206, {
          'content-type': mime, 'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': end - start + 1, 'cache-control': 'no-store',
        })
        if (req.method === 'HEAD') { res.end(); return }
        createReadStream(abs, { start, end }).pipe(res)
        return
      }
    }
    res.writeHead(200, { 'content-type': mime, 'content-length': total, 'accept-ranges': 'bytes', 'cache-control': 'no-store' })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(abs).pipe(res)
  }

  async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    let pathname = url.pathname
    try { pathname = decodeURIComponent(pathname) } catch {}
    if (!pathname.startsWith(ROOT)) { res.writeHead(404); res.end(); return }
    const sub = pathname.slice(ROOT.length) || '/'
    try {
      await ensureDirs
      if (sub.startsWith('/files/')) { await handleFiles(req, res, sub); return }
      const seg = sub.split('/').filter(Boolean)
      if (seg[0] === 'api' && (await handleApi(req, res, seg, url))) return
      sendJson(res, 404, { error: '未知接口' })
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) })
      else { try { res.end() } catch {} }
    }
  }

  const disposer = web.register({ kind: 'prefix', path: ROOT, handler })
  ctx.effect(() => () => { try { disposer() } catch {} }, 'oral-canvas: routes')
}

