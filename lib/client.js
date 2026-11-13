/**
 * dsh-oral-canvas — client half.
 *
 * A full-page "口播画布" panel: an infinite canvas whose nodes are the
 * production steps of an oral-broadcast short video. Nodes are bound to a
 * sentence of the script (第 N 句) so every shot follows the SRT timeline, and
 * each node can pick its own model from the shared model registry.
 *
 * Pure React via the host module table; no bundler, no extra deps.
 */
window.__ModuleLoader__.load({
  id: 'dsh-oral-canvas',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var NS = 'dsh-oral-canvas'
    var PANEL_ID = 'oral-canvas'
    var API = '/oral-canvas/api'
    var FILES = '/oral-canvas/files/'
    var LS_ACTIVE = 'oral-canvas:active'
    var LS_SENTENCES = 'oral-canvas:sentences'
    // The shell's layout Service can select one central panel. Keeping a live
    // reference lets this panel re-open itself after the app restarts.
    var LAYOUT = null
    var PIN_KEY = 'oral-canvas:pinned'
    function isPinned() {
      try { return window.localStorage.getItem(PIN_KEY) !== '0' } catch (e) { return true }
    }
    function writePinned(on) {
      try { window.localStorage.setItem(PIN_KEY, on ? '1' : '0') } catch (e) {}
    }
    function openPanel() {
      if (!LAYOUT) return false
      try { LAYOUT.selectPanel(PANEL_ID); return true } catch (e) { return false }
    }

    // ---------------------------------------------------------------- kinds
    var KINDS = {
      script: { label: '口播稿', short: '稿', color: '#f0b45a', model: 'text', w: 340, sentence: false, verb: '生成口播稿' },
      audio: { label: '数字人音频', short: '音', color: '#57b8e8', model: 'tts', w: 320, sentence: true, batch: true, verb: '合成配音' },
      srt: { label: '字幕 SRT', short: '字', color: '#5fd0a5', model: 'asr', w: 360, sentence: false, verb: '生成字幕' },
      storyboard: { label: '分镜时间戳', short: '镜', color: '#f5a25d', model: null, w: 420, sentence: false, verb: '同步字幕' },
      dhvideo: { label: '数字人视频', short: '人', color: '#a98bfa', model: 'video', w: 320, sentence: true, verb: '生成视频' },
      motion: { label: '画面动效', short: '效', color: '#f286a0', model: 'motion', w: 320, sentence: true, verb: '设计动效' },
      screen: { label: '软件实录', short: '录', color: '#93a1b8', model: null, w: 320, sentence: true, verb: '确认素材' },
      reference: { label: '参考节点', short: '参', color: '#8bd0e0', model: null, w: 320, sentence: false, verb: '上传参考' },
      compose: { label: '合成成片', short: '片', color: '#f2cd62', model: null, w: 360, sentence: false, verb: '合成成片' },
    }
    var KIND_ORDER = ['script', 'audio', 'srt', 'storyboard', 'dhvideo', 'motion', 'screen', 'reference', 'compose']
    var COLUMN = { script: 0, audio: 1, srt: 2, storyboard: 3, dhvideo: 4, motion: 5, screen: 6, reference: 7, compose: 8 }
    var LANE_PITCH = 400
    var MODEL_KINDS = [
      { id: 'text', label: '文本模型' },
      { id: 'tts', label: '语音合成' },
      { id: 'asr', label: '语音识别' },
      { id: 'video', label: '数字人视频' },
      { id: 'motion', label: '动效设计' },
    ]
    var MODEL_KIND_LABEL = {
      text: '文本', tts: 'TTS', asr: 'ASR', video: '视频', motion: '动效',
    }
    var TEMPLATES = [
      { id: 'kinetic', label: '大字动效' },
      { id: 'typewriter', label: '打字机' },
      { id: 'particles', label: '粒子' },
      { id: 'lowerthird', label: '下三分之一' },
      { id: 'spotlight', label: '聚光灯' },
    ]
    var SIZES = [
      { id: '1080x1920', label: '竖屏 1080×1920' },
      { id: '1920x1080', label: '横屏 1920×1080' },
      { id: '1080x1080', label: '方形 1080×1080' },
    ]

    // ---------------------------------------------------------------- utils
    function uid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3) }
    function clamp(n, min, max) { var v = Number(n); if (!Number.isFinite(v)) return min; return Math.min(max, Math.max(min, v)) }
    function fileUrl(rel) { return FILES + String(rel || '').split('/').map(encodeURIComponent).join('/') }
    function fmtSec(n) {
      var v = Number(n)
      if (!Number.isFinite(v)) return '—'
      var m = Math.floor(v / 60)
      var s = v % 60
      return m > 0 ? m + ':' + (s < 10 ? '0' : '') + s.toFixed(1) : s.toFixed(1) + 's'
    }
    function fmtClock(n) {
      var v = Math.max(0, Number(n) || 0)
      var m = Math.floor(v / 60)
      var s = Math.floor(v % 60)
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    }
    function short(text, n) {
      var s = String(text || '').replace(/\s+/g, ' ').trim()
      return s.length > n ? s.slice(0, n) + '…' : s
    }

    function splitScript(text) {
      var normalized = String(text || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim()
      if (!normalized) return []
      var parts = normalized.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || []
      var out = []
      for (var i = 0; i < parts.length; i++) {
        var s = parts[i].trim()
        if (!s) continue
        if (s.length > 60) {
          var pieces = s.split(/(?<=[，,、])/)
          var buf = ''
          for (var j = 0; j < pieces.length; j++) {
            if ((buf + pieces[j]).length > 40 && buf) { out.push(buf.trim()); buf = pieces[j] }
            else buf += pieces[j]
          }
          if (buf.trim()) out.push(buf.trim())
        } else out.push(s)
      }
      return out
    }

    // The script's sentences are the storyboard source of truth; the SRT cues only
    // supply the timing for them. (Cues from an older script must never win, or the
    // 分镜 panel keeps showing the previous take after the script was replaced.)
    function sentenceEntries(project) {
      var cues = (project && project.srt && project.srt.cues) || []
      var ss = (project && project.script && project.script.sentences) || []
      var out = []
      if (ss.length) {
        ss.forEach(function (s, i) {
          var cue = null
          for (var k = 0; k < cues.length; k++) if (Number(cues[k].sentence) === i) { cue = cues[k]; break }
          if (!cue && cues.length === ss.length) cue = cues[i]
          out.push({
            index: i,
            order: i + 1,
            text: s.text || '',
            start: cue ? cue.start : null,
            end: cue ? cue.end : null,
          })
        })
        return out
      }
      cues.forEach(function (c, i) {
        out.push({
          index: c.sentence != null ? Number(c.sentence) : i,
          order: i + 1,
          text: c.text || '',
          start: c.start, end: c.end,
        })
      })
      return out
    }

    // A node can cover several sentences (one motion video for three lines):
    // `sentences` is the canonical list, `sentenceIndex` is the legacy single value.
    function nodeSentences(node) {
      if (!node) return []
      if (Array.isArray(node.sentences)) return node.sentences.map(Number).filter(function (n) { return Number.isFinite(n) })
      return node.sentenceIndex == null ? [] : [Number(node.sentenceIndex)]
    }

    function sentenceLabel(node) {
      var list = nodeSentences(node)
      if (!list.length) return ''
      if (list.length <= 3) return '第' + list.map(function (i) { return i + 1 }).join('、') + '句'
      return '第' + (list[0] + 1) + '–' + (list[list.length - 1] + 1) + '句（共' + list.length + '句）'
    }

    function sentenceOf(project, index) {
      if (index == null) return ''
      var entries = sentenceEntries(project)
      for (var i = 0; i < entries.length; i++) if (Number(entries[i].index) === Number(index)) return entries[i].text
      return (entries[index] && entries[index].text) || ''
    }

    function cueOf(project, index) {
      var cues = (project && project.srt && project.srt.cues) || []
      for (var i = 0; i < cues.length; i++) if (Number(cues[i].sentence) === Number(index)) return cues[i]
      return cues[Number(index)] || null
    }

    function sentenceSpan(project, index) {
      var c = cueOf(project, index)
      return c && Number.isFinite(Number(c.end)) ? Math.max(0.2, Number(c.end) - Number(c.start)) : 0
    }

    function pickMaterial(project, sentenceIndex) {
      if (sentenceIndex == null) return null
      var priority = (project.settings && project.settings.materialPriority) || ['dhvideo', 'motion', 'screen']
      for (var k = 0; k < priority.length; k++) {
        var kind = priority[k]
        var nodes = (project.nodes || []).filter(function (n) {
          return n.kind === kind && nodeSentences(n).indexOf(Number(sentenceIndex)) >= 0 && (n.assets || []).some(function (a) { return a.kind === 'video' })
        }).sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)) })
        if (nodes.length) {
          var node = nodes[0]
          return { node: node, asset: node.assets.filter(function (a) { return a.kind === 'video' })[0] }
        }
      }
      return null
    }

    function firstAsset(node, kind) {
      var list = (node && node.assets) || []
      for (var i = 0; i < list.length; i++) if (!kind || list[i].kind === kind) return list[i]
      return null
    }

    // ------------------------------------------------------------------ api
    function api(path, opts) {
      opts = opts || {}
      var init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {} }
      if (opts.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      return fetch(API + path, init).then(function (res) {
        return res.text().then(function (txt) {
          var data = null
          try { data = txt ? JSON.parse(txt) : null } catch (e) { data = { raw: txt } }
          if (!res.ok) throw new Error((data && (data.error || data.message)) || 'HTTP ' + res.status)
          return data
        })
      })
    }

    function uploadAsset(projectId, nodeId, file, name, duration) {
      var url = API + '/upload?projectId=' + encodeURIComponent(projectId) + '&nodeId=' + encodeURIComponent(nodeId) + '&name=' + encodeURIComponent(name || file.name || 'upload.bin')
      var headers = { 'x-file-type': file.type || 'application/octet-stream' }
      if (duration > 0) headers['x-duration'] = String(duration)
      return fetch(url, {
        method: 'PUT',
        headers: headers,
        body: file,
      }).then(function (res) {
        return res.text().then(function (txt) {
          var data = null
          try { data = JSON.parse(txt) } catch (e) { data = null }
          if (!res.ok || !data) throw new Error((data && data.error) || 'HTTP ' + res.status)
          return data
        })
      })
    }

    // --------------------------------------------------------------- motion
    function wrapLines(g, text, maxWidth) {
      var chars = String(text || '').split('')
      var lines = []
      var line = ''
      for (var i = 0; i < chars.length; i++) {
        var next = line + chars[i]
        var width = Number(g.measureText(next).width) || 0
        if (width > maxWidth && line) { lines.push(line); line = chars[i] }
        else line = next
      }
      if (line) lines.push(line)
      return lines.slice(0, 5)
    }

    function easeOutBack(p) {
      var c1 = 1.70158, c3 = c1 + 1
      return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
    }

    function drawMotion(g, params, t, W, H, duration) {
      var p = params || {}
      var dur = Math.max(0.4, Number(duration || p.duration) || 3)
      var k = Math.min(1.25, t / dur)
      var scale = W / 1080
      var c1 = p.color1 || '#4f7cff'
      var c2 = p.color2 || '#9b5cff'
      var grad = g.createLinearGradient(0, 0, W, H)
      grad.addColorStop(0, c1)
      grad.addColorStop(1, c2)
      g.fillStyle = grad
      g.fillRect(0, 0, W, H)

      var gx = W * (0.3 + 0.12 * Math.sin(t * 0.8))
      var gy = H * (0.24 + 0.06 * Math.cos(t * 0.6))
      var glow = g.createRadialGradient(gx, gy, 0, gx, gy, W * 0.9)
      glow.addColorStop(0, 'rgba(255,255,255,0.26)')
      glow.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = glow
      g.fillRect(0, 0, W, H)

      var template = p.template || 'kinetic'
      var title = String(p.title || '画面文字')
      var subtitle = String(p.subtitle || '')
      var fs = clamp(Number(p.fontSize) || 72, 24, 180) * scale
      var fg = p.textColor || '#ffffff'
      g.textAlign = 'center'
      g.textBaseline = 'middle'

      if (template === 'particles') {
        for (var i = 0; i < 70; i++) {
          var seed = Math.sin(i * 12.9898) * 43758.5453
          var r = seed - Math.floor(seed)
          var r2 = Math.sin(i * 78.233) * 43758.5453
          r2 = r2 - Math.floor(r2)
          var px = ((r * W + t * (18 + r2 * 44) * scale) % (W + 80)) - 40
          var py = H - ((r2 * H + t * (26 + r * 60) * scale) % (H + 120)) + 60
          var rad = (1.4 + r * 4.6) * scale
          g.beginPath()
          g.fillStyle = 'rgba(255,255,255,' + (0.12 + r2 * 0.5).toFixed(3) + ')'
          g.arc(px, py, rad, 0, Math.PI * 2)
          g.fill()
        }
        g.fillStyle = fg
        g.font = '700 ' + fs + 'px "Microsoft YaHei", "PingFang SC", sans-serif'
        var plines = wrapLines(g, title, W * 0.78)
        var pstart = H * 0.5 - ((plines.length - 1) * fs * 1.28) / 2
        for (var li = 0; li < plines.length; li++) {
          g.globalAlpha = clamp(k * 2 - li * 0.15, 0, 1)
          g.fillText(plines[li], W / 2, pstart + li * fs * 1.28)
        }
        g.globalAlpha = 1
      } else if (template === 'typewriter') {
        g.fillStyle = 'rgba(0,0,0,0.38)'
        g.fillRect(W * 0.08, H * 0.34, W * 0.84, H * 0.32)
        g.fillStyle = fg
        g.font = '600 ' + fs * 0.72 + 'px "Microsoft YaHei", "PingFang SC", monospace'
        g.textAlign = 'left'
        var typed = title.slice(0, Math.floor(title.length * clamp(k * 1.35, 0, 1)))
        var tlines = wrapLines(g, typed, W * 0.72)
        var ty = H * 0.5 - ((tlines.length - 1) * fs * 0.92) / 2
        for (var ti = 0; ti < tlines.length; ti++) g.fillText(tlines[ti], W * 0.14, ty + ti * fs * 0.92)
        if (Math.floor(t * 2.6) % 2 === 0) {
          var lastW = tlines.length ? g.measureText(tlines[tlines.length - 1]).width : 0
          g.fillStyle = '#ffffff'
          g.fillRect(W * 0.14 + lastW + 6 * scale, ty + (tlines.length - 1) * fs * 0.92 - fs * 0.36, 4 * scale, fs * 0.72)
        }
      } else if (template === 'lowerthird') {
        var barH = H * 0.2
        var barY = H * 0.68
        g.fillStyle = 'rgba(0,0,0,0.62)'
        g.fillRect(0, barY, W, barH)
        g.fillStyle = c2
        g.fillRect(0, barY, 10 * scale, barH)
        g.textAlign = 'left'
        g.fillStyle = fg
        g.font = '700 ' + fs * 0.62 + 'px "Microsoft YaHei", "PingFang SC", sans-serif'
        g.fillText(short(title, 18), W * 0.06, barY + barH * (subtitle ? 0.34 : 0.5))
        if (subtitle) {
          g.font = '400 ' + fs * 0.32 + 'px "Microsoft YaHei", "PingFang SC", sans-serif'
          g.fillStyle = 'rgba(255,255,255,0.76)'
          g.fillText(subtitle, W * 0.06, barY + barH * 0.72)
        }
      } else if (template === 'spotlight') {
        g.fillStyle = 'rgba(0,0,0,0.72)'
        g.fillRect(0, 0, W, H)
        var sx = W * (0.5 + 0.16 * Math.sin(t * 0.9))
        var sy = H * (0.44 + 0.05 * Math.cos(t * 0.7))
        var spot = g.createRadialGradient(sx, sy, 10 * scale, sx, sy, W * 0.62)
        spot.addColorStop(0, 'rgba(255,255,255,0.95)')
        spot.addColorStop(0.55, 'rgba(255,255,255,0.42)')
        spot.addColorStop(1, 'rgba(255,255,255,0)')
        g.fillStyle = spot
        g.fillRect(0, 0, W, H)
        g.fillStyle = 'rgba(255,255,255,0.92)'
        g.font = '700 ' + fs * 0.8 + 'px "Microsoft YaHei", "PingFang SC", sans-serif'
        g.textAlign = 'center'
        var slines = wrapLines(g, title, W * 0.66)
        for (var si = 0; si < slines.length; si++) g.fillText(slines[si], W / 2, H * 0.46 + si * fs * 1.1)
      } else {
        // kinetic
        var pop = easeOutBack(clamp(k * 2.4, 0, 1))
        var slide = (1 - clamp(k * 2.2, 0, 1)) * 60 * scale
        g.save()
        g.translate(W / 2, H * 0.5 + slide)
        g.scale(pop, pop)
        g.fillStyle = fg
        g.font = '800 ' + fs + 'px "Microsoft YaHei", "PingFang SC", sans-serif'
        var klines = wrapLines(g, title, W * 0.8)
        for (var ki = 0; ki < klines.length; ki++) g.fillText(klines[ki], 0, (ki - (klines.length - 1) / 2) * fs * 1.3)
        g.restore()
        if (subtitle) {
          g.fillStyle = 'rgba(255,255,255,0.82)'
          g.font = '400 ' + fs * 0.34 + 'px "Microsoft YaHei", "PingFang SC", sans-serif'
          g.textAlign = 'center'
          g.globalAlpha = clamp((k - 0.24) * 3, 0, 1)
          g.fillText(subtitle, W / 2, H * 0.5 + ((wrapLines(g, title, W * 0.8).length - 1) / 2) * fs * 1.3 + fs * 0.95)
          g.globalAlpha = 1
        }
        // progress bar: the shot's own timeline
        g.fillStyle = 'rgba(255,255,255,0.24)'
        g.fillRect(W * 0.1, H * 0.93, W * 0.8, 4 * scale)
        g.fillStyle = 'rgba(255,255,255,0.85)'
        g.fillRect(W * 0.1, H * 0.93, W * 0.8 * clamp(t / dur, 0, 1), 4 * scale)
      }

      // corner label
      g.globalAlpha = 0.5
      g.fillStyle = '#ffffff'
      g.textAlign = 'left'
      g.textBaseline = 'top'
      g.font = '500 ' + Math.round(22 * scale) + 'px "Microsoft YaHei", sans-serif'
      g.fillText(p.label || '口播画面', W * 0.055, H * 0.05)
      g.globalAlpha = 1
    }

    function recordCanvas(params, duration, onProgress) {
      return new Promise(function (resolve, reject) {
        if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
          reject(new Error('当前浏览器不支持画布录制（需要 MediaRecorder + captureStream）'))
          return
        }
        var canvas = document.createElement('canvas')
        canvas.width = 1080
        canvas.height = 1920
        var g = canvas.getContext('2d')
        if (!g) { reject(new Error('无法创建画布')); return }
        var stream = canvas.captureStream(30)
        var candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        var mime = ''
        for (var i = 0; i < candidates.length; i++) {
          if (window.MediaRecorder.isTypeSupported(candidates[i])) { mime = candidates[i]; break }
        }
        var rec
        try {
          rec = new window.MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 9000000 })
        } catch (err) { reject(err); return }
        var chunks = []
        var settled = false
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data) }
        rec.onerror = function (e) {
          if (settled) return
          settled = true
          try { stream.getTracks().forEach(function (tr) { tr.stop() }) } catch (err) {}
          reject((e && e.error) || new Error('录制出错'))
        }
        rec.onstop = function () {
          if (settled) return
          settled = true
          try { stream.getTracks().forEach(function (tr) { tr.stop() }) } catch (err) {}
          var blob = new Blob(chunks, { type: 'video/webm' })
          if (!blob.size) reject(new Error('录制结果为空，请重试'))
          else resolve(blob)
        }
        var t0 = performance.now()
        var stopped = false
        function frame() {
          var t = (performance.now() - t0) / 1000
          drawMotion(g, params, Math.min(t, duration), 1080, 1920, duration)
          if (onProgress) onProgress(clamp(t / duration, 0, 1))
          if (t < duration) requestAnimationFrame(frame)
          else if (!stopped) { stopped = true; setTimeout(function () { try { rec.stop() } catch (err) {} }, 120) }
        }
        drawMotion(g, params, 0, 1080, 1920, duration)
        rec.start(250)
        requestAnimationFrame(frame)
      })
    }

    function MotionPreview(props) {
      var p = props.params || {}
      var dur = Math.max(0.5, Number(p.duration) || 3)
      var ref = React.useRef(null)
      React.useEffect(function () {
        var canvas = ref.current
        if (!canvas) return
        var g = canvas.getContext('2d')
        var raf = 0
        var t0 = performance.now()
        function loop() {
          var t = ((performance.now() - t0) / 1000) % (dur + 0.4)
          drawMotion(g, p, t, 270, 480, dur)
          raf = requestAnimationFrame(loop)
        }
        loop()
        return function () { cancelAnimationFrame(raf) }
      }, [JSON.stringify(p), dur])
      return h('canvas', { ref: ref, className: 'oc-motion', width: 270, height: 480, 'aria-label': '动效预览' })
    }

    // ---------------------------------------------------------- small parts
    function StatusDot(props) {
      return h('span', { className: 'oc-dot oc-dot-' + (props.status || 'idle'), title: props.title || props.status })
    }

    function Progress(props) {
      return h('div', { className: 'oc-progress' },
        h('div', { className: 'oc-progress-bar', style: { width: Math.round(clamp(props.value, 0, 100)) + '%' } }))
    }

    function Field(props) {
      return h('label', { className: 'oc-field' },
        h('span', { className: 'oc-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'oc-hint' }, props.hint) : null)
    }

    function IconButton(props) {
      return h('button', {
        type: 'button', className: 'oc-iconbtn' + (props.active ? ' is-active' : ''), title: props.title,
        onClick: props.onClick, disabled: props.disabled,
      }, props.children)
    }

    // ------------------------------------------------------------- dialog
    // window.prompt/confirm are not implemented by Electron's renderer, so the
    // panel uses its own input/confirm sheet for every "ask the user" step.
    function Dialog(props) {
      var st = props.state || {}
      var [value, setValue] = React.useState(st.value || '')
      var inputRef = React.useRef(null)
      React.useEffect(function () {
        setValue(st.value || '')
        if (st.kind === 'input' && inputRef.current) {
          inputRef.current.focus()
          try { inputRef.current.select() } catch (e) {}
        }
      }, [st])
      function submit() {
        if (st.kind === 'input') {
          var v = String(value || '').trim()
          if (!v && st.required !== false) { return }
          props.onSubmit(v)
        } else {
          props.onSubmit(true)
        }
      }
      return h('div', { className: 'oc-modal-mask', onPointerDown: function (e) { if (e.target === e.currentTarget) props.onClose() } },
        h('div', { className: 'oc-modal oc-modal-sm', onPointerDown: function (e) { e.stopPropagation() } },
          h('div', { className: 'oc-modal-head' },
            h('div', { className: 'oc-modal-title' }, st.title || '提示'),
            h('button', { type: 'button', className: 'oc-btn', onClick: props.onClose }, '关闭')),
          h('div', { className: 'oc-modal-body' },
            st.text ? h('div', { className: 'oc-hint' }, st.text) : null,
            st.kind === 'input' ? h(Field, { label: st.label || '内容', hint: st.hint },
              h('input', {
                ref: inputRef, className: 'oc-input', value: value, placeholder: st.placeholder || '',
                onChange: function (e) { setValue(e.target.value) },
                onKeyDown: function (e) {
                  if (e.key === 'Enter') { e.preventDefault(); submit() }
                  else if (e.key === 'Escape') { e.preventDefault(); props.onClose() }
                },
              })) : null),
          h('div', { className: 'oc-modal-foot' },
            h('button', { type: 'button', className: 'oc-btn', onClick: props.onClose }, '取消'),
            h('button', { type: 'button', className: 'oc-btn ' + (st.danger ? 'oc-btn-danger' : 'oc-btn-primary'), onClick: submit }, st.okText || '确定'))))
    }

    // ------------------------------------------------------------ canvas node
    function CanvasNode(props) {
      var node = props.node
      var meta = KINDS[node.kind] || KINDS.script
      var selected = props.selected
      var job = props.job && props.job.status === 'running' ? props.job : null
      var asset = firstAsset(node, node.kind === 'audio' ? 'audio' : node.kind === 'srt' ? 'srt' : 'video')
      var busy = Boolean(job) || node.status === 'running'
      var progress = job ? job.progress : (node.status === 'running' ? 8 : 0)
      var message = job ? job.message : (node.status === 'running' ? '生成中…' : '')

      function onHeaderDown(e) {
        if (e.button !== 0) return
        if (props.isWiring && props.isWiring()) return
        if (e.target.closest('button, a, input, select, textarea, label')) return
        e.stopPropagation()
        props.onSelect(node.id)
        var sx = e.clientX, sy = e.clientY
        var ox = node.x, oy = node.y
        var moved = false
        function move(ev) {
          var dx = (ev.clientX - sx) / props.zoom
          var dy = (ev.clientY - sy) / props.zoom
          if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return
          moved = true
          props.onMove(node.id, Math.round(ox + dx), Math.round(oy + dy))
        }
        function up() {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          if (moved) props.onMoveEnd()
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      var body = null
      if (node.kind === 'script') {
        var text = node.text || (props.project.script && props.project.script.text) || ''
        var sentCount = props.project.script && props.project.script.sentences ? props.project.script.sentences.length : 0
        var cueCount = props.project.srt && props.project.srt.cues ? props.project.srt.cues.length : 0
        body = h('div', { className: 'oc-nodebody' },
          h('textarea', {
            className: 'oc-input oc-textarea oc-script-edit',
            rows: 7,
            value: text,
            placeholder: '粘贴或手写口播稿，点下方「分镜」按句号 / 问号 / 感叹号自动分句…',
            onPointerDown: function (e) { e.stopPropagation() },
            onChange: function (e) { props.onEditText(node.id, e.target.value) },
          }),
          h('div', { className: 'oc-mini-row' },
            h('span', { className: 'oc-chip' }, sentCount + ' 句'),
            h('span', { className: 'oc-chip' }, cueCount + ' 条字幕'),
            sentCount && cueCount !== sentCount ? h('span', { className: 'oc-chip oc-chip-warn' }, '字幕需重排') : null))
      } else if (node.kind === 'audio') {
        body = h('div', { className: 'oc-nodebody' },
          h('div', { className: 'oc-sub' }, nodeSentences(node).length ? sentenceLabel(node) : '整段配音'),
          asset ? h('audio', { src: fileUrl(asset.rel), controls: true, preload: 'metadata', className: 'oc-audio' }) : h('div', { className: 'oc-empty' }, '还没有音频'),
          asset && asset.duration ? h('div', { className: 'oc-chip' }, fmtSec(asset.duration)) : null)
      } else if (node.kind === 'srt') {
        var cues = (props.project.srt && props.project.srt.cues) || []
        body = h('div', { className: 'oc-nodebody' },
          h('div', { className: 'oc-sub' }, cues.length + ' 条 · ' + fmtSec(cues.length ? cues[cues.length - 1].end : 0)),
          cues.length ? h('div', { className: 'oc-cues' }, cues.slice(0, 4).map(function (c, i) {
            return h('div', { className: 'oc-cue', key: 'c' + i },
              h('span', { className: 'oc-cue-t' }, fmtClock(c.start) + '–' + fmtClock(c.end)),
              h('span', { className: 'oc-cue-x' }, short(c.text, 20)))
          })) : h('div', { className: 'oc-empty' }, props.project.srt && props.project.srt.stale ? '句子已重排，点「生成字幕」按新分镜重建时间轴' : '还没有字幕时间轴'),
          cues.length && props.project.script && props.project.script.sentences && cues.length !== props.project.script.sentences.length
            ? h('div', { className: 'oc-chip oc-chip-warn' }, '句子数已变，需重新生成') : null,
          asset ? h('a', { className: 'oc-link', href: API + '/projects/' + props.project.id + '/srt', download: 'subtitles.srt' }, '下载 SRT') : null)
      } else if (node.kind === 'storyboard') {
        var bCues = ((props.project.srt && props.project.srt.cues) || []).slice().sort(function (x, y) { return Number(x.start) - Number(y.start) })
        var pickedCount = props.picked ? Object.keys(props.picked).length : 0
        body = h('div', { className: 'oc-nodebody' },
          h('div', { className: 'oc-sub' }, bCues.length ? bCues.length + ' 句 · ' + fmtSec(bCues[bCues.length - 1].end) : '还没有字幕时间轴'),
          bCues.length ? h('div', { className: 'oc-sb-list' }, bCues.map(function (c, i) {
            var has = (props.project.nodes || []).some(function (n) {
              return ['dhvideo', 'motion', 'screen', 'audio'].indexOf(n.kind) >= 0 && nodeSentences(n).indexOf(Number(c.sentence != null ? c.sentence : i)) >= 0
            })
            var sidx = Number(c.sentence != null ? c.sentence : i)
            var picked = !!(props.picked && props.picked[sidx])
            return h('div', { className: 'oc-sb-row' + (has ? ' has' : '') + (picked ? ' picked' : ''), key: 'sb' + i },
              h('input', {
                type: 'checkbox', className: 'oc-sb-check',
                checked: picked,
                title: '勾选这句（可多选），再点任意一句的 + 让它们共用一个新节点',
                onPointerDown: function (e) { e.stopPropagation() },
                onChange: function () { props.onToggleSentence(sidx) },
              }),
              h('span', { className: 'oc-sb-idx' }, i + 1),
              h('span', { className: 'oc-sb-t' }, fmtClock(c.start) + '–' + fmtClock(c.end)),
              h('input', {
                className: 'oc-sb-input',
                value: c.text || '',
                title: '直接改这句字幕（同时更新口播稿分句）',
                onPointerDown: function (e) { e.stopPropagation() },
                onChange: function (e) { props.onEditCue(i, e.target.value) },
              }),
              h('button', {
                type: 'button', className: 'oc-mini oc-sb-plus', title: '给这句（或勾选的几句）新建素材节点',
                onPointerDown: function (e) { e.stopPropagation() },
                onClick: function (e) { e.stopPropagation(); props.onRowPlus(sidx) },
              }, '+'))
          })) : h('div', { className: 'oc-empty' }, props.project.srt && props.project.srt.stale ? '句子已重排，点「字幕 SRT」的「生成字幕」重建时间轴' : '还没有字幕时间轴'),
          pickedCount ? h('div', { className: 'oc-sb-bar' },
            h('span', { className: 'oc-sb-bar-count' }, '已选 ' + pickedCount + ' 句'),
            h('button', { type: 'button', className: 'oc-btn oc-btn-accent', onClick: function (e) { e.stopPropagation(); props.onBuildPicked() } }, '建节点'),
            h('button', { type: 'button', className: 'oc-btn', onClick: function (e) { e.stopPropagation(); props.onClearPicked() } }, '清空')) : null)
      } else if (node.kind === 'motion') {
        var mp = Object.assign({}, node.params || {}, { title: node.params && node.params.title ? node.params.title : sentenceOf(props.project, nodeSentences(node)[0]) })
        body = h('div', { className: 'oc-nodebody' },
          h('div', { className: 'oc-sub' }, nodeSentences(node).length ? sentenceLabel(node) + ' · ' + (mp.template || 'kinetic') : '无句子'),
          asset ? h('video', { src: fileUrl(asset.rel), controls: true, preload: 'metadata', className: 'oc-video' }) : h(MotionPreview, { params: mp }))
      } else if (node.kind === 'reference') {
        var refs = (node.assets || []).filter(function (a) { return a.kind === 'image' || a.kind === 'video' })
        body = h('div', { className: 'oc-nodebody' },
          h('div', { className: 'oc-sub' }, refs.length ? refs.length + ' 个参考素材' : '上传图片或视频作为参考'),
          refs.length ? h('div', { className: 'oc-refs' }, refs.slice(0, 4).map(function (a) {
            return a.kind === 'image'
              ? h('img', { key: a.id, className: 'oc-ref-img', src: fileUrl(a.rel), alt: a.name || '' })
              : h('video', { key: a.id, className: 'oc-ref-vid', src: fileUrl(a.rel), controls: true, preload: 'metadata' })
          })) : null,
          node.params && node.params.note ? h('div', { className: 'oc-hint' }, node.params.note) : null,
          h('label', { className: 'oc-btn oc-btn-accent oc-upload' }, '上传图片 / 视频',
            h('input', {
              type: 'file', accept: 'image/*,video/*', multiple: true, style: { display: 'none' },
              onChange: function (e) { props.onUploadFiles(node, e.target.files) },
            })))
      } else if (node.kind === 'compose') {
        body = h('div', { className: 'oc-nodebody' },
          h('div', { className: 'oc-sub' }, '按 SRT 时间轴逐句合成'),
          asset ? h('video', { src: fileUrl(asset.rel), controls: true, preload: 'metadata', className: 'oc-video' }) : h('div', { className: 'oc-empty' }, '还没有成片。检查器里点「合成成片」。'))
      } else {
        body = h('div', { className: 'oc-nodebody' },
          h('div', { className: 'oc-sub' }, node.kind === 'screen' ? (nodeSentences(node).length ? sentenceLabel(node) : '未指定句子') : ''),
          asset ? h('video', { src: fileUrl(asset.rel), controls: true, preload: 'metadata', className: 'oc-video' })
            : h('div', { className: 'oc-empty' }, node.kind === 'screen' ? '导入软件实录视频素材' : '还没有视频'))
      }

      // Long-press (320ms) anywhere on the card starts a connection: drag to
      // another node to wire them. A normal drag cancels the timer.
      function onCardDown(e) {
        if (e.button !== 0) return
        if (e.target.closest('button, a, input, select, textarea, label')) return
        var sx = e.clientX, sy = e.clientY, fired = false
        var timer = setTimeout(function () {
          fired = true
          props.onWireStart(node.id, sx, sy)
        }, 320)
        function move(ev) {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) { clearTimeout(timer); cleanup() }
        }
        function up() { clearTimeout(timer); cleanup() }
        function cleanup() {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          if (fired) props.onSelect(node.id)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      return h('div', {
        className: 'oc-node' + (selected ? ' is-selected' : '') + (busy ? ' is-busy' : '') + (props.wiringFrom === node.id ? ' is-wiring' : ''),
        style: { left: node.x, top: node.y, width: node.w || meta.w, borderTopColor: meta.color },
        'data-node-id': node.id,
        onPointerDown: function (e) { e.stopPropagation(); if (!selected) props.onSelect(node.id); onCardDown(e) },
        onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); props.onNodeMenu(node, e.clientX, e.clientY) },
      },
        h('div', { className: 'oc-nodehead', onPointerDown: onHeaderDown },
          h('span', { className: 'oc-kind', style: { background: meta.color } }, meta.short),
          h('span', { className: 'oc-title' }, node.title || meta.label),
          h('span', { className: 'oc-headright' },
            nodeSentences(node).length ? h('span', { className: 'oc-badge' }, '#' + (nodeSentences(node).length === 1 ? (nodeSentences(node)[0] + 1) : (nodeSentences(node).length + '句'))) : null,
            h(StatusDot, { status: node.status }))),
        body,
        busy ? h('div', { className: 'oc-busy' },
          h(Progress, { value: progress }),
          h('div', { className: 'oc-busy-msg' }, message || '处理中…')) : null,
        h('div', { className: 'oc-nodefoot' },
          h('button', { type: 'button', className: 'oc-btn oc-btn-primary', disabled: busy, onClick: function (e) { e.stopPropagation(); props.onGenerate(node) } },
            busy ? '生成中…' : (node.kind === 'motion' ? '设计动效' : meta.verb)),
          node.kind === 'script'
            ? h('button', { type: 'button', className: 'oc-btn oc-btn-accent', disabled: busy, title: '按标点把正文切成一句话一个分镜', onClick: function (e) { e.stopPropagation(); props.onStoryboard(node) } }, '分镜')
            : null,
          h('button', { type: 'button', className: 'oc-btn', onClick: function (e) { e.stopPropagation(); props.onSelect(node.id); props.onOpenInspector() } }, '编辑')),
        node.error ? h('div', { className: 'oc-error' }, node.error) : null)
    }

    // ---------------------------------------------------------------- inspector
    function Inspector(props) {
      var project = props.project
      var node = props.node
      if (!node) return null
      var meta = KINDS[node.kind] || KINDS.script
      var entries = sentenceEntries(project)
      var modelKind = node.kind === 'motion' ? null : meta.model
      var models = props.models || []
      var defaults = props.defaults || {}
      var job = props.job
      var busy = job && job.status === 'running'
      var [prompt, setPrompt] = React.useState((node.params && node.params.prompt) || '')
      var [scriptText, setScriptText] = React.useState((project.script && project.script.text) || '')
      var [audioText, setAudioText] = React.useState('')
      var [mode, setMode] = React.useState((node.params && node.params.mode) || 'auto')
      var [rawText, setRawText] = React.useState('')
      var [totalDuration, setTotalDuration] = React.useState(String((node.params && node.params.totalDuration) || ''))
      var [motion, setMotion] = React.useState(Object.assign({ template: 'kinetic', subtitle: '', color1: '#4f7cff', color2: '#9b5cff', textColor: '#ffffff', fontSize: 72 }, node.params || {}))
      var [duration, setDuration] = React.useState(String(node.params && node.params.duration ? node.params.duration : ''))
      var [chatText, setChatText] = React.useState('')
      var [chatBusy, setChatBusy] = React.useState(false)

      React.useEffect(function () {
        setPrompt((node.params && node.params.prompt) || '')
        setScriptText((project.script && project.script.text) || '')
        setMode((node.params && node.params.mode) || 'auto')
        setTotalDuration(String((node.params && node.params.totalDuration) || ''))
        setMotion(Object.assign({ template: 'kinetic', subtitle: '', color1: '#4f7cff', color2: '#9b5cff', textColor: '#ffffff', fontSize: 72 }, node.params || {}))
        setAudioText('')
      }, [node.id])

      function patch(patchObj) { props.onPatch(node.id, patchObj) }

      function modelSelect(kinds) {
        var list = models.filter(function (m) { return kinds.indexOf(m.kind) >= 0 })
        var value = node.modelId || ''
        return h('select', {
          className: 'oc-input', value: value,
          onChange: function (e) { patch({ modelId: e.target.value || null }) },
        },
          h('option', { value: '' }, '默认' + (defaults[kinds[0]] ? '：' + ((models.filter(function (m) { return m.id === defaults[kinds[0]] })[0] || {}).name || '已设') : '')),
          list.map(function (m) { return h('option', { key: m.id, value: m.id }, m.name + (m.enabled === false ? '（停用）' : '')) }))
      }

      var head = h('div', { className: 'oc-insp-head' },
        h('div', { className: 'oc-insp-title' },
          h('span', { className: 'oc-kind', style: { background: meta.color } }, meta.short),
          h('span', null, node.title || meta.label)),
        h(IconButton, { title: '关闭', onClick: props.onClose }, '✕'))

      var common = [
        h(Field, { key: 'title', label: '标题' },
          h('input', { className: 'oc-input', value: node.title || '', onChange: function (e) { patch({ title: e.target.value }) } })),
      ]

      if (meta.sentence) {
        common.push(h(Field, { key: 'sentence', label: '对应句子', hint: '多句共用一个镜头：在左侧勾选多句后点任意一句的「+」。' },
          h('select', {
            className: 'oc-input',
            value: nodeSentences(node).length === 1 ? String(nodeSentences(node)[0]) : (nodeSentences(node).length ? 'multi' : ''),
            onChange: function (e) {
              var v = e.target.value
              if (v === '' || v === 'multi') patch({ sentenceIndex: null, sentences: v === 'multi' ? nodeSentences(node) : [] })
              else patch({ sentenceIndex: Number(v), sentences: [Number(v)] })
            },
          },
            node.kind === 'audio' ? h('option', { value: '' }, '整段音频') : h('option', { value: '' }, '未指定'),
            nodeSentences(node).length > 1 ? h('option', { value: 'multi' }, '已选 ' + nodeSentences(node).length + ' 句') : null,
            entries.map(function (s) {
              return h('option', { key: 's' + s.index, value: String(s.index) }, '第' + s.order + '句 · ' + short(s.text, 24))
            }))))
      }

      if (modelKind) {
        common.push(h(Field, { key: 'model', label: '使用模型', hint: '每个节点可以单独挑模型；默认来自「模型配置」。' },
          h('div', { className: 'oc-row' },
            modelSelect(node.kind === 'motion' ? ['text', 'motion'] : [modelKind]),
            h('button', { type: 'button', className: 'oc-btn oc-btn-ghost', onClick: props.onOpenModels }, '配置'))))
      }

      var specific = []
      if (node.kind === 'storyboard') {
        var sbCues = ((project.srt && project.srt.cues) || []).slice().sort(function (u, v) { return Number(u.start) - Number(v.start) })
        specific.push(h('div', { key: 'sbhint', className: 'oc-hint' },
          '由「字幕 SRT」衍生：每行一句，带时间戳。改文字会同步口播稿分句；合成仍按这些时间戳切画面。'))
        specific.push(h('div', { key: 'sblist', className: 'oc-sb-insp' }, sbCues.length ? sbCues.map(function (c, i) {
          return h('div', { key: 'sb' + i, className: 'oc-sb-insp-row' },
            h('span', { className: 'oc-sb-idx' }, i + 1),
            h('span', { className: 'oc-sb-t' }, fmtClock(c.start) + '–' + fmtClock(c.end)),
            h('input', {
              className: 'oc-input', value: c.text || '',
              onChange: function (e) { props.onEditCue(i, e.target.value) },
            }))
        }) : h('div', { className: 'oc-empty' }, '还没有字幕时间轴：先在「字幕 SRT」节点生成。')))
      } else if (node.kind === 'script') {
        specific.push(h(Field, { key: 'prompt', label: '主题 / 提示词', hint: '生成后会按句子切分，供每句建节点。' },
          h('textarea', { className: 'oc-input oc-textarea', rows: 3, value: prompt, onChange: function (e) { setPrompt(e.target.value) }, placeholder: '例如：三分钟讲清楚为什么你总是睡不够' })))
        specific.push(h(Field, { key: 'manual', label: '手写口播稿', hint: '编辑正文后点「分镜」，句子会按句号 / 问号 / 感叹号重新切分。' },
          h('textarea', { className: 'oc-input oc-textarea', rows: 8, value: scriptText, placeholder: '在这里手写口播稿正文，按句号、问号、感叹号自动分句…', onChange: function (e) { setScriptText(e.target.value) } })))
        specific.push(h('div', { key: 'act', className: 'oc-actions' },
          h('button', { type: 'button', className: 'oc-btn oc-btn-primary', disabled: busy, onClick: function () { props.onGenerate(node, { prompt: prompt }) } }, 'AI 生成口播稿'),
          h('button', { type: 'button', className: 'oc-btn oc-btn-accent', onClick: function () { props.onApplyScript(scriptText, node.id) } }, '分镜')))
      } else if (node.kind === 'audio') {
        specific.push(h(Field, { key: 'atext', label: '本句文字', hint: '留空则使用口播稿里这句的原文。' },
          h('textarea', { className: 'oc-input oc-textarea', rows: 3, value: audioText, placeholder: short(sentenceOf(project, node.sentenceIndex), 80), onChange: function (e) { setAudioText(e.target.value) } })))
        specific.push(h('div', { key: 'act', className: 'oc-actions' },
          h('button', { type: 'button', className: 'oc-btn oc-btn-primary', disabled: busy, onClick: function () { props.onGenerate(node, { text: audioText }) } }, '合成配音'),
          h('label', { className: 'oc-btn oc-btn-ghost' }, '导入音频',
            h('input', { type: 'file', accept: 'audio/*', style: { display: 'none' }, onChange: function (e) { props.onUpload(node, e.target.files && e.target.files[0]) } }))))
      } else if (node.kind === 'srt') {
        specific.push(h(Field, { key: 'mode', label: '产生方式' },
          h('select', { className: 'oc-input', value: mode, onChange: function (e) { setMode(e.target.value) } },
            h('option', { value: 'auto' }, '自动对齐（按逐句音频 / 字数比例）'),
            h('option', { value: 'asr' }, 'Whisper 识别整段音频'),
            h('option', { value: 'paste' }, '粘贴现成 SRT'))))
        if (mode === 'auto') {
          specific.push(h(Field, { key: 'total', label: '总时长（秒，可选）', hint: '没有逐句音频、也没有整段音频时用它按字数分配时间。' },
            h('input', { className: 'oc-input', value: totalDuration, onChange: function (e) { setTotalDuration(e.target.value) }, placeholder: '例如 45' })))
        }
        if (mode === 'paste') {
          specific.push(h(Field, { key: 'raw', label: 'SRT 内容' },
            h('textarea', { className: 'oc-input oc-textarea oc-mono', rows: 8, value: rawText, onChange: function (e) { setRawText(e.target.value) }, placeholder: '1\n00:00:00,000 --> 00:00:03,200\n第一句…' })))
        }
        specific.push(h('div', { key: 'act', className: 'oc-actions' },
          h('button', {
            type: 'button', className: 'oc-btn oc-btn-primary', disabled: busy,
            onClick: function () { props.onGenerate(node, { mode: mode, rawText: rawText, totalDuration: totalDuration ? Number(totalDuration) : null }) },
          }, '生成字幕')))
        var cues = (project.srt && project.srt.cues) || []
        if (cues.length) {
          specific.push(h('div', { key: 'cues', className: 'oc-actions' },
            h('a', { className: 'oc-btn', href: API + '/projects/' + project.id + '/srt', download: 'subtitles.srt' }, '下载 SRT')))
        }
      } else if (node.kind === 'dhvideo') {
        specific.push(h(Field, { key: 'dur', label: '时长（秒）', hint: '默认取这句在 SRT 里的时长。' },
          h('input', { className: 'oc-input', value: duration, onChange: function (e) { setDuration(e.target.value) }, placeholder: String(sentenceSpan(project, node.sentenceIndex) || 3) })))
        specific.push(h('div', { key: 'act', className: 'oc-actions' },
          h('button', { type: 'button', className: 'oc-btn oc-btn-primary', disabled: busy, onClick: function () { props.onGenerate(node, { duration: duration ? Number(duration) : null }) } }, '用模型生成'),
          h('label', { className: 'oc-btn oc-btn-ghost' }, '导入视频',
            h('input', { type: 'file', accept: 'video/*', style: { display: 'none' }, onChange: function (e) { props.onUpload(node, e.target.files && e.target.files[0]) } }))))
      } else if (node.kind === 'motion') {
        specific.push(h(Field, { key: 'tpl', label: '模板' },
          h('select', { className: 'oc-input', value: motion.template, onChange: function (e) { setMotion(Object.assign({}, motion, { template: e.target.value })) } },
            TEMPLATES.map(function (t) { return h('option', { key: t.id, value: t.id }, t.label) }))))
        specific.push(h(Field, { key: 'sub', label: '副标题（可选）' },
          h('input', { className: 'oc-input', value: motion.subtitle || '', onChange: function (e) { setMotion(Object.assign({}, motion, { subtitle: e.target.value })) } })))
        specific.push(h('div', { key: 'colors', className: 'oc-row' },
          h(Field, { label: '主色' }, h('input', { type: 'color', className: 'oc-color', value: motion.color1 || '#4f7cff', onChange: function (e) { setMotion(Object.assign({}, motion, { color1: e.target.value })) } })),
          h(Field, { label: '辅色' }, h('input', { type: 'color', className: 'oc-color', value: motion.color2 || '#9b5cff', onChange: function (e) { setMotion(Object.assign({}, motion, { color2: e.target.value })) } })),
          h(Field, { label: '文字' }, h('input', { type: 'color', className: 'oc-color', value: motion.textColor || '#ffffff', onChange: function (e) { setMotion(Object.assign({}, motion, { textColor: e.target.value })) } }))))
        specific.push(h(Field, { key: 'fs', label: '字号', hint: '1080 宽下的像素字号（40–120）。' },
          h('input', {
            type: 'number', className: 'oc-input', value: motion.fontSize || 72, min: 24, max: 180,
            onChange: function (e) { setMotion(Object.assign({}, motion, { fontSize: Number(e.target.value) || 72 })) },
          })))
        specific.push(h(Field, { key: 'mdur', label: '时长（秒）' },
          h('input', { className: 'oc-input', value: duration || String(sentenceSpan(project, node.sentenceIndex) || 3), onChange: function (e) { setDuration(e.target.value) } })))
        specific.push(h('label', { key: 'autorec', className: 'oc-checkline' },
          h('input', {
            type: 'checkbox', checked: motion.autoRecord !== false,
            onChange: function (e) { setMotion(Object.assign({}, motion, { autoRecord: e.target.checked })) },
          }),
          h('span', null, '设计完成后自动录制成视频（直接参与合成）')))
        var previewParams = Object.assign({}, motion, {
          title: motion.title || sentenceOf(project, node.sentenceIndex),
          duration: Number(duration) || sentenceSpan(project, node.sentenceIndex) || 3,
        })
        specific.push(h('div', { key: 'preview', className: 'oc-preview-wrap' }, h(MotionPreview, { params: previewParams })))
        specific.push(h('div', { key: 'act', className: 'oc-actions' },
          h('button', {
            type: 'button', className: 'oc-btn oc-btn-primary', disabled: busy || Boolean(props.recording),
            onClick: function () {
              var nextParams = Object.assign({}, node.params, motion, { title: previewParams.title, duration: previewParams.duration })
              patch({ params: nextParams })
              props.onGenerate(node, { text: previewParams.title, duration: previewParams.duration, params: nextParams })
            },
          }, '设计动效参数'),
          h('button', {
            type: 'button', className: 'oc-btn', disabled: busy || Boolean(props.recording),
            onClick: function () {
              patch({ params: Object.assign({}, node.params, motion, { title: previewParams.title, duration: previewParams.duration }) })
              props.onRecordMotion(node, previewParams)
            },
          }, props.recording && props.recording.nodeId === node.id ? '录制中 ' + Math.round((props.recording.progress || 0) * 100) + '%' : '录制成视频')))
      } else if (node.kind === 'screen') {
        specific.push(h('div', { key: 'act', className: 'oc-actions' },
          h('label', { className: 'oc-btn oc-btn-primary' }, '导入实录视频',
            h('input', { type: 'file', accept: 'video/*', style: { display: 'none' }, onChange: function (e) { props.onUpload(node, e.target.files && e.target.files[0]) } })),
          h('button', { type: 'button', className: 'oc-btn', onClick: function () { props.onImportPath(node) } }, '从本机路径导入')))
        specific.push(h('div', { key: 'note', className: 'oc-hint' }, '合成时按这句的时间戳自动裁剪 / 循环。'))
      } else if (node.kind === 'compose') {
        var cues2 = (project.srt && project.srt.cues) || []
        specific.push(h('div', { key: 'sum', className: 'oc-mini-row' },
          h('span', { className: 'oc-chip' }, cues2.length + ' 句'),
          h('span', { className: 'oc-chip' }, (project.settings && project.settings.size) || '1080x1920'),
          h('span', { className: 'oc-chip' }, ((project.settings && project.settings.fps) || 30) + 'fps'),
          h('span', { className: 'oc-chip' }, project.settings && project.settings.burnSubtitles !== false ? '烧字幕' : '不烧字幕')))
        specific.push(h('div', { key: 'scenes', className: 'oc-scenes' }, cues2.slice(0, 30).map(function (c, i) {
          var pick = pickMaterial(project, c.sentence != null ? c.sentence : i)
          return h('div', { className: 'oc-scene', key: 'sc' + i },
            h('span', { className: 'oc-scene-i' }, i + 1),
            h('span', { className: 'oc-scene-t' }, fmtClock(c.start) + '–' + fmtClock(c.end)),
            h('span', { className: 'oc-scene-x' }, pick ? pick.node.title : '空镜'))
        })))
        specific.push(h('div', { key: 'act', className: 'oc-actions' },
          h('button', { type: 'button', className: 'oc-btn oc-btn-primary', disabled: busy || !cues2.length, onClick: function () { props.onGenerate(node, {}) } }, '合成成片'),
          h('button', { type: 'button', className: 'oc-btn', onClick: props.onOpenSettings }, '项目设置')))
      }

      var assets = (node.assets || []).filter(function (a) { return a.kind === 'video' || a.kind === 'audio' || a.kind === 'image' })

      if (node.kind === 'reference') {
        var refs = (node.assets || []).filter(function (a) { return a.kind === 'image' || a.kind === 'video' })
        specific.push(h('div', { key: 'refs', className: 'oc-sec' },
          h('div', { className: 'oc-sec-title' }, '参考素材'),
          h('div', { className: 'oc-hint' }, '图片或视频都行，用来给动效 / 数字人 / 实拍镜头做参考。'),
          h('label', { className: 'oc-btn oc-btn-accent oc-upload' }, '上传图片 / 视频',
            h('input', {
              type: 'file', accept: 'image/*,video/*', multiple: true, style: { display: 'none' },
              onChange: function (e) { props.onUploadFiles(node, e.target.files) },
            })),
          refs.length ? h('div', { className: 'oc-refs' }, refs.map(function (a) {
            return a.kind === 'image'
              ? h('img', { key: a.id, className: 'oc-ref-img', src: fileUrl(a.rel), alt: a.name || '' })
              : h('video', { key: a.id, className: 'oc-ref-vid', src: fileUrl(a.rel), controls: true, preload: 'metadata' })
          })) : h('div', { className: 'oc-empty' }, '还没有参考素材')))
      }

      if (['motion', 'dhvideo', 'screen', 'reference'].indexOf(node.kind) >= 0) {
        var chat = node.chat || []
        var chatHint = node.kind === 'motion'
          ? '直接说要什么画面：标题、配色、节奏、字幕位置，智能体会回填参数。'
          : node.kind === 'dhvideo'
            ? '描述数字人的动作、口型、景别，智能体会写成生成提示词。'
            : node.kind === 'screen'
              ? '描述这段实录要拍什么、镜头怎么走，智能体会写成拍摄要点。'
              : '说说这条参考最值得复用的地方，智能体会记成提示。'
        specific.push(h('div', { key: 'chat', className: 'oc-chat' },
          h('div', { className: 'oc-sec-title' }, '智能体对话'),
          h('div', { className: 'oc-hint' }, chatHint),
          chat.length ? h('div', { className: 'oc-chat-list' }, chat.slice(-8).map(function (m, i) {
            return h('div', { key: 'm' + i, className: 'oc-chat-msg ' + (m.role === 'user' ? 'is-user' : 'is-bot') }, String(m.text || ''))
          })) : null,
          h('textarea', {
            className: 'oc-input oc-textarea', rows: 3, value: chatText,
            placeholder: node.kind === 'motion' ? '比如：标题换成「三句话讲完 GitHub」，蓝紫渐变，字再大一点' : '说说这个节点要什么效果…',
            onChange: function (e) { setChatText(e.target.value) },
          }),
          h('div', { className: 'oc-actions' },
            h('button', {
              type: 'button', className: 'oc-btn oc-btn-primary',
              disabled: chatBusy || !chatText.trim(),
              onClick: function () {
                var t = chatText.trim()
                if (!t) return
                setChatBusy(true)
                props.onChat(node.id, t)
                  .then(function () { setChatText('') })
                  .catch(function () {})
                  .then(function () { setChatBusy(false) })
              },
            }, chatBusy ? '思考中…' : '发送'))))
      }
      return h('div', { className: 'oc-insp' },
        head,
        h('div', { className: 'oc-insp-body' },
          common,
          specific,
          job ? h('div', { className: 'oc-job' },
            h('div', { className: 'oc-job-line' }, h(StatusDot, { status: job.status }), h('span', null, job.label + ' · ' + job.message)),
            h(Progress, { value: job.progress })) : null,
          node.log ? h('div', { className: 'oc-log' }, node.log) : null,
          node.error ? h('div', { className: 'oc-error' }, node.error) : null,
          assets.length ? h('div', { className: 'oc-assets' }, assets.map(function (a) {
            return h('div', { className: 'oc-asset', key: a.id },
              h('span', { className: 'oc-asset-name' }, a.name),
              h('a', { className: 'oc-link', href: fileUrl(a.rel), download: a.name }, '下载'),
              h('button', { type: 'button', className: 'oc-link oc-link-danger', onClick: function () { props.onDeleteAsset(node, a) } }, '删除'))
          })) : null,
          h('div', { className: 'oc-insp-foot' },
            h('button', {
              type: 'button', className: 'oc-btn oc-btn-danger',
              onClick: function () {
                props.onAsk({
                  kind: 'confirm', title: '删除节点', danger: true, okText: '删除',
                  text: '删除「' + (node.title || meta.label) + '」？该节点的素材记录会一起移除。',
                  onSubmit: function () { props.onDelete(node) },
                })
              },
            }, '删除节点')))
      )
    }

    // ------------------------------------------------------------- add menu
    function AddMenu(props) {
      var project = props.project
      var entries = sentenceEntries(project)
      var state = props.state // {step:'kind'|'sentence', kind, sentenceIndex}
      var meta = state.kind ? KINDS[state.kind] : null
      if (state.step === 'sentence' && meta) {
        // Batch-capable kinds (数字人音频) get checkboxes + 全选 so one visit can
        // create the per-sentence nodes for a whole script.
        if (meta.batch) {
          return h(SentencePicker, {
            entries: entries, meta: meta, kind: state.kind,
            onBack: props.onBack,
            onCreate: function (kind, index) { props.onCreate(kind, index) },
            onBatchCreate: function (kind, list, autoGen) { props.onBatchCreate(kind, list, autoGen) },
          })
        }
        return h('div', { className: 'oc-menu oc-menu-wide' },
          h('div', { className: 'oc-menu-head' },
            h('span', null, '为「' + meta.label + '」选择句子'),
            h('button', { type: 'button', className: 'oc-link', onClick: props.onBack }, '返回')),
          meta.id === 'audio' ? h('button', {
            type: 'button', className: 'oc-menu-item',
            onClick: function () { props.onCreate(state.kind, null) },
          }, h('span', { className: 'oc-menu-idx' }, '整'), h('span', null, '整段音频（不按句）')) : null,
          entries.length ? h('div', { className: 'oc-menu-list' }, entries.map(function (s) {
            return h('button', {
              type: 'button', className: 'oc-menu-item', key: 'e' + s.index,
              onClick: function () { props.onCreate(state.kind, s.index) },
            },
              h('span', { className: 'oc-menu-idx' }, s.order),
              h('span', { className: 'oc-menu-text' }, short(s.text, 34)),
              s.start != null ? h('span', { className: 'oc-menu-time' }, fmtClock(s.start)) : null)
          })) : h('div', { className: 'oc-menu-empty' }, '还没有句子：先在「口播稿」节点生成或手写正文。'))
      }
      var preset = state.sentenceIndex != null ? sentenceEntries(project).filter(function (s) { return s.index === state.sentenceIndex })[0] : null
      var list = (state.multi || []).filter(function (i) { return i != null }).map(Number)
      var multi = list.length > 0
      // Sentences picked in the left panel: only per-sentence kinds make sense.
      var kinds = multi ? KIND_ORDER.filter(function (k) { return KINDS[k].sentence }) : KIND_ORDER.filter(function (k) {
        if (k !== 'storyboard') return true
        return !!props.hasTimeline
      })
      var [multiGen, setMultiGen] = React.useState(false)
      var single = list.length === 1
      var singleEntry = single ? entries.filter(function (s) { return s.index === list[0] })[0] : null
      return h('div', { className: 'oc-menu' },
        h('div', { className: 'oc-menu-head' }, multi
          ? h('span', null, single ? '为第 ' + (singleEntry ? singleEntry.order : list[0] + 1) + ' 句新建节点' : '为选中的 ' + list.length + ' 句新建节点')
          : preset ? h('span', null, '为第 ' + preset.order + ' 句新建节点') : h('span', null, '新建节点')),
        preset ? h('div', { className: 'oc-menu-preset' }, short(preset.text, 48)) : null,
        singleEntry ? h('div', { className: 'oc-menu-preset' }, short(singleEntry.text, 48)) : null,
        kinds.map(function (kind) {
          var m = KINDS[kind]
          return h('button', {
            type: 'button', className: 'oc-menu-item', key: kind,
            onClick: function () {
              if (multi) { props.onBatchCreate(kind, list, multiGen); return }
              if (state.sentenceIndex != null) { props.onCreate(kind, state.sentenceIndex); return }
              if (m.sentence && entries.length) props.onPickSentence(kind)
              else props.onCreate(kind, null)
            },
          },
            h('span', { className: 'oc-kind', style: { background: m.color } }, m.short),
            h('span', { className: 'oc-menu-name' }, m.label),
            m.sentence ? h('span', { className: 'oc-menu-hint' }, multi && !single ? (kind === 'audio' ? '每句一个' : '共用一个镜头') : '按句') : null)
        }),
        multi ? h('div', { className: 'oc-menu-foot' },
          h('label', { className: 'oc-checkline' },
            h('input', { type: 'checkbox', checked: multiGen, onChange: function (e) { setMultiGen(e.target.checked) } }),
            '建好后按顺序生成'),
          h('span', { className: 'oc-dim' }, list.length + ' 个节点')) : null)
    }

    // Multi-select sentence picker for batch-capable kinds (数字人音频): tick
    // several lines at once, optionally generate them one after another.
    function SentencePicker(props) {
      var entries = props.entries || []
      var [picked, setPicked] = React.useState({})
      var [autoGen, setAutoGen] = React.useState(true)
      var count = entries.filter(function (s) { return picked[s.index] }).length
      function toggle(index) {
        setPicked(function (prev) { var n = Object.assign({}, prev); n[index] = !prev[index]; return n })
      }
      function selectAll() {
        var n = {}
        entries.forEach(function (s) { n[s.index] = true })
        setPicked(n)
      }
      function clearAll() { setPicked({}) }
      function submit() {
        var list = entries.filter(function (s) { return picked[s.index] }).map(function (s) { return s.index })
        if (!list.length) return
        props.onBatchCreate(props.kind, list, autoGen)
      }
      return h('div', { className: 'oc-menu oc-menu-wide' },
        h('div', { className: 'oc-menu-head' },
          h('span', null, '为「' + props.meta.label + '」选择句子'),
          h('div', { className: 'oc-menu-actions' },
            h('button', { type: 'button', className: 'oc-link', onClick: selectAll }, '全选'),
            h('button', { type: 'button', className: 'oc-link', onClick: clearAll }, '清空'),
            h('button', { type: 'button', className: 'oc-link', onClick: props.onBack }, '返回'))),
        h('button', {
          type: 'button', className: 'oc-menu-item',
          onClick: function () { props.onCreate(props.kind, null) },
        }, h('span', { className: 'oc-menu-idx' }, '整'), h('span', null, '整段音频（不按句）')),
        entries.length ? h('div', { className: 'oc-menu-list' }, entries.map(function (s) {
          var on = !!picked[s.index]
          return h('label', { className: 'oc-menu-item oc-menu-check' + (on ? ' on' : ''), key: 'e' + s.index },
            h('input', { type: 'checkbox', checked: on, onChange: function () { toggle(s.index) } }),
            h('span', { className: 'oc-menu-idx' }, s.order),
            h('span', { className: 'oc-menu-text' }, short(s.text, 34)),
            s.start != null ? h('span', { className: 'oc-menu-time' }, fmtClock(s.start)) : null)
        })) : h('div', { className: 'oc-menu-empty' }, '还没有句子：先在「口播稿」节点生成或手写正文。'),
        h('div', { className: 'oc-menu-foot' },
          h('label', { className: 'oc-checkline' },
            h('input', { type: 'checkbox', checked: autoGen, onChange: function (e) { setAutoGen(e.target.checked) } }),
            '创建后按顺序生成'),
          h('button', {
            type: 'button', className: 'oc-btn oc-btn-primary',
            disabled: !count,
            onClick: submit,
          }, count ? '创建 ' + count + ' 个节点' : '勾选句子')))
    }

    // ------------------------------------------------------------ models modal
    function ModelsModal(props) {
      var [models, setModels] = React.useState(function () {
        return (props.models || []).map(function (m) { return Object.assign({}, m) })
      })
      var [defaults, setDefaults] = React.useState(Object.assign({}, props.defaults || {}))
      var [saving, setSaving] = React.useState(false)
      var [testing, setTesting] = React.useState(null)
      var [results, setResults] = React.useState({})
      var [dirty, setDirty] = React.useState(false)

      function updateModel(id, patchObj) {
        setDirty(true)
        setModels(function (prev) { return prev.map(function (m) { return m.id === id ? Object.assign({}, m, patchObj) : m }) })
      }
      function addModel(kind) {
        setDirty(true)
        setModels(function (prev) {
          return prev.concat([{ id: uid('m'), kind: kind || 'text', name: '新模型', provider: kind === 'video' ? 'command' : 'openai', baseUrl: '', model: '', voice: '', command: '', statusUrl: '', apiKey: '', enabled: true }])
        })
      }
      function removeModel(id) {
        setDirty(true)
        setModels(function (prev) { return prev.filter(function (m) { return m.id !== id }) })
        setDefaults(function (prev) {
          var next = Object.assign({}, prev)
          Object.keys(next).forEach(function (k) { if (next[k] === id) delete next[k] })
          return next
        })
      }

      function save() {
        setSaving(true)
        api('/models', { method: 'PUT', body: { models: models, defaults: defaults } })
          .then(function (res) {
            setModels(res.models.map(function (m) { return Object.assign({}, m) }))
            setDefaults(Object.assign({}, res.defaults || {}))
            setDirty(false)
            setSaving(false)
            props.onSaved(res.models, res.defaults || {})
            props.toast('模型配置已保存')
          })
          .catch(function (err) { setSaving(false); props.toast('保存失败：' + err.message, 'error') })
      }

      function test(m) {
        if (dirty) { props.toast('先保存，再测试。'); return }
        setTesting(m.id)
        api('/models/test', { method: 'POST', body: { id: m.id } })
          .then(function (res) {
            setTesting(null)
            setResults(function (prev) { var n = Object.assign({}, prev); n[m.id] = res; return n })
          })
          .catch(function (err) { setTesting(null); setResults(function (prev) { var n = Object.assign({}, prev); n[m.id] = { ok: false, message: err.message }; return n }) })
      }

      return h('div', { className: 'oc-modal-mask', onPointerDown: function (e) { if (e.target === e.currentTarget) props.onClose() } },
        h('div', { className: 'oc-modal oc-modal-lg' },
          h('div', { className: 'oc-modal-head' },
            h('div', null, h('div', { className: 'oc-modal-title' }, '模型配置'), h('div', { className: 'oc-hint' }, '文本 / TTS / ASR 走 OpenAI 兼容接口；数字人视频可用命令模板或 HTTP 接口。密钥只存在本机。')),
            h('button', { type: 'button', className: 'oc-btn', onClick: props.onClose }, '关闭')),
          h('div', { className: 'oc-defaults' }, MODEL_KINDS.map(function (k) {
            var list = models.filter(function (m) { return m.kind === k.id })
            return h('label', { className: 'oc-field oc-field-inline', key: k.id },
              h('span', { className: 'oc-label' }, k.label + '默认'),
              h('select', {
                className: 'oc-input', value: defaults[k.id] || '',
                onChange: function (e) { setDirty(true); setDefaults(Object.assign({}, defaults, { [k.id]: e.target.value || undefined })) },
              },
                h('option', { value: '' }, '（第一个可用）'),
                list.map(function (m) { return h('option', { key: m.id, value: m.id }, m.name) })))
          })),
          h('div', { className: 'oc-models' }, models.map(function (m) {
            var res = results[m.id]
            var provider = m.provider
            return h('div', { className: 'oc-model', key: m.id },
              h('div', { className: 'oc-model-head' },
                h('select', { className: 'oc-input oc-input-sm', value: m.kind, onChange: function (e) { updateModel(m.id, { kind: e.target.value }) } },
                  MODEL_KINDS.map(function (k) { return h('option', { key: k.id, value: k.id }, k.label) })),
                h('input', { className: 'oc-input oc-input-sm', value: m.name, onChange: function (e) { updateModel(m.id, { name: e.target.value }) }, placeholder: '名称' }),
                h('label', { className: 'oc-switch' },
                  h('input', { type: 'checkbox', checked: m.enabled !== false, onChange: function (e) { updateModel(m.id, { enabled: e.target.checked }) } }),
                  h('span', null, '启用')),
                h('button', { type: 'button', className: 'oc-link oc-link-danger', onClick: function () { removeModel(m.id) } }, '删除')),
              h('div', { className: 'oc-model-grid' },
                h(Field, { label: '接入方式' },
                  h('select', { className: 'oc-input', value: provider, onChange: function (e) { updateModel(m.id, { provider: e.target.value }) } },
                    h('option', { value: 'openai' }, 'OpenAI 兼容'),
                    h('option', { value: 'http' }, 'HTTP 视频接口'),
                    h('option', { value: 'command' }, '本机命令'))),
                provider === 'command' ? null : h(Field, { label: provider === 'http' ? '请求地址' : 'Base URL' },
                  h('input', { className: 'oc-input', value: m.baseUrl || '', onChange: function (e) { updateModel(m.id, { baseUrl: e.target.value }) }, placeholder: provider === 'http' ? 'https://…/generate' : 'https://api.deepseek.com/v1' })),
                provider === 'command' ? null : h(Field, { label: '模型名' },
                  h('input', { className: 'oc-input', value: m.model || '', onChange: function (e) { updateModel(m.id, { model: e.target.value }) }, placeholder: m.kind === 'tts' ? 'tts-1' : m.kind === 'asr' ? 'whisper-1' : 'deepseek-chat' })),
                m.kind === 'tts' ? h(Field, { label: '音色 voice' },
                  h('input', { className: 'oc-input', value: m.voice || '', onChange: function (e) { updateModel(m.id, { voice: e.target.value }) }, placeholder: 'alloy' })) : null,
                provider === 'http' ? h(Field, { label: '任务状态地址', hint: '接口返回 task_id 时轮询：支持 {task} 占位符。' },
                  h('input', { className: 'oc-input', value: m.statusUrl || '', onChange: function (e) { updateModel(m.id, { statusUrl: e.target.value }) }, placeholder: 'https://…/tasks/{task}' })) : null,
                provider === 'command' ? h(Field, { label: '命令模板', hint: '占位符：{text} {sentence} {duration} {out} {width} {height} {audio}' },
                  h('textarea', { className: 'oc-input oc-textarea oc-mono', rows: 3, value: m.command || '', onChange: function (e) { updateModel(m.id, { command: e.target.value }) }, placeholder: 'python D:\\tools\\dh.py --text "{text}" --audio "{audio}" --out "{out}"' })) : null,
                provider === 'command' ? null : h(Field, { label: 'API Key', hint: '保存后仅显示首尾，留空表示不修改。' },
                  h('input', { type: 'password', className: 'oc-input', value: m.apiKey || '', onChange: function (e) { updateModel(m.id, { apiKey: e.target.value }) }, placeholder: 'sk-…' }))),
              h('div', { className: 'oc-model-foot' },
                h('button', { type: 'button', className: 'oc-btn oc-btn-ghost', disabled: testing === m.id, onClick: function () { test(m) } }, testing === m.id ? '测试中…' : '测试'),
                res ? h('span', { className: 'oc-test ' + (res.ok ? 'ok' : 'bad') }, (res.ok ? '✓ ' : '✗ ') + (res.message || '')) : null))
          })),
          h('div', { className: 'oc-modal-foot' },
            h('div', { className: 'oc-row' },
              h('button', { type: 'button', className: 'oc-btn', onClick: function () { addModel('text') } }, '+ 文本'),
              h('button', { type: 'button', className: 'oc-btn', onClick: function () { addModel('tts') } }, '+ TTS'),
              h('button', { type: 'button', className: 'oc-btn', onClick: function () { addModel('asr') } }, '+ ASR'),
              h('button', { type: 'button', className: 'oc-btn', onClick: function () { addModel('video') } }, '+ 视频'),
              h('button', { type: 'button', className: 'oc-btn', onClick: function () { addModel('motion') } }, '+ 动效')),
            h('div', { className: 'oc-row' },
              h('button', { type: 'button', className: 'oc-btn oc-btn-primary', disabled: saving || !dirty, onClick: save }, saving ? '保存中…' : (dirty ? '保存配置' : '已保存')),
              h('button', { type: 'button', className: 'oc-btn', onClick: props.onClose }, '完成'))))
      )
    }

    // ---------------------------------------------------------- settings modal
    function SettingsModal(props) {
      var project = props.project
      var [name, setName] = React.useState(project.name)
      var [settings, setSettings] = React.useState(Object.assign({ size: '1080x1920', fps: 30, burnSubtitles: true, materialPriority: ['dhvideo', 'motion', 'screen'] }, project.settings || {}))
      function patchSettings(p) { setSettings(Object.assign({}, settings, p)) }
      function move(kind, dir) {
        var list = settings.materialPriority.slice()
        var i = list.indexOf(kind)
        var j = i + dir
        if (i < 0 || j < 0 || j >= list.length) return
        list[i] = list[j]
        list[j] = kind
        patchSettings({ materialPriority: list })
      }
      return h('div', { className: 'oc-modal-mask', onPointerDown: function (e) { if (e.target === e.currentTarget) props.onClose() } },
        h('div', { className: 'oc-modal' },
          h('div', { className: 'oc-modal-head' },
            h('div', { className: 'oc-modal-title' }, '项目设置'),
            h('button', { type: 'button', className: 'oc-btn', onClick: props.onClose }, '关闭')),
          h('div', { className: 'oc-insp-body' },
            h(Field, { label: '项目名' }, h('input', { className: 'oc-input', value: name, onChange: function (e) { setName(e.target.value) } })),
            h(Field, { label: '画幅' },
              h('select', { className: 'oc-input', value: settings.size, onChange: function (e) { patchSettings({ size: e.target.value }) } },
                SIZES.map(function (s) { return h('option', { key: s.id, value: s.id }, s.label) }))),
            h(Field, { label: '帧率' },
              h('select', { className: 'oc-input', value: String(settings.fps), onChange: function (e) { patchSettings({ fps: Number(e.target.value) }) } },
                [24, 25, 30, 60].map(function (f) { return h('option', { key: f, value: String(f) }, f + ' fps') }))),
            h(Field, { label: '字幕' },
              h('label', { className: 'oc-switch' },
                h('input', { type: 'checkbox', checked: settings.burnSubtitles !== false, onChange: function (e) { patchSettings({ burnSubtitles: e.target.checked }) } }),
                h('span', null, '合成时烧录字幕（微软雅黑，字号≈画面高 5.2%，底边距≈9.4%）'))),
            h(Field, { label: '每句素材优先级', hint: '同一句有多个画面素材时，合成按顺序取第一个。' },
              h('div', { className: 'oc-priority' }, settings.materialPriority.map(function (kind, i) {
                return h('div', { className: 'oc-priority-row', key: kind },
                  h('span', { className: 'oc-kind', style: { background: (KINDS[kind] || {}).color || '#888' } }, (KINDS[kind] || {}).short || '?'),
                  h('span', { className: 'oc-menu-name' }, (KINDS[kind] || {}).label || kind),
                  h('button', { type: 'button', className: 'oc-link', disabled: i === 0, onClick: function () { move(kind, -1) } }, '↑'),
                  h('button', { type: 'button', className: 'oc-link', disabled: i === settings.materialPriority.length - 1, onClick: function () { move(kind, 1) } }, '↓'))
              }))),
            h('div', { className: 'oc-insp-foot' },
              h('button', { type: 'button', className: 'oc-btn oc-btn-danger', onClick: function () { props.onAsk({ kind: 'confirm', title: '删除项目', danger: true, okText: '删除项目', text: '删除「' + project.name + '」？画布、素材与成片记录都会删除。', onSubmit: props.onDeleteProject }) } }, '删除项目'))
          ),
          h('div', { className: 'oc-modal-foot' },
            h('div', {}),
            h('button', {
              type: 'button', className: 'oc-btn oc-btn-primary',
              onClick: function () { props.onSave({ name: name, settings: settings }) },
            }, '保存设置'))
        ))
    }

    // -------------------------------------------------------------------- app
    function App() {
      var [boot, setBoot] = React.useState(null)
      var [pinned, setPinned] = React.useState(isPinned)
      var [bootError, setBootError] = React.useState(null)
      var [project, setProject] = React.useState(null)
      var [loading, setLoading] = React.useState(true)
      var [selectedId, setSelectedId] = React.useState(null)
      var [modelsOpen, setModelsOpen] = React.useState(false)
      var [settingsOpen, setSettingsOpen] = React.useState(false)
      var [menu, setMenu] = React.useState(null)
      var [pickedSentences, setPickedSentences] = React.useState({})
      var [jobs, setJobs] = React.useState({})
      var [batch, setBatch] = React.useState(null)
      var [toasts, setToasts] = React.useState([])
      var [dialog, setDialog] = React.useState(null)
      var [wire, setWire] = React.useState(null)
      var wireRef = React.useRef(null)
      wireRef.current = wire
      var [ctx, setCtx] = React.useState(null)
      var [saveState, setSaveState] = React.useState('saved')
      var [recording, setRecording] = React.useState(null)
      var [showSentences, setShowSentences] = React.useState(function () { return localStorage.getItem(LS_SENTENCES) !== '0' })
      var [models, setModels] = React.useState([])
      var [defaults, setDefaults] = React.useState({})
      var [ffmpeg, setFfmpeg] = React.useState(null)

      var containerRef = React.useRef(null)
      var saveTimer = React.useRef(null)
      var lastSavedJson = React.useRef('')
      var projectRef = React.useRef(null)
      var pollTimers = React.useRef({})
      var importedOnce = React.useRef(false)

      function toast(msg, kind) {
        var id = uid('toast')
        setToasts(function (prev) { return prev.concat([{ id: id, msg: String(msg), kind: kind || 'info' }]) })
        setTimeout(function () { setToasts(function (prev) { return prev.filter(function (t) { return t.id !== id }) }) }, kind === 'error' ? 7000 : 3800)
      }

      function ask(state) { setDialog(state) }

      function loadProjectInto(id, keepSelection) {
        return api('/projects/' + id).then(function (res) {
          var doc = res.project
          var ensured = ensureStoryboard(doc)
          if (ensured && ensured.created) {
            doc = ensured.doc
            lastSavedJson.current = JSON.stringify(res.project)
            setSaveState('dirty')
          } else {
            lastSavedJson.current = JSON.stringify(doc)
            setSaveState('saved')
          }
          setProject(doc)
          localStorage.setItem(LS_ACTIVE, id)
          if (!keepSelection) setSelectedId(null)
          return doc
        })
      }

      function loadBootstrap() {
        return api('/bootstrap').then(function (b) {
          setBoot(b)
          setModels(b.models || [])
          setDefaults(b.defaults || {})
          setFfmpeg(b.ffmpeg || null)
          var id = localStorage.getItem(LS_ACTIVE)
          var exists = (b.projects || []).some(function (p) { return p.id === id })
          if (!id || !exists) id = b.projects && b.projects[0] ? b.projects[0].id : null
          if (id) return loadProjectInto(id).finally(function () { setLoading(false) })
          setLoading(false)
        }).catch(function (err) { setBootError(err.message); setLoading(false) })
      }

      React.useEffect(function () { loadBootstrap() }, [])

      // Re-open this panel on launch when it is pinned. selectPanel throws
      // until the shell has registered our 'main' key, so retry briefly.
      React.useEffect(function () {
        if (!pinned) return
        var tries = 0
        var timers = []
        function attempt() {
          tries += 1
          if (openPanel()) return
          if (tries < 8) timers.push(setTimeout(attempt, 500))
        }
        timers.push(setTimeout(attempt, 400))
        return function () { timers.forEach(function (t) { clearTimeout(t) }) }
      }, [])
      React.useEffect(function () {
        return function () {
          Object.keys(pollTimers.current).forEach(function (k) { clearInterval(pollTimers.current[k]) })
          clearTimeout(saveTimer.current)
        }
      }, [])

      // First open of a canvas still sitting at the default camera: frame all
      // nodes BEFORE paint (layout effect), so there is no 100%→fit jump.
      React.useLayoutEffect(function () {
        if (!project || !project.nodes || !project.nodes.length) return
        if (project.view && project.view.fitted) return
        var rect = containerRef.current ? containerRef.current.getBoundingClientRect() : null
        if (!rect || !rect.width) return
        var v = fitViewFor(project)
        setProject(function (p) { return p ? Object.assign({}, p, { view: v }) : p })
      }, [project ? project.id : null])

      // autosave (paused while a job is writing the project on the host)
      React.useEffect(function () {
        projectRef.current = project
        if (!project || !project.id) return
        var anyRunning = Object.keys(jobs).some(function (k) { return jobs[k] && jobs[k].status === 'running' })
        if (anyRunning) return
        var json = JSON.stringify(project)
        if (json === lastSavedJson.current) return
        setSaveState('dirty')
        clearTimeout(saveTimer.current)
        var doc = project
        saveTimer.current = setTimeout(function () {
          setSaveState('saving')
          api('/projects/' + doc.id, { method: 'PUT', body: { project: doc } })
            .then(function (res) {
              lastSavedJson.current = JSON.stringify(res.project)
              setSaveState('saved')
            })
            .catch(function (err) { setSaveState('error'); toast('保存失败：' + err.message, 'error') })
        }, 650)
        return function () { clearTimeout(saveTimer.current) }
      }, [project, jobs])

      // close add menu on Escape
      React.useEffect(function () {
        function onKey(e) {
          if (e.key === 'Escape') { setMenu(null); setModelsOpen(false); setSettingsOpen(false) }
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [])

      // wheel zoom (non-passive so we can preventDefault)
      React.useEffect(function () {
        var el = containerRef.current
        if (!el) return
        function onWheel(e) {
          if (e.ctrlKey && !e.deltaY) return
          e.preventDefault()
          setProject(function (p) {
            if (!p) return p
            var v = p.view || { x: 0, y: 0, zoom: 1 }
            var rect = el.getBoundingClientRect()
            var px = e.clientX - rect.left
            var py = e.clientY - rect.top
            var factor = Math.exp(-e.deltaY * 0.0016)
            var z = clamp(v.zoom * factor, 0.15, 2.6)
            var x = px - (px - v.x) * (z / v.zoom)
            var y = py - (py - v.y) * (z / v.zoom)
            return Object.assign({}, p, { view: { x: x, y: y, zoom: z } })
          })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return function () { el.removeEventListener('wheel', onWheel) }
      }, [project ? project.id : null])

      // pan with empty-canvas drag
      function onCanvasPointerDown(e) {
        if (e.button !== 0 && e.button !== 1) return
        if (e.target.closest('.oc-node, .oc-toolbar, .oc-menu, .oc-insp, .oc-ctx')) return
        setCtx(null)
        setSelectedId(null)
        var sx = e.clientX, sy = e.clientY
        var start = (project && project.view) || { x: 0, y: 0, zoom: 1 }
        function move(ev) {
          setProject(function (p) {
            if (!p) return p
            return Object.assign({}, p, { view: { x: start.x + (ev.clientX - sx), y: start.y + (ev.clientY - sy), zoom: start.zoom } })
          })
        }
        function up() {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      function mutateProject(fn) {
        setProject(function (p) { return p ? fn(p) : p })
      }

      // New nodes land in a lane that may sit outside the viewport; centre the
      // camera on the fresh node so creating it always shows the result.
      function focusNode(id) {
        var rect = containerRef.current ? containerRef.current.getBoundingClientRect() : null
        if (!rect || !rect.width) return
        mutateProject(function (p) {
          var n = (p.nodes || []).filter(function (x) { return x.id === id })[0]
          if (!n) return p
          var v = p.view || { x: 0, y: 0, zoom: 1 }
          var z = clamp(v.zoom || 1, 0.55, 1)
          var cx = n.x + (n.w || 320) / 2
          var cy = n.y + Math.min(220, (n.h || 240) / 2)
          return Object.assign({}, p, { view: { x: Math.round(rect.width / 2 - cx * z), y: Math.round(rect.height / 2 - cy * z), zoom: z, fitted: true } })
        })
      }

      function patchNode(nodeId, patchObj) {
        mutateProject(function (p) {
          return Object.assign({}, p, {
            nodes: p.nodes.map(function (n) {
              return n.id === nodeId
                ? Object.assign({}, n, typeof patchObj === 'function' ? patchObj(n) : patchObj, { updatedAt: new Date().toISOString() })
                : n
            }),
          })
        })
      }

      // 分镜: split the script into one sentence per shot, then rebuild the
      // storyboard panel from it. Timing from the old SRT no longer matches a
      // changed script, so those cues are dropped (the SRT node asks for a re-run).
      function applyScript(text, nodeId) {
        var raw = String(text == null ? '' : text)
        var sentences = splitScript(raw)
        if (!sentences.length) { toast('正文是空的：先粘贴或手写口播稿', 'error'); return }
        var prev = projectRef.current || project
        var prevSent = (prev && prev.script && prev.script.sentences) || []
        var changed = sentences.length !== prevSent.length || sentences.some(function (t, i) {
          return String((prevSent[i] && prevSent[i].text) || '') !== t
        })
        var cueCount = (prev && prev.srt && prev.srt.cues ? prev.srt.cues.length : 0)
        mutateProject(function (p) {
          var next = Object.assign({}, p, {
            script: { text: raw, sentences: sentences.map(function (s, i) { return { id: 's' + (i + 1), text: s } }) },
          })
          if (changed && cueCount) next.srt = { cues: [], raw: '', stale: true }
          var target = nodeId
            ? p.nodes.filter(function (n) { return n.id === nodeId })[0]
            : p.nodes.filter(function (n) { return n.kind === 'script' })[0]
          if (target) next.nodes = p.nodes.map(function (n) { return n.id === target.id ? Object.assign({}, n, { text: raw, status: 'done' }) : n })
          return next
        })
        if (changed && cueCount) toast('已分成 ' + sentences.length + ' 句，旧字幕时间轴已清空，请到「字幕 SRT」重新生成')
        else toast('已分成 ' + sentences.length + ' 句')
      }

      // Editing a line in the 分镜时间戳 node rewrites the cue text and the
      // matching script sentence (and the script node body) in one go, so the
      // timeline, the panel and the composed subtitles stay in sync.
      function editCue(cueIndex, text) {
        mutateProject(function (p) {
          var cues = ((p.srt && p.srt.cues) || []).slice()
          var cue = cues[cueIndex]
          if (!cue) return p
          cues[cueIndex] = Object.assign({}, cue, { text: text })
          var next = Object.assign({}, p, { srt: Object.assign({}, p.srt, { cues: cues }) })
          var ss = (p.script && p.script.sentences) || []
          var target = cue.sentence != null ? Number(cue.sentence) : Number(cueIndex)
          if (ss[target]) {
            var s2 = ss.slice()
            s2[target] = Object.assign({}, ss[target], { text: text })
            var joined = s2.map(function (x) { return x.text || '' }).join('')
            next.script = Object.assign({}, p.script, { sentences: s2, text: joined })
            next.nodes = (p.nodes || []).map(function (n) {
              return n.kind === 'script' ? Object.assign({}, n, { text: joined }) : n
            })
          }
          return next
        })
      }

      function storyboardOf(p) {
        return (p && p.nodes ? p.nodes : []).filter(function (n) { return n.kind === 'storyboard' })[0] || null
      }

      // --- canvas gestures: drag-to-wire and the right-click "new node" menu ---
      function addEdge(fromId, toId) {
        var prev = projectRef.current
        if (!prev || !fromId || !toId || fromId === toId) return
        if ((prev.edges || []).some(function (e) { return e.from === fromId && e.to === toId })) { toast('这两个节点已经连过了'); return }
        var src = (prev.nodes || []).filter(function (n) { return n.id === fromId })[0]
        var fromRow = src && src.kind === 'storyboard' && nodeSentences(src).length ? nodeSentences(src)[0] : null
        var next = Object.assign({}, prev, { edges: (prev.edges || []).concat([{ id: uid('e'), from: fromId, to: toId, fromRow: fromRow }]) })
        setProject(next)
        setSaveState('dirty')
        toast('已连线')
      }

      // Right-click on a card: build a node just to its right, already wired.
      function createNodeFrom(fromId, kind) {
        var prev = projectRef.current
        if (!prev) return
        var from = (prev.nodes || []).filter(function (n) { return n.id === fromId })[0]
        if (!from) return
        if (kind === 'storyboard' && storyboardOf(prev)) { toast('分镜时间戳节点已经有了'); setCtx(null); return }
        var meta = KINDS[kind]
        var sentence = nodeSentences(from).length ? nodeSentences(from)[0] : null
        var x = from.x + (from.w || KINDS[from.kind].w || 320) + 90
        var y = from.y + 20
        var clash = (prev.nodes || []).filter(function (n) { return Math.abs(n.x - x) < 40 && Math.abs(n.y - y) < 40 }).length
        x += clash * 46
        y += clash * 36
        var ts = new Date().toISOString()
        var node = {
          id: uid('n'), kind: kind,
          title: meta.label + (sentence != null && meta.sentence ? ' · 第' + (sentence + 1) + '句' : ''),
          sentenceIndex: sentence != null && meta.sentence ? sentence : null,
          sentences: sentence != null && meta.sentence ? [sentence] : [],
          x: Math.round(x), y: Math.round(y), w: meta.w,
          status: 'idle', modelId: null, params: {}, assets: [], log: '', error: null,
          createdAt: ts, updatedAt: ts, text: '',
        }
        if (kind === 'motion') {
          node.params = { template: 'kinetic', subtitle: '', color1: '#4f7cff', color2: '#9b5cff', textColor: '#ffffff', fontSize: 72, title: sentenceOf(prev, sentence) }
        }
        var edges = (prev.edges || []).concat([{ id: uid('e'), from: fromId, to: node.id, fromRow: from.kind === 'storyboard' ? sentence : null }])
        setProject(Object.assign({}, prev, { nodes: prev.nodes.concat([node]), edges: edges }))
        setSelectedId(node.id)
        setCtx(null)
        focusNode(node.id)
        toast('已新建' + meta.label + '（从「' + (from.title || KINDS[from.kind].label) + '」连过来）')
      }

      function addAssets(node, assets, logText) {
        var prev = projectRef.current
        if (!prev || !assets || !assets.length) return Promise.resolve(null)
        var next = Object.assign({}, prev, {
          nodes: (prev.nodes || []).map(function (n) {
            return n.id === node.id
              ? Object.assign({}, n, { assets: (n.assets || []).concat(assets), status: 'done', log: logText, updatedAt: new Date().toISOString() })
              : n
          }),
        })
        setProject(next)
        return api('/projects/' + prev.id, { method: 'PUT', body: { project: next } }).then(function (r) {
          lastSavedJson.current = JSON.stringify((r && r.project) || next)
          return r
        })
      }

      function uploadRefs(node, files) {
        var list = Array.prototype.slice.call(files || [])
        if (!list.length) return
        if (!project) return
        toast('上传 ' + list.length + ' 个参考素材…')
        Promise.all(list.map(function (f) { return uploadAsset(project.id, node.id, f, f.name) }))
          .then(function (res) { return addAssets(node, res.map(function (r) { return r.asset }), '参考素材 ' + res.length + ' 个') })
          .then(function () { toast('参考素材已加入') })
          .catch(function (err) { toast('上传失败：' + err.message, 'error') })
      }

      function onWireStart(id) {
        setWire({ from: id, x: 0, y: 0 })
      }

      function nodeChatSend(nodeId, message) {
        if (!project) return Promise.reject(new Error('还没有项目'))
        return api('/projects/' + project.id + '/nodes/' + nodeId + '/chat', { method: 'POST', body: { message: message } })
          .then(function (res) {
            var prev = projectRef.current
            if (!prev) return res
            var next = Object.assign({}, prev, { nodes: prev.nodes.map(function (n) { return n.id === nodeId ? res.node : n }) })
            setProject(next)
            lastSavedJson.current = JSON.stringify(next)
            toast(res.patch ? '智能体已更新这个节点的参数' : '智能体已回复')
            if (res.node && res.node.kind === 'motion' && res.patch && res.node.params && res.node.params.autoRecord !== false && !(res.node.assets || []).length) {
              setTimeout(function () { recordMotion(res.node, Object.assign({}, res.node.params)) }, 200)
            }
            return res
          })
          .catch(function (err) { toast('对话失败：' + err.message, 'error'); throw err })
      }

      React.useEffect(function () {
        if (!wire) return
        function move(ev) {
          setWire(function (w) { return w ? Object.assign({}, w, { x: ev.clientX, y: ev.clientY }) : w })
        }
        function up(ev) {
          var w = wireRef.current
          setWire(null)
          if (!w) return
          var el = document.elementFromPoint(ev.clientX, ev.clientY)
          var card = el && el.closest ? el.closest('.oc-node') : null
          var target = card ? card.getAttribute('data-node-id') : null
          if (!target || target === w.from) return
          addEdge(w.from, target)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        return function () {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
      }, [wire ? wire.from : null])

      React.useEffect(function () {
        if (!ctx) return
        function away(ev) {
          if (ev.target && ev.target.closest && ev.target.closest('.oc-ctx')) return
          setCtx(null)
        }
        window.addEventListener('pointerdown', away, true)
        return function () { window.removeEventListener('pointerdown', away, true) }
      }, [ctx ? ctx.x + ':' + ctx.y : null])

      // 分镜时间戳 is derived from the SRT cues: create it (plus the
      // script → srt → storyboard chain) the first time a timeline exists.
      function ensureStoryboard(p) {
        if (!p) return null
        var cues = (p.srt && p.srt.cues) || []
        if (!cues.length) return null
        var sb = storyboardOf(p)
        if (sb) return { doc: p, node: sb, created: false }
        var ts = new Date().toISOString()
        var node = {
          id: uid('n'), kind: 'storyboard', title: '分镜时间戳',
          sentenceIndex: null, sentences: [],
          x: 80 + COLUMN.storyboard * LANE_PITCH, y: 150, w: KINDS.storyboard.w,
          status: 'done', modelId: null, params: {}, assets: [], log: '', error: null,
          createdAt: ts, updatedAt: ts, text: '',
        }
        var edges = (p.edges || []).slice()
        var srtNode = (p.nodes || []).filter(function (n) { return n.kind === 'srt' })[0]
        var scriptNode = (p.nodes || []).filter(function (n) { return n.kind === 'script' })[0]
        function link(fromId) {
          if (!fromId) return
          if (edges.some(function (e) { return e.from === fromId && e.to === node.id })) return
          edges.push({ id: uid('e'), from: fromId, to: node.id })
        }
        if (srtNode) link(srtNode.id)
        else if (scriptNode) link(scriptNode.id)
        var doc = Object.assign({}, p, { nodes: (p.nodes || []).concat([node]), edges: edges })
        return { doc: doc, node: node, created: true }
      }

      function createNode(kind, sentenceIndex) {
        if (!project) return
        if (kind === 'storyboard') {
          var exists = storyboardOf(project)
          if (exists) { setSelectedId(exists.id); setMenu(null); toast('分镜时间戳节点已经有了，直接在上面改字幕'); return }
        }
        var meta = KINDS[kind]
        var v = project.view || { x: 0, y: 0, zoom: 1 }
        var rect = containerRef.current ? containerRef.current.getBoundingClientRect() : { width: 1200, height: 800 }
        var sel = selectedId ? project.nodes.filter(function (n) { return n.id === selectedId })[0] : null
        var x, y
        if (sentenceIndex != null) {
          // Lane layout: one column per pipeline stage, one row per sentence, so the
          // canvas reads as "each sentence has its own shot" left to right.
          var lane = COLUMN[kind] != null ? COLUMN[kind] : COLUMN.motion
          x = 80 + lane * LANE_PITCH
          y = 150 + Number(sentenceIndex) * 460
        } else if (kind === 'compose') {
          var rows = (project.script && project.script.sentences ? project.script.sentences.length : 0) || 1
          x = 80 + COLUMN.compose * LANE_PITCH
          y = 150 + Math.max(0, rows - 1) * 230
        } else if (kind === 'storyboard') {
          x = 80 + COLUMN.storyboard * LANE_PITCH
          y = 150
        } else if (sel) {
          x = sel.x + (sel.w || KINDS[sel.kind].w) + 70
          y = sel.y + 20
        } else {
          x = (rect.width / 2 - v.x) / v.zoom - (meta.w || 320) / 2
          y = (rect.height / 2 - v.y) / v.zoom - 130
        }
        if (sentenceIndex != null || kind === 'compose') {
          var clash = project.nodes.filter(function (n) { return Math.abs(n.x - x) < 20 && Math.abs(n.y - y) < 20 }).length
          x += clash * 34
          y += clash * 26
        } else {
          var sameKind = project.nodes.filter(function (n) { return n.kind === kind }).length
          x += (sameKind % 4) * 30
          y += (sameKind % 4) * 26
        }
        var ts = new Date().toISOString()
        var node = {
          id: uid('n'), kind: kind,
          title: meta.label + (sentenceIndex != null ? ' · 第' + (sentenceIndex + 1) + '句' : ''),
          sentenceIndex: sentenceIndex == null ? null : Number(sentenceIndex),
          sentences: sentenceIndex == null ? [] : [Number(sentenceIndex)],
          x: Math.round(x), y: Math.round(y), w: meta.w,
          status: 'idle', modelId: null, params: {}, assets: [], log: '', error: null,
          createdAt: ts, updatedAt: ts, text: '',
        }
        if (kind === 'audio') node.params = {}
        if (kind === 'srt') node.params = { mode: 'auto' }
        if (kind === 'motion') {
          node.params = { template: 'kinetic', subtitle: '', color1: '#4f7cff', color2: '#9b5cff', textColor: '#ffffff', fontSize: 72, title: sentenceOf(project, node.sentenceIndex) }
        }
        var edges = (project.edges || []).slice()
        var sb = storyboardOf(project)
        if (sentenceIndex != null && sb) {
          edges.push({ id: uid('e'), from: sb.id, to: node.id, fromRow: Number(sentenceIndex) })
        } else if (sel) {
          edges.push({ id: uid('e'), from: sel.id, to: node.id })
        }
        if (kind === 'srt') {
          var scriptNode = project.nodes.filter(function (n) { return n.kind === 'script' })[0]
          if (scriptNode && !edges.some(function (e) { return e.from === scriptNode.id && e.to === node.id })) {
            edges.push({ id: uid('e'), from: scriptNode.id, to: node.id })
          }
        }
        var doc = Object.assign({}, project, { nodes: project.nodes.concat([node]), edges: edges })
        if (kind === 'srt') {
          var ensured = ensureStoryboard(doc)
          if (ensured && ensured.created) doc = ensured.doc
        }
        mutateProject(function () { return doc })
        setSelectedId(node.id)
        focusNode(node.id)
        setMenu(null)
      }

      // One shot fed by several picked sentences: a single node plus one edge per
      // sentence row, so the canvas shows exactly which lines that material covers.
      function createShot(kind, indexes, autoGen) {
        if (!project || !indexes || !indexes.length) return
        var meta = KINDS[kind]
        var list = indexes.map(Number).filter(function (n, i, a) { return Number.isFinite(n) && a.indexOf(n) === i }).sort(function (a, b) { return a - b })
        if (!list.length) return
        var lane = COLUMN[kind] != null ? COLUMN[kind] : COLUMN.motion
        var x = 80 + lane * LANE_PITCH
        var y = 150 + list[0] * 460
        var clash = project.nodes.filter(function (n) { return Math.abs(n.x - x) < 20 && Math.abs(n.y - y) < 20 }).length
        x += clash * 34
        y += clash * 26
        var ts = new Date().toISOString()
        var node = {
          id: uid('n'), kind: kind,
          title: meta.label + ' · ' + (list.length === 1 ? '第' + (list[0] + 1) + '句' : '第' + list.map(function (i) { return i + 1 }).join('、') + '句'),
          sentenceIndex: list.length === 1 ? list[0] : null,
          sentences: list,
          x: Math.round(x), y: Math.round(y), w: meta.w,
          status: 'idle', modelId: null, params: {}, assets: [], log: '', error: null,
          createdAt: ts, updatedAt: ts, text: '',
        }
        if (kind === 'motion') {
          node.params = { template: 'kinetic', subtitle: '', color1: '#4f7cff', color2: '#9b5cff', textColor: '#ffffff', fontSize: 72, title: sentenceOf(project, list[0]) }
        }
        var edges = (project.edges || []).slice()
        var sb = storyboardOf(project)
        if (sb) list.forEach(function (i) { edges.push({ id: uid('e'), from: sb.id, to: node.id, fromRow: i }) })
        var doc = Object.assign({}, project, { nodes: project.nodes.concat([node]), edges: edges })
        mutateProject(function () { return doc })
        setSelectedId(node.id)
        focusNode(node.id)
        setMenu(null)
        setPickedSentences({})
        toast('已新建' + meta.label + '：' + list.length + ' 句共用一个镜头')
        if (autoGen) queueGenerate([node], doc)
      }

      function createPicked(kind, indexes, autoGen) {
        var list = (indexes || []).filter(function (v) { return v != null }).map(Number)
        if (!list.length) { createNode(kind, null); return }
        if (kind === 'audio') { createNodes(kind, list, autoGen); return }
        createShot(kind, list, autoGen)
      }

      function createNodes(kind, indexes, autoGen) {
        if (!project || !indexes || !indexes.length) return
        var meta = KINDS[kind]
        var ts = new Date().toISOString()
        var next = project.nodes.slice()
        var edges = (project.edges || []).slice()
        var sb = storyboardOf(project)
        var created = []
        indexes.forEach(function (sentenceIndex) {
          var lane = COLUMN[kind] != null ? COLUMN[kind] : COLUMN.motion
          var x = 80 + lane * LANE_PITCH
          var y = 150 + Number(sentenceIndex) * 460
          var clash = next.filter(function (n) { return Math.abs(n.x - x) < 20 && Math.abs(n.y - y) < 20 }).length
          x += clash * 34
          y += clash * 26
          var node = {
            id: uid('n'), kind: kind,
            title: meta.label + ' · 第' + (Number(sentenceIndex) + 1) + '句',
            sentenceIndex: Number(sentenceIndex),
            sentences: [Number(sentenceIndex)],
            x: Math.round(x), y: Math.round(y), w: meta.w,
            status: 'idle', modelId: null, params: {}, assets: [], log: '', error: null,
            createdAt: ts, updatedAt: ts, text: '',
          }
          if (kind === 'motion') {
            node.params = { template: 'kinetic', subtitle: '', color1: '#4f7cff', color2: '#9b5cff', textColor: '#ffffff', fontSize: 72, title: sentenceOf(project, sentenceIndex) }
          }
          if (sb) edges.push({ id: uid('e'), from: sb.id, to: node.id, fromRow: Number(sentenceIndex) })
          created.push(node)
          next.push(node)
        })
        var nextDoc = Object.assign({}, project, { nodes: next, edges: edges })
        mutateProject(function () { return nextDoc })
        setSelectedId(created.length ? created[0].id : null)
        if (created.length) focusNode(created[0].id)
        setMenu(null)
        setPickedSentences({})
        toast('已新建 ' + created.length + ' 个' + meta.label + '节点')
        if (autoGen) queueGenerate(created, nextDoc)
      }

      // Generate several nodes one after another: each job returns the whole
      // project, so running them in parallel would clobber the newer snapshot.
      function queueGenerate(list, baseProject) {
        var queue = list.slice()
        var total = queue.length
        var failed = 0
        var started = 0
        // Work from an explicit local snapshot: projectRef only catches up after
        // the next render, and persisting stale nodes makes generate 404.
        var current = baseProject
        setBatch({ total: total, done: 0, failed: 0 })
        function finish() {
          setBatch(null)
          toast('批量生成结束：成功 ' + (total - failed) + ' / ' + total + ' 句' + (failed ? '，失败 ' + failed + ' 句' : ''), failed ? 'error' : undefined)
        }
        function step() {
          if (!queue.length) { finish(); return }
          var node = queue.shift()
          var pid = current.id
          api('/projects/' + pid, { method: 'PUT', body: { project: current } })
            .then(function () { return api('/projects/' + pid + '/nodes/' + node.id + '/generate', { body: {} }) })
            .then(function (res) { return waitJob(res.job.id) })
            .then(function (job) {
              if (job.status === 'error') failed++
              if (job.result && job.result.project) {
                current = job.result.project
                setProject(current)
                lastSavedJson.current = JSON.stringify(current)
              }
              started++
              setBatch({ total: total, done: started, failed: failed })
              step()
            })
            .catch(function (err) {
              failed++
              started++
              patchNode(node.id, { status: 'error', error: err.message })
              setBatch({ total: total, done: started, failed: failed })
              step()
            })
        }
        step()
      }

      function waitJob(jobId) {
        return new Promise(function (resolve, reject) {
          var tries = 0
          function tick() {
            tries++
            api('/jobs/' + jobId).then(function (res) {
              var job = res.job
              if (!job) return reject(new Error('任务丢失'))
              if (job.status === 'running') {
                if (tries > 3600) return reject(new Error('任务超时'))
                setTimeout(tick, 900)
                return
              }
              resolve(job)
            }).catch(reject)
          }
          tick()
        })
      }

      function deleteNode(node) {
        mutateProject(function (p) {
          return Object.assign({}, p, {
            nodes: p.nodes.filter(function (n) { return n.id !== node.id }),
            edges: (p.edges || []).filter(function (e) { return e.from !== node.id && e.to !== node.id }),
          })
        })
        setSelectedId(null)
      }

      function deleteAsset(node, asset) {
        api('/projects/' + project.id + '/assets/' + asset.id, { method: 'DELETE' })
          .then(function () { return loadProjectInto(project.id, true) })
          .catch(function (err) { toast('删除素材失败：' + err.message, 'error') })
      }

      function startGenerate(node, body) {
        if (!project) return
        clearTimeout(saveTimer.current)
        api('/projects/' + project.id, { method: 'PUT', body: { project: project } })
          .then(function () {
            return api('/projects/' + project.id + '/nodes/' + node.id + '/generate', { body: body || {} })
          })
          .then(function (res) {
            var job = res.job
            setJobs(function (prev) { var n = Object.assign({}, prev); n[node.id] = job; return n })
            patchNode(node.id, { status: 'running', error: null })
            pollJob(node.id, job.id)
          })
          .catch(function (err) { toast('启动失败：' + err.message, 'error') })
      }

      function pollJob(nodeId, jobId) {
        if (pollTimers.current[nodeId]) clearInterval(pollTimers.current[nodeId])
        function tick() {
          api('/jobs/' + jobId).then(function (res) {
            var job = res.job
            setJobs(function (prev) { var n = Object.assign({}, prev); n[nodeId] = job; return n })
            if (job.status === 'running') {
              patchNode(nodeId, { status: 'running', log: job.message || '生成中…' })
            } else if (job.status === 'done') {
              clearInterval(pollTimers.current[nodeId])
              delete pollTimers.current[nodeId]
              setJobs(function (prev) { var n = Object.assign({}, prev); delete n[nodeId]; return n })
              toast((job.label || '任务') + ' 完成')
              if (res.job && res.job.result && res.job.result.project) {
                var doc = res.job.result.project
                // Generating the timeline creates the derived 分镜时间戳 node so
                // the next shots hang off actual timestamps.
                var ensured = ensureStoryboard(doc)
                if (ensured && ensured.created) {
                  doc = ensured.doc
                  var pid = doc.id
                  setTimeout(function () {
                    api('/projects/' + pid, { method: 'PUT', body: { project: doc } })
                      .then(function () { toast('已生成「分镜时间戳」节点') })
                      .catch(function () {})
                  }, 60)
                }
                setProject(doc)
                lastSavedJson.current = JSON.stringify(doc)
                // A designed motion node is only useful once it is a real video
                // file, otherwise compose renders an empty shot for that line.
                var fresh = (doc.nodes || []).filter(function (n) { return n.id === nodeId })[0]
                if (fresh && fresh.kind === 'motion' && fresh.params && fresh.params.template && fresh.params.autoRecord !== false && !(fresh.assets || []).length) {
                  toast('动效参数已生成，正在录制成视频…')
                  setTimeout(function () { recordMotion(fresh, fresh.params) }, 150)
                }
              } else {
                loadProjectInto(project.id, true).catch(function () {})
              }
            } else if (job.status === 'error') {
              clearInterval(pollTimers.current[nodeId])
              delete pollTimers.current[nodeId]
              setJobs(function (prev) { var n = Object.assign({}, prev); delete n[nodeId]; return n })
              patchNode(nodeId, { status: 'error', error: job.error })
              toast('生成失败：' + job.error, 'error')
            }
          }).catch(function (err) { toast('查询任务失败：' + err.message, 'error') })
        }
        pollTimers.current[nodeId] = setInterval(tick, 900)
        tick()
      }

      // Attach a freshly uploaded asset to its node and persist exactly once.
      // (Never run a PUT inside a setProject updater: updaters must be pure.)
      function attachAsset(node, asset, logText) {
        var prev = projectRef.current
        if (!prev) return Promise.resolve(null)
        var next = Object.assign({}, prev, {
          nodes: prev.nodes.map(function (n) {
            return n.id === node.id
              ? Object.assign({}, n, { assets: [asset], status: 'done', log: logText, updatedAt: new Date().toISOString() })
              : n
          }),
        })
        setProject(next)
        return api('/projects/' + prev.id, { method: 'PUT', body: { project: next } })
          .then(function (r) {
            lastSavedJson.current = JSON.stringify((r && r.project) || next)
            return r
          })
      }

      function uploadTo(node, file) {
        if (!file) return
        toast('上传 ' + file.name + '…')
        uploadAsset(project.id, node.id, file, file.name)
          .then(function (res) { return attachAsset(node, res.asset, '导入素材 ' + res.asset.name) })
          .then(function () { toast('素材已导入') })
          .catch(function (err) { toast('上传失败：' + err.message, 'error') })
      }

      function importPath(node) {
        ask({
          kind: 'input', title: '导入本机素材', label: '绝对路径', okText: '导入',
          placeholder: 'D:\\videos\\shot.mp4',
          hint: '视频 / 音频 / 图片都行；文件会被复制进项目素材目录。',
          onSubmit: function (p) {
            setDialog(null)
            if (!p) return
            api('/projects/' + project.id + '/import', { method: 'POST', body: { path: p, nodeId: node.id } })
              .then(function (res) { return attachAsset(node, res.asset, '导入素材 ' + res.asset.name) })
              .then(function () { toast('素材已导入') })
              .catch(function (err) { toast('导入失败：' + err.message, 'error') })
          },
        })
      }

      function recordMotion(node, params) {
        var duration = Math.max(0.6, Number(params.duration) || sentenceSpan(project, node.sentenceIndex) || 3)
        var p = Object.assign({}, params, { duration: duration })
        setRecording({ nodeId: node.id, progress: 0 })
        recordCanvas(p, duration, function (prog) { setRecording({ nodeId: node.id, progress: prog }) })
          .then(function (blob) {
            var file = new File([blob], 'motion-' + node.id + '.webm', { type: 'video/webm' })
            return uploadAsset(project.id, node.id, file, file.name, duration)
          })
          .then(function (res) {
            return attachAsset(node, res.asset, '动效已录制成视频（' + fmtSec(duration) + '）')
          })
          .then(function () {
            setRecording(null)
            toast('动效视频已生成，可直接参与合成')
          })
          .catch(function (err) { setRecording(null); toast('录制失败：' + err.message, 'error') })
      }

      function deleteProject() {
        api('/projects/' + project.id, { method: 'DELETE' }).then(function () {
          setSettingsOpen(false)
          setProject(null)
          setSelectedId(null)
          localStorage.removeItem(LS_ACTIVE)
          loadBootstrap()
        }).catch(function (err) { toast('删除失败：' + err.message, 'error') })
      }

      function saveSettings(next) {
        mutateProject(function (p) { return Object.assign({}, p, { name: next.name, settings: next.settings }) })
        setSettingsOpen(false)
      }

      function createProject() {
        ask({
          kind: 'input', title: '新建项目', label: '项目名',
          value: '口播项目 ' + new Date().toLocaleDateString(),
          placeholder: '例如：GitHub 保姆级教程',
          okText: '创建',
          onSubmit: function (name) { setDialog(null); doCreateProject(name) },
        })
      }

      function doCreateProject(name) {
        var finalName = String(name || '').trim() || '未命名项目'
        api('/projects', { method: 'POST', body: { name: finalName } }).then(function (res) {
          setBoot(function (b) { return b ? Object.assign({}, b, { projects: (b.projects || []).concat([{ id: res.project.id, name: res.project.name, updatedAt: res.project.updatedAt, nodes: 1 }]) }) : b })
          return loadProjectInto(res.project.id)
        }).then(function () { toast('已创建项目「' + finalName + '」') })
          .catch(function (err) { toast('新建失败：' + err.message, 'error') })
      }

      function switchProject(id) {
        if (!id || (project && id === project.id)) return
        setLoading(true)
        loadProjectInto(id).finally(function () { setLoading(false) })
      }

      function refreshProjects() {
        return api('/bootstrap').then(function (b) {
          setBoot(function (prev) { return prev ? Object.assign({}, prev, { projects: b.projects }) : b })
        }).catch(function () {})
      }

      function layoutAll() {
        if (!project) return
        var rows = (project.script && project.script.sentences ? project.script.sentences.length : 0) || 1
        var stack = {}
        var nodes = project.nodes.map(function (n) {
          var lane = COLUMN[n.kind] != null ? COLUMN[n.kind] : COLUMN.motion
          var x = 80 + lane * LANE_PITCH
          var y = 150
          if (n.kind === 'compose') y = 150 + Math.max(0, rows - 1) * 230
          else if (n.kind === 'storyboard') y = 150
          else if (nodeSentences(n).length) y = 150 + Number(nodeSentences(n)[0]) * 460
          var key = lane + ':' + Math.round(y)
          stack[key] = (stack[key] || 0) + 1
          if (stack[key] > 1) { x += (stack[key] - 1) * 40; y += (stack[key] - 1) * 34 }
          return Object.assign({}, n, { x: Math.round(x), y: Math.round(y) })
        })
        var next = Object.assign({}, project, { nodes: nodes })
        if (nodes.length) next.view = fitViewFor(next, 0.2)
        setProject(next)
      }

      function zoomBy(factor) {
        mutateProject(function (p) {
          var v = p.view || { x: 0, y: 0, zoom: 1 }
          var rect = containerRef.current ? containerRef.current.getBoundingClientRect() : null
          var cx = rect ? rect.width / 2 : 600
          var cy = rect ? rect.height / 2 : 400
          var z = clamp(v.zoom * factor, 0.15, 2.6)
          return Object.assign({}, p, { view: { x: cx - (cx - v.x) * (z / v.zoom), y: cy - (cy - v.y) * (z / v.zoom), zoom: z } })
        })
      }

      function fitViewFor(p, minZoom) {
        var rect = containerRef.current ? containerRef.current.getBoundingClientRect() : { width: 1200, height: 800 }
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        p.nodes.forEach(function (n) {
          var w = n.w || KINDS[n.kind].w || 320
          minX = Math.min(minX, n.x)
          minY = Math.min(minY, n.y)
          maxX = Math.max(maxX, n.x + w)
          maxY = Math.max(maxY, n.y + 300)
        })
        var pad = 80
        // Keep the first view readable: the pipeline is wider than any screen,
        // so fit only down to a legible zoom and let the user pan. The 适应
        // button passes a smaller floor to show the whole canvas at once.
        var z = clamp(Math.min((rect.width - pad * 2) / Math.max(1, maxX - minX), (rect.height - pad * 2) / Math.max(1, maxY - minY)), minZoom || 0.55, 1.1)
        return { x: Math.round(pad - minX * z), y: Math.round(pad - minY * z), zoom: z, fitted: true }
      }

      function fitView(projArg) {
        var p = projArg && projArg.nodes ? projArg : project
        if (!p || !p.nodes.length) return
        var nextView = fitViewFor(p, 0.2)
        mutateProject(function (prev) { return Object.assign({}, prev, { view: nextView }) })
      }

      var view = (project && project.view) || { x: 0, y: 0, zoom: 1 }
      var selected = project && project.nodes ? project.nodes.filter(function (n) { return n.id === selectedId })[0] : null
      var entries = project ? sentenceEntries(project) : []
      var pickedList = entries.filter(function (s) { return pickedSentences[s.index] }).map(function (s) { return s.index })
      function toggleSentence(index) {
        setPickedSentences(function (prev) {
          var next = Object.assign({}, prev)
          if (next[index]) delete next[index]
          else next[index] = true
          return next
        })
      }
      function pickAllSentences(on) {
        var next = {}
        if (on) entries.forEach(function (s) { next[s.index] = true })
        setPickedSentences(next)
      }
      var nodeCount = project ? project.nodes.length : 0
      var runningJobs = Object.keys(jobs).length

      if (bootError) {
        return h('div', { className: 'oc-root' }, h('style', null, CSS),
          h('div', { className: 'oc-center' },
            h('div', { className: 'oc-modal-title' }, '口播画布无法连接'),
            h('div', { className: 'oc-hint' }, bootError),
            h('button', { type: 'button', className: 'oc-btn oc-btn-primary', onClick: function () { setBootError(null); loadBootstrap() } }, '重试')))
      }
      if (loading && !boot) {
        return h('div', { className: 'oc-root' }, h('style', null, CSS), h('div', { className: 'oc-center' }, '加载中…'))
      }

      return h('div', { className: 'oc-root' },
        h('style', null, CSS),
        h('div', { className: 'oc-topbar' },
          h('div', { className: 'oc-brand' }, h('span', { className: 'oc-logo' }, '口'), h('span', { className: 'oc-title' }, '口播画布')),
          h('select', { className: 'oc-input oc-select-project', value: project ? project.id : '', onChange: function (e) { switchProject(e.target.value) } },
            !project ? h('option', { value: '' }, boot && boot.projects && boot.projects.length ? '选择项目…' : '还没有项目') : null,
            (boot && boot.projects || []).map(function (p) { return h('option', { key: p.id, value: p.id }, p.name) })),
          h('button', { type: 'button', className: 'oc-btn', onClick: createProject }, '+ 新项目'),
          h('div', { className: 'oc-spacer' }),
          project ? h('span', { className: 'oc-dim' }, saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : saveState === 'dirty' ? '未保存' : saveState === 'error' ? '保存失败' : '') : null,
          h('button', { type: 'button', className: 'oc-btn', title: '每秒查询一次素材/项目状态', onClick: function () { refreshProjects(); if (project) loadProjectInto(project.id, true).catch(function () {}) } }, '刷新'),
          h('span', { className: 'oc-ffmpeg ' + (ffmpeg && ffmpeg.ok ? 'ok' : 'bad'), title: ffmpeg && ffmpeg.ok ? 'ffmpeg：' + ffmpeg.path : '未找到 ffmpeg：' + ((ffmpeg && ffmpeg.error) || '') },
            h('span', { className: 'oc-dot ' + (ffmpeg && ffmpeg.ok ? 'oc-dot-done' : 'oc-dot-error') }), 'ffmpeg'),
          h('button', { type: 'button', className: 'oc-btn', onClick: function () { setModelsOpen(true) } }, '模型配置'),
          project ? h('button', { type: 'button', className: 'oc-btn', onClick: function () { setSettingsOpen(true) } }, '项目设置') : null,
          h('button', {
            type: 'button', className: 'oc-btn', title: '句子面板',
            onClick: function () {
              var next = !showSentences
              setShowSentences(next)
              localStorage.setItem(LS_SENTENCES, next ? '1' : '0')
            },
          }, showSentences ? '收起分镜' : '展开分镜')),

        h('div', { className: 'oc-body' },
          showSentences && project ? h('aside', { className: 'oc-sentences' },
            h('div', { className: 'oc-panel-head' },
              h('span', null, '分镜 / 句子'),
              h('div', { className: 'oc-panel-actions' },
                entries.length ? h('button', {
                  type: 'button', className: 'oc-mini',
                  title: '勾选全部句子（可一次为多句建节点）',
                  onClick: function () { pickAllSentences(pickedList.length !== entries.length) },
                }, pickedList.length === entries.length ? '取消全选' : '全选') : null,
                h('span', { className: 'oc-chip' }, entries.length + ' 句'))),
            h('div', { className: 'oc-hint oc-pad' }, '每句话一个画面：勾选多句后点任意一句的「+」，这些句子会连到同一个素材节点。'),
            pickedList.length ? h('div', { className: 'oc-pickbar' },
              h('span', { className: 'oc-pickbar-count' }, '已选 ' + pickedList.length + ' 句'),
              h('button', {
                type: 'button', className: 'oc-btn oc-btn-accent',
                onClick: function () { setMenu({ step: 'kind', kind: null, sentenceIndex: null, multi: pickedList }) },
              }, '建节点'),
              h('button', { type: 'button', className: 'oc-btn', onClick: function () { setPickedSentences({}) } }, '清空')) : null,
            h('div', { className: 'oc-sentence-list' }, entries.length ? entries.map(function (s) {
              var ns = (project.nodes || []).filter(function (n) { return nodeSentences(n).indexOf(Number(s.index)) >= 0 })
              var selected = pickedList.indexOf(Number(s.index)) >= 0
              return h('div', { className: 'oc-sentence' + (selected ? ' picked' : ''), key: 's' + s.index },
                h('div', { className: 'oc-sentence-head' },
                  h('input', {
                    type: 'checkbox', className: 'oc-sentence-check', checked: !!pickedSentences[s.index],
                    title: '勾选这句', onChange: function () { toggleSentence(s.index) },
                  }),
                  h('span', { className: 'oc-sentence-idx' }, s.order),
                  s.start != null ? h('span', { className: 'oc-sentence-time' }, fmtClock(s.start) + '–' + fmtClock(s.end)) : h('span', { className: 'oc-sentence-time' }, '未对齐'),
                  h('button', {
                    type: 'button', className: 'oc-sentence-add',
                    title: pickedList.length > 1 ? '让选中的 ' + pickedList.length + ' 句共用一个新节点' : '为这句新建节点',
                    onClick: function (e) {
                      e.stopPropagation()
                      var union = pickedList.slice()
                      if (union.indexOf(Number(s.index)) < 0) union.push(Number(s.index))
                      setMenu({ step: 'kind', kind: null, sentenceIndex: null, multi: union })
                    },
                  }, '+')),
                h('div', { className: 'oc-sentence-text' }, s.text),
                h('div', { className: 'oc-sentence-nodes' },
                  ['audio', 'dhvideo', 'motion', 'screen'].map(function (kind) {
                    var mine = ns.filter(function (n) { return n.kind === kind })
                    var has = mine.length > 0
                    var running = mine.some(function (n) { return n.status === 'running' })
                    return h('button', {
                      key: kind, type: 'button',
                      className: 'oc-pip ' + (has ? 'on' : '') + (running ? ' run' : ''),
                      style: has ? { background: KINDS[kind].color } : null,
                      title: (has ? '已有 ' + KINDS[kind].label + '，点击再建一个' : '新建' + KINDS[kind].label),
                      onClick: function (e) { e.stopPropagation(); createNode(kind, s.index) },
                    }, h('span', { className: 'oc-pip-tag' }, KINDS[kind].short))
                  })))
            }) : h('div', { className: 'oc-empty oc-pad' }, '还没有句子。先建「口播稿」节点生成或手写正文。'))) : null,

          h('div', {
            className: 'oc-canvas', ref: containerRef,
            style: {
              backgroundSize: (26 * view.zoom) + 'px ' + (26 * view.zoom) + 'px',
              backgroundPosition: view.x + 'px ' + view.y + 'px',
            },
            onPointerDown: onCanvasPointerDown,
          },
            h('div', { className: 'oc-toolbar' },
              h('button', {
                type: 'button', className: 'oc-btn oc-btn-primary',
                onClick: function (e) { e.stopPropagation(); setMenu({ step: 'kind', kind: null, sentenceIndex: null }) },
              }, '+ 新建节点'),
              h('button', { type: 'button', className: 'oc-btn', onClick: function () { zoomBy(1 / 1.2) } }, '−'),
              h('span', { className: 'oc-zoom' }, Math.round(view.zoom * 100) + '%'),
              h('button', { type: 'button', className: 'oc-btn', onClick: function () { zoomBy(1.2) } }, '+'),
              h('button', { type: 'button', className: 'oc-btn', onClick: fitView }, '适应'),
              project && project.nodes.length ? h('button', { type: 'button', className: 'oc-btn', title: '按「句子 × 环节」重新排布画布', onClick: layoutAll }, '整理') : null,
            h('button', {
              type: 'button',
              className: pinned ? 'oc-btn oc-btn-accent' : 'oc-btn',
              title: pinned ? '已固定：每次打开都自动切到口播画布（点一下取消）' : '固定：每次打开 DSH 自动切到口播画布',
              onClick: function () {
                var next = !pinned
                writePinned(next)
                setPinned(next)
                if (next) { openPanel(); toast('已固定：下次打开会自动进入口播画布') }
                else toast('已取消固定')
              },
            }, pinned ? '已固定' : '固定'),
              project ? h('span', { className: 'oc-dim' }, nodeCount + ' 个节点' + (runningJobs ? ' · ' + runningJobs + ' 个任务' : '')) : null,
              batch ? h('span', { className: 'oc-batch' },
                h('span', { className: 'oc-batch-dot' }),
                '批量生成 ' + batch.done + ' / ' + batch.total,
                batch.failed ? h('span', { className: 'oc-batch-fail' }, '失败 ' + batch.failed) : null) : null),

            !project ? h('div', { className: 'oc-center' },
              h('div', { className: 'oc-hero' },
                h('div', { className: 'oc-hero-title' }, '口播短视频无限画布'),
                h('div', { className: 'oc-hero-sub' }, '口播稿 → 数字人音频 → SRT 字幕 → 分镜时间戳 → 数字人视频 / 代码动效 / 软件实录 → 合成成片'),
                h('div', { className: 'oc-row' },
                  h('button', { type: 'button', className: 'oc-btn oc-btn-primary', onClick: createProject }, '新建项目'),
                  h('button', { type: 'button', className: 'oc-btn', onClick: function () { setModelsOpen(true) } }, '先配置模型'))))
              : null,

            project ? h('div', { className: 'oc-world', style: { transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')' } },
              h('svg', { className: 'oc-edges' }, (project.edges || []).map(function (edge) {
                var a = project.nodes.filter(function (n) { return n.id === edge.from })[0]
                var b = project.nodes.filter(function (n) { return n.id === edge.to })[0]
                if (!a || !b) return null
                var x1 = a.x + (a.w || KINDS[a.kind].w)
                var y1 = a.y + 70
                // Edges out of the 分镜时间戳 node start at the row of the sentence
                // they carry, so several lines → one shot is visible at a glance.
                if (a.kind === 'storyboard' && edge.fromRow != null) {
                  var sorted = ((project.srt && project.srt.cues) || []).slice().sort(function (u, v) { return Number(u.start) - Number(v.start) })
                  var row = -1
                  for (var ri = 0; ri < sorted.length; ri++) {
                    var sidx = sorted[ri].sentence != null ? Number(sorted[ri].sentence) : ri
                    if (sidx === Number(edge.fromRow)) { row = ri; break }
                  }
                  if (row >= 0) y1 = a.y + 78 + row * 28
                }
                var x2 = b.x
                var y2 = b.y + 70
                var mx = (x1 + x2) / 2
                return h('path', {
                  key: edge.id,
                  d: 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + x2 + ' ' + y2,
                  className: 'oc-edge',
                })
              })),
              wire ? (function () {
                var src = (project.nodes || []).filter(function (n) { return n.id === wire.from })[0]
                var rect = containerRef.current ? containerRef.current.getBoundingClientRect() : { left: 0, top: 0 }
                if (!src || !wire.x) return null
                var wx = (wire.x - rect.left - view.x) / view.zoom
                var wy = (wire.y - rect.top - view.y) / view.zoom
                var sx = src.x + (src.w || KINDS[src.kind].w)
                var sy = src.y + 70
                var mx = (sx + wx) / 2
                return h('svg', { className: 'oc-edges oc-wire-layer' },
                  h('path', { className: 'oc-edge oc-wire', d: 'M ' + sx + ' ' + sy + ' C ' + mx + ' ' + sy + ', ' + mx + ' ' + wy + ', ' + wx + ' ' + wy }))
              })() : null,
              (project.nodes || []).map(function (node) {
                return h(CanvasNode, {
                  key: node.id, node: node, project: project, zoom: view.zoom, selected: node.id === selectedId,
                  job: jobs[node.id],
                  onSelect: function (id) { setSelectedId(id) },
                  onMove: function (id, x, y) { patchNode(id, { x: x, y: y }) },
                  onMoveEnd: function () {},
                  onEditText: function (id, text) { patchNode(id, { text: text }) },
                  onEditCue: function (cueIndex, text) { editCue(cueIndex, text) },
                  onStoryboard: function (n) { applyScript(n.text, n.id) },
                  onGenerate: function (n) { startGenerate(n, {}) },
                  onOpenInspector: function () {},
                  picked: pickedSentences,
                  onToggleSentence: function (i) { toggleSentence(Number(i)) },
                  onRowPlus: function (i) {
                    var list = [Number(i)]
                    Object.keys(pickedSentences).forEach(function (k) { if (list.indexOf(Number(k)) < 0) list.push(Number(k)) })
                    setMenu({ step: 'kind', kind: null, sentenceIndex: null, multi: list })
                  },
                  onBuildPicked: function () { setMenu({ step: 'kind', kind: null, sentenceIndex: null, multi: pickedList.slice() }) },
                  onClearPicked: function () { setPickedSentences({}) },
                  onNodeMenu: function (n, x, y) { setCtx({ x: x, y: y, nodeId: n.id }) },
                  onWireStart: onWireStart,
                  onUploadFiles: uploadRefs,
                  isWiring: function () { return !!wireRef.current },
                  wiringFrom: wire ? wire.from : null,
                })
              }))
              : null,

            project && !project.nodes.length ? h('div', { className: 'oc-center' }, h('div', { className: 'oc-empty' }, '画布是空的，点左上角「新建节点」开始。')) : null,

            h('div', { className: 'oc-hint oc-canvas-hint' }, '拖动空白处平移 · 滚轮缩放 · 拖动节点标题移动 · 长按节点拖到另一个节点可连线 · 右键节点新建下游节点')),

          ctx ? h('div', {
            className: 'oc-ctx',
            style: { left: Math.min(ctx.x, (window.innerWidth || 1200) - 210), top: Math.min(ctx.y, (window.innerHeight || 800) - 320) },
            onPointerDown: function (e) { e.stopPropagation() },
            onContextMenu: function (e) { e.preventDefault() },
          },
            h('div', { className: 'oc-ctx-head' }, '从这里新建节点'),
            KIND_ORDER.filter(function (k) {
              if (k === 'storyboard') return !storyboardOf(project)
              return true
            }).map(function (k) {
              return h('button', {
                key: k, type: 'button', className: 'oc-ctx-item',
                onClick: function (e) { e.stopPropagation(); createNodeFrom(ctx.nodeId, k) },
              },
                h('span', { className: 'oc-ctx-dot', style: { background: KINDS[k].color } }),
                KINDS[k].label)
            })) : null,

          selected ? h(Inspector, {
            project: project, node: selected, models: models, defaults: defaults, jobs: jobs, job: jobs[selected.id],
            recording: recording,
            onPatch: patchNode,
            onGenerate: function (node, body) { startGenerate(node, body) },
            onUpload: uploadTo,
            onImportPath: importPath,
            onRecordMotion: recordMotion,
            onDelete: deleteNode,
            onEditCue: editCue,
            onDeleteAsset: deleteAsset,
            onApplyScript: applyScript,
            onAsk: ask,
            onChat: nodeChatSend,
            onUploadFiles: uploadRefs,
            onClose: function () { setSelectedId(null) },
            onOpenModels: function () { setModelsOpen(true) },
            onOpenSettings: function () { setSettingsOpen(true) },
          }) : null),

        menu ? h('div', { className: 'oc-menu-mask', onPointerDown: function (e) { if (e.target === e.currentTarget) setMenu(null) } },
          h(AddMenu, {
            project: project, state: menu,
            hasTimeline: ((project.srt && project.srt.cues) || []).length > 0 || !!storyboardOf(project),
            onBack: function () { setMenu({ step: 'kind', kind: null, sentenceIndex: null }) },
            onPickSentence: function (kind) { setMenu({ step: 'sentence', kind: kind, sentenceIndex: null }) },
            onCreate: function (kind, sentenceIndex) { createNode(kind, sentenceIndex) },
            onBatchCreate: function (kind, list, autoGen) { createPicked(kind, list, autoGen) },
          })) : null,

        modelsOpen ? h(ModelsModal, {
          models: models, defaults: defaults,
          onClose: function () { setModelsOpen(false) },
          toast: toast,
          onSaved: function (m, d) { setModels(m); setDefaults(d) },
        }) : null,

        settingsOpen && project ? h(SettingsModal, {
          project: project,
          onClose: function () { setSettingsOpen(false) },
          onSave: saveSettings,
          onDeleteProject: deleteProject,
          onAsk: ask,
        }) : null,

        recording ? h('div', { className: 'oc-recording' },
          h('div', { className: 'oc-recording-card' },
            h('div', { className: 'oc-modal-title' }, '正在录制动效视频'),
            h('div', { className: 'oc-hint' }, '按 1080×1920 / 30fps 实时渲染，完成后自动上传并挂到节点上。'),
            h(Progress, { value: (recording.progress || 0) * 100 }),
            h('div', { className: 'oc-dim' }, Math.round((recording.progress || 0) * 100) + '%'))) : null,

        h('div', { className: 'oc-toasts' }, toasts.map(function (t) {
          return h('div', { className: 'oc-toast ' + (t.kind || 'info'), key: t.id }, t.msg)
        })),

        dialog ? h(Dialog, {
          state: dialog,
          onClose: function () { setDialog(null) },
          onSubmit: function (v) {
            var st = dialog
            setDialog(null)
            if (st && st.onSubmit) st.onSubmit(v)
          },
        }) : null
      )
    }

    // ------------------------------------------------------------- sidebar icon
    function SidebarIcon(props) {
      var size = (props && props.size) || 16
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-label': '口播画布' },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M7 4v16M17 4v16', stroke: 'currentColor', strokeWidth: 1.2, opacity: 0.45 }),
        h('path', { d: 'M10.5 9.8v4.4l3.8-2.2-3.8-2.2z', fill: 'currentColor' }))
    }

    // ------------------------------------------------------------------- css
    var CSS = [
      '.oc-root{position:relative;width:100%;height:100%;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsh-bg,#0f1115);color:var(--dsh-text,#e8ebf2);font:13px/1.45 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
      '.oc-root *{box-sizing:border-box}',
      '.oc-topbar{flex:0 0 auto;height:46px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(20,23,29,.94);z-index:5}',
      '.oc-brand{display:flex;align-items:center;gap:8px;margin-right:6px}',
      '.oc-logo{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#6c8cff,#b06cff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;color:#fff}',
      '.oc-title{font-weight:600;font-size:14px;letter-spacing:.3px}',
      '.oc-spacer{flex:1}',
      '.oc-dim{color:#8b93a5;font-size:12px;white-space:nowrap}',
      '.oc-hint{color:#7f8798;font-size:11.5px;line-height:1.5}',
      '.oc-checkline{display:flex;align-items:center;gap:7px;font-size:12px;color:#c3c9d6;cursor:pointer;padding:2px 0}',
      '.oc-checkline input{accent-color:#5b7cfa;width:14px;height:14px;margin:0}',
      '.oc-pad{padding:8px 12px}',
      '.oc-body{flex:1;display:flex;min-height:0;position:relative}',
      '.oc-sentences{width:268px;flex:0 0 auto;border-right:1px solid rgba(255,255,255,.07);background:rgba(18,21,26,.85);display:flex;flex-direction:column;min-height:0}',
      '.oc-panel-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 6px;font-weight:600}',
      '.oc-panel-actions{display:flex;align-items:center;gap:8px}',
      '.oc-mini{font-size:11px;padding:2px 7px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#cfd5e3;cursor:pointer}',
      '.oc-mini:hover{border-color:rgba(108,140,255,.6);color:#dfe6ff}',
      '.oc-pickbar{display:flex;align-items:center;gap:8px;margin:2px 12px 6px;padding:6px 8px;border-radius:8px;background:rgba(91,124,250,.14);border:1px solid rgba(91,124,250,.35)}',
      '.oc-pickbar-count{flex:1;font-size:11px;color:#cfd8ff}',
      '.oc-pickbar .oc-btn{padding:3px 9px;font-size:11px}',
      '.oc-sentence-check{width:14px;height:14px;margin:0;flex:0 0 auto;accent-color:#5b7cfa;cursor:pointer}',
      '.oc-sentence.picked{border-color:rgba(91,124,250,.6);background:rgba(91,124,250,.1)}',
      '.oc-sentence-list{flex:1;overflow:auto;padding:4px 8px 16px}',
      '.oc-sentence{border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:8px 9px;margin:6px 0;background:rgba(255,255,255,.025)}',
      '.oc-sentence-head{display:flex;align-items:center;gap:6px}',
      '.oc-sentence-idx{width:18px;height:18px;flex:0 0 auto;border-radius:50%;background:rgba(108,140,255,.2);color:#a8b9ff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600}',
      '.oc-sentence-time{color:#78808f;font-size:11px;font-variant-numeric:tabular-nums;flex:1}',
      '.oc-sentence-add{width:20px;height:20px;border-radius:6px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#cfd5e3;cursor:pointer;line-height:1}',
      '.oc-sentence-add:hover{background:rgba(108,140,255,.22)}',
      '.oc-sentence-text{font-size:12px;color:#c3c9d6;margin:5px 0 6px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.oc-sentence-nodes{display:flex;gap:5px}',
      '.oc-pip{display:flex;align-items:center;justify-content:center;min-width:22px;height:15px;padding:0 4px;border-radius:4px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#8d95a6;font-size:9px;line-height:1;cursor:pointer}',
      '.oc-pip:hover{border-color:rgba(108,140,255,.6);color:#dfe6ff}',
      '.oc-pip.on{color:#0b0d11;border-color:transparent;font-weight:600}',
      '.oc-pip.run{box-shadow:0 0 0 2px rgba(108,140,255,.55)}',
      '.oc-canvas{flex:1;position:relative;overflow:hidden;min-width:0;background-color:#0c0e12;background-image:radial-gradient(circle,rgba(255,255,255,.12) 1px,transparent 1px);cursor:default}',
      '.oc-toolbar{position:absolute;left:12px;top:12px;display:flex;align-items:center;gap:6px;z-index:4;padding:6px;border-radius:10px;background:rgba(20,23,29,.9);border:1px solid rgba(255,255,255,.08);backdrop-filter:blur(6px)}',
      '.oc-zoom{min-width:44px;text-align:center;font-size:12px;color:#b9c0ce;font-variant-numeric:tabular-nums}',
      '.oc-canvas-hint{position:absolute;left:14px;bottom:10px;z-index:3;pointer-events:none;opacity:.75}',
      '.oc-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}',
      '.oc-edges{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}',
      '.oc-edge{fill:none;stroke:rgba(140,160,220,.45);stroke-width:1.6;stroke-dasharray:5 5}',
      '.oc-node{position:absolute;background:#1b1f27;border:1px solid rgba(255,255,255,.09);border-top:3px solid #6c8cff;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden}',
      '.oc-node.is-selected{outline:2px solid rgba(108,140,255,.85);outline-offset:2px}',
      '.oc-node.is-busy{box-shadow:0 0 0 1px rgba(108,140,255,.35),0 12px 30px rgba(0,0,0,.4)}',
      '.oc-nodehead{display:flex;align-items:center;gap:7px;padding:8px 9px;cursor:grab;border-bottom:1px solid rgba(255,255,255,.06);user-select:none}',
      '.oc-nodehead:active{cursor:grabbing}',
      '.oc-kind{width:20px;height:20px;flex:0 0 auto;border-radius:6px;color:#11141a;font-weight:800;font-size:11px;display:inline-flex;align-items:center;justify-content:center}',
      '.oc-title{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.oc-headright{margin-left:auto;display:flex;align-items:center;gap:5px}',
      '.oc-badge{font-size:10px;color:#aab4c8;background:rgba(255,255,255,.07);border-radius:5px;padding:1px 4px}',
      '.oc-dot{width:7px;height:7px;border-radius:50%;display:inline-block;background:#6b7280;flex:0 0 auto}',
      '.oc-dot-running{background:#6c8cff;box-shadow:0 0 0 3px rgba(108,140,255,.22);animation:ocpulse 1.2s infinite}',
      '.oc-dot-done{background:#3ecf8e}.oc-dot-error{background:#f0605d}.oc-dot-ready{background:#f2cd62}',
      '@keyframes ocpulse{0%,100%{opacity:1}50%{opacity:.45}}',
      '.oc-nodebody{padding:9px;display:flex;flex-direction:column;gap:7px;min-height:70px}',
      '.oc-sub{font-size:11.5px;color:#8f98aa}',
      '.oc-script{font-size:12px;color:#cfd5e2;line-height:1.55;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}',
      '.oc-empty{font-size:12px;color:#79808f;padding:8px 0;line-height:1.5}',
      '.oc-mini-row{display:flex;gap:6px;flex-wrap:wrap}',
      '.oc-chip{font-size:11px;color:#a9b2c3;background:rgba(255,255,255,.06);border-radius:5px;padding:1px 6px}',
      '.oc-cues{display:flex;flex-direction:column;gap:3px}',
      '.oc-cue{display:flex;gap:8px;font-size:11.5px;color:#aeb6c5}',
      '.oc-cue-t{color:#7f8798;font-variant-numeric:tabular-nums}',
      '.oc-cue-x{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.oc-sb-list{display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto}',
      '.oc-sb-row{display:flex;align-items:center;gap:6px;padding:2px 3px;border-radius:5px}',
      '.oc-sb-row.has{background:rgba(245,162,93,.10)}',
      '.oc-sb-idx{flex:0 0 16px;height:16px;border-radius:4px;background:rgba(255,255,255,.08);color:#cfd5e2;font-size:10.5px;line-height:16px;text-align:center}',
      '.oc-sb-t{flex:0 0 auto;font-size:10.5px;color:#8d95a6;font-variant-numeric:tabular-nums}',
      '.oc-sb-input{flex:1 1 auto;min-width:0;background:transparent;border:1px solid transparent;border-radius:5px;color:#dfe4ee;font:11.5px/1.4 inherit;padding:2px 4px}',
      '.oc-sb-input:hover{border-color:rgba(255,255,255,.10)}',
      '.oc-sb-input:focus{outline:none;border-color:rgba(91,124,250,.55);background:rgba(0,0,0,.28)}',
      '.oc-sb-insp{display:flex;flex-direction:column;gap:4px;max-height:46vh;overflow:auto}',
      '.oc-sb-insp-row{display:flex;align-items:center;gap:6px}',
      '.oc-sb-check{flex:0 0 auto;width:13px;height:13px;margin:0;accent-color:#5b7cfa;cursor:pointer}',
      '.oc-sb-row.picked{background:rgba(91,124,250,.18);box-shadow:inset 0 0 0 1px rgba(91,124,250,.35)}',
      '.oc-sb-plus{flex:0 0 auto;width:18px;height:18px;padding:0;line-height:1;font-size:13px}',
      '.oc-sb-bar{display:flex;align-items:center;gap:8px;margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.07)}',
      '.oc-sb-bar-count{font-size:11.5px;color:#cfd5e2}',
      '.oc-refs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0}',
      '.oc-ref-img{width:100%;height:88px;object-fit:cover;border-radius:7px;border:1px solid rgba(255,255,255,.08)}',
      '.oc-ref-vid{width:100%;height:88px;object-fit:cover;border-radius:7px;background:#000;border:1px solid rgba(255,255,255,.08)}',
      '.oc-upload{position:relative;text-align:center;justify-content:center}',
      '.oc-node.is-wiring{outline:2px dashed rgba(108,140,255,.9);outline-offset:3px;cursor:crosshair}',
      '.oc-wire-layer{pointer-events:none}',
      '.oc-edge.oc-wire{stroke:rgba(108,140,255,.95);stroke-width:2;stroke-dasharray:6 4}',
      '.oc-ctx{position:fixed;z-index:60;width:196px;background:#1b1f27;border:1px solid rgba(255,255,255,.12);border-radius:10px;box-shadow:0 18px 40px rgba(0,0,0,.5);padding:5px;display:flex;flex-direction:column;gap:1px}',
      '.oc-ctx-head{font-size:10.5px;color:#8d95a6;padding:5px 8px 6px}',
      '.oc-ctx-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;border-radius:6px;color:#dfe4ee;font:12px/1.6 inherit;padding:5px 8px;cursor:pointer}',
      '.oc-ctx-item:hover{background:rgba(255,255,255,.07)}',
      '.oc-ctx-dot{width:9px;height:9px;border-radius:3px;flex:0 0 auto}',
      '.oc-chat{display:flex;flex-direction:column;gap:7px}',
      '.oc-chat-list{display:flex;flex-direction:column;gap:5px;max-height:220px;overflow:auto;padding:2px}',
      '.oc-chat-msg{font-size:11.5px;line-height:1.55;padding:6px 8px;border-radius:8px;max-width:92%;white-space:pre-wrap;word-break:break-word}',
      '.oc-chat-msg.is-user{align-self:flex-end;background:rgba(91,124,250,.20);color:#e7ecff}',
      '.oc-chat-msg.is-bot{align-self:flex-start;background:rgba(255,255,255,.05);color:#cfd5e2}',
      '.oc-sec{display:flex;flex-direction:column;gap:6px}',
      '.oc-sec-title{font-size:11.5px;font-weight:700;color:#aeb7c9;letter-spacing:.02em}',
      '.oc-audio{width:100%;height:32px}',
      '.oc-video{width:100%;max-height:210px;border-radius:8px;background:#000}',
      '.oc-motion{width:100%;max-height:240px;border-radius:8px;background:#000;object-fit:cover}',
      '.oc-link{color:#8fb0ff;background:none;border:none;padding:0;font-size:11.5px;cursor:pointer;text-decoration:none}',
      '.oc-link:hover{text-decoration:underline}',
      '.oc-link-danger{color:#f0857f}',
      '.oc-nodefoot{display:flex;gap:6px;padding:8px 9px;border-top:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.02)}',
      '.oc-busy{padding:0 9px 8px}',
      '.oc-busy-msg{font-size:11px;color:#98a1b4;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.oc-progress{height:5px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}',
      '.oc-progress-bar{height:100%;background:linear-gradient(90deg,#6c8cff,#b06cff);transition:width .3s}',
      '.oc-error{font-size:11px;color:#f08a84;padding:0 9px 8px;white-space:pre-wrap;word-break:break-word}',
      '.oc-btn{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#dfe4ee;border-radius:7px;padding:4px 9px;font-size:12px;cursor:pointer;line-height:1.4;white-space:nowrap}',
      '.oc-btn:hover{background:rgba(255,255,255,.08)}',
      '.oc-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.oc-btn-primary{background:linear-gradient(135deg,#5f7dff,#8c63ff);border-color:transparent;color:#fff;font-weight:600}',
      '.oc-btn-primary:hover{filter:brightness(1.08);background:linear-gradient(135deg,#5f7dff,#8c63ff)}',
      '.oc-btn-ghost{background:transparent}',
      '.oc-btn-danger{color:#f0908a;border-color:rgba(240,96,93,.35)}',
      '.oc-btn-accent{color:#e7ecff;background:rgba(91,124,250,.16);border-color:rgba(91,124,250,.45)}',
      '.oc-btn-accent:hover{background:rgba(91,124,250,.26)}',
      '.oc-chip-warn{color:#f2cd62;background:rgba(242,205,98,.12)}',
      '.oc-script-edit{width:100%;min-height:120px;font-size:12px;line-height:1.55}',
      '.oc-modal-sm{width:440px}',
      '.oc-modal-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:10px}',
      '.oc-iconbtn{border:none;background:transparent;color:#98a1b4;cursor:pointer;font-size:13px;padding:2px 5px;border-radius:6px}',
      '.oc-iconbtn:hover{background:rgba(255,255,255,.08);color:#fff}',
      '.oc-insp{width:360px;flex:0 0 auto;border-left:1px solid rgba(255,255,255,.08);background:#15181f;display:flex;flex-direction:column;min-height:0;z-index:3}',
      '.oc-insp-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07)}',
      '.oc-insp-title{display:flex;align-items:center;gap:8px;font-weight:600;min-width:0}',
      '.oc-insp-body{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:11px}',
      '.oc-insp-foot{margin-top:auto;padding-top:10px;border-top:1px solid rgba(255,255,255,.07)}',
      '.oc-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.oc-field-inline{flex-direction:row;align-items:center;gap:6px}',
      '.oc-label{font-size:11.5px;color:#9aa3b6;font-weight:500}',
      '.oc-input{width:100%;background:#0f1217;border:1px solid rgba(255,255,255,.12);color:#e6eaf2;border-radius:7px;padding:5px 8px;font-size:12px;outline:none;font-family:inherit}',
      '.oc-input:focus{border-color:rgba(108,140,255,.7)}',
      '.oc-input-sm{width:auto;min-width:90px}',
      '.oc-textarea{resize:vertical;line-height:1.5}',
      '.oc-mono{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:11.5px}',
      '.oc-color{width:100%;height:28px;background:transparent;border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:2px}',
      '.oc-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
      '.oc-actions{display:flex;gap:7px;flex-wrap:wrap}',
      '.oc-preview-wrap{max-width:150px}',
      '.oc-scenes{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:5px}',
      '.oc-scene{display:flex;gap:7px;font-size:11.5px;color:#aab2c2;padding:2px 3px}',
      '.oc-scene-i{width:18px;color:#7e879a;text-align:right;flex:0 0 auto}',
      '.oc-scene-t{color:#7e879a;font-variant-numeric:tabular-nums;flex:0 0 auto}',
      '.oc-scene-x{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.oc-job{border:1px solid rgba(108,140,255,.25);background:rgba(108,140,255,.07);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}',
      '.oc-job-line{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#b9c3d8}',
      '.oc-log{font-size:11px;color:#8e97a9;white-space:pre-wrap;word-break:break-word}',
      '.oc-assets{display:flex;flex-direction:column;gap:4px}',
      '.oc-asset{display:flex;align-items:center;gap:8px;font-size:11.5px;color:#aab2c2}',
      '.oc-asset-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.oc-menu-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:20;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}',
      '.oc-menu{width:300px;background:#191d25;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:6px;box-shadow:0 24px 60px rgba(0,0,0,.5);max-height:70vh;overflow:auto}',
      '.oc-menu-wide{width:420px}',
      '.oc-menu-head{display:flex;align-items:center;justify-content:space-between;padding:7px 9px;font-size:12px;color:#9aa3b6;font-weight:600}',
      '.oc-menu-preset{font-size:11px;color:#8f97a8;padding:0 9px 7px;line-height:1.5;max-height:44px;overflow:hidden}',
      '.oc-menu-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:none;color:#dfe4ee;padding:7px 9px;border-radius:8px;cursor:pointer;font-size:12.5px}',
      '.oc-menu-item:hover{background:rgba(108,140,255,.14)}',
      '.oc-menu-idx{width:22px;height:22px;flex:0 0 auto;border-radius:6px;background:rgba(255,255,255,.07);display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:#aab4c8}',
      '.oc-menu-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c8cfdc}',
      '.oc-menu-time{color:#7f8798;font-size:11px;font-variant-numeric:tabular-nums}',
      '.oc-menu-hint{margin-left:auto;font-size:10.5px;color:#7f8798}',
      '.oc-menu-name{flex:1}',
      '.oc-menu-empty{padding:12px;color:#8a93a6;font-size:12px}',
      '.oc-menu-list{max-height:52vh;overflow:auto}',
      '.oc-menu-actions{display:flex;align-items:center;gap:10px}',
      '.oc-menu-check{cursor:pointer}',
      '.oc-menu-check input{accent-color:#5b7cfa;width:14px;height:14px;margin:0;flex:0 0 auto}',
      '.oc-menu-check.on{background:rgba(91,124,250,.14)}',
      '.oc-menu-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 9px 5px;border-top:1px solid rgba(255,255,255,.07);margin-top:6px}',
      '.oc-batch{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:#cfd6e6;background:rgba(91,124,250,.14);border:1px solid rgba(91,124,250,.3);border-radius:999px;padding:2px 9px}',
      '.oc-batch-dot{width:6px;height:6px;border-radius:50%;background:#5b7cfa;animation:ocpulse 1.1s ease-in-out infinite}',
      '.oc-batch-fail{color:#f0908a}',
      '.oc-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:30;display:flex;align-items:center;justify-content:center;padding:24px}',
      '.oc-modal{width:560px;max-width:96vw;max-height:88vh;background:#171a21;border:1px solid rgba(255,255,255,.1);border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6)}',
      '.oc-modal-lg{width:900px}',
      '.oc-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.07)}',
      '.oc-modal-title{font-size:14px;font-weight:600;margin-bottom:2px}',
      '.oc-modal-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.07)}',
      '.oc-defaults{display:flex;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.07)}',
      '.oc-models{padding:12px 16px;display:flex;flex-direction:column;gap:10px;overflow:auto}',
      '.oc-model{border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:10px;background:rgba(255,255,255,.02);display:flex;flex-direction:column;gap:8px}',
      '.oc-model-head{display:flex;align-items:center;gap:8px}',
      '.oc-model-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.oc-model-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.oc-test{font-size:11.5px;color:#8f98aa}',
      '.oc-test.ok{color:#5fd0a5}.oc-test.bad{color:#f0857f}',
      '.oc-switch{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:#aab2c2;cursor:pointer}',
      '.oc-switch input{accent-color:#6c8cff}',
      '.oc-priority{display:flex;flex-direction:column;gap:4px}',
      '.oc-priority-row{display:flex;align-items:center;gap:8px}',
      '.oc-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:24px}',
      '.oc-hero{max-width:520px;background:rgba(24,28,36,.9);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:26px;display:flex;flex-direction:column;gap:12px;align-items:center}',
      '.oc-hero-title{font-size:20px;font-weight:700}',
      '.oc-hero-sub{font-size:12px;color:#98a1b4;line-height:1.7}',
      '.oc-select-project{width:auto;max-width:260px}',
      '.oc-ffmpeg{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:#98a1b4}',
      '.oc-toasts{position:fixed;right:14px;bottom:14px;display:flex;flex-direction:column;gap:8px;z-index:40;pointer-events:none}',
      '.oc-toast{background:#1d2229;border:1px solid rgba(255,255,255,.12);border-left:3px solid #6c8cff;border-radius:8px;padding:8px 12px;font-size:12px;color:#dfe4ee;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,.4);word-break:break-word}',
      '.oc-toast.error{border-left-color:#f0605d}',
      '.oc-recording{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;display:flex;align-items:center;justify-content:center}',
      '.oc-recording-card{width:340px;background:#171a21;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}',
    ].join('\n')

    // ------------------------------------------------------------------- apply
    // Slots are declared by the shell entries, which may load AFTER this
    // bundle. ctx.slots.inject() defers our registration until the declaration
    // exists (and re-installs it if the shell collapses and re-declares), so
    // the panel appears regardless of plugin load order.
    function apply(ctx) {
      // The shell's layout Service knows which central panel is visible; we
      // use it to re-open the drawing board when the user pinned it.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['layout'], function (sub) {
          try { LAYOUT = sub.layout || (sub.get ? sub.get('layout') : null) } catch (e) { LAYOUT = null }
        })
      }
      var slots = ctx.slots
      function contribute(slotName, spec, Component) {
        if (slots && typeof slots.inject === 'function') {
          slots.inject(slotName, function () { return slots.register(spec, Component) })
          return
        }
        // Runtimes without slots.inject(): register now and keep retrying while
        // the shell entry that declares this slot has not mounted yet.
        var left = 20
        function attempt() {
          try { slots.register(spec, Component) } catch (err) {
            if (left-- > 0) setTimeout(attempt, 300)
          }
        }
        attempt()
      }
      contribute('main', {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: function () { return {} },
      }, App)
      contribute('sidebar.panellist', {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 6,
        label: function () { return '口播画布' },
        locale: NS,
        inject: function () { return {} },
      }, SidebarIcon)
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
