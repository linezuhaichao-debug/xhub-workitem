/* x-hub Workitem 扩展：把 workitem 前端的同源副本接到本地 4777 服务。
 *
 * 背景：宿主给扩展页的 CSP 是 frame-src 'none' / connect-src 'self'，
 * 扩展页不能 iframe、也不能直连 127.0.0.1:4777；但同源静态文件与 fetch 是允许的。
 * 所以扩展把仓库里的 workitems_ui/public 同步到自己的 web/ 目录（同源），
 * 本脚本注入在 app.js 之前，把对 /api/* 与 /attachments/* 的请求改走 x-hub 桥 → 扩展后端 → 4777。
 */
(function () {
  'use strict'
  if (window.__xhubWorkitemShim) return
  window.__xhubWorkitemShim = true

  var PREFIXES = ['/api/', '/attachments/']
  var bridge = window.xhub

  // 宿主没把桥注入到子页面 → 回面板改用窗口方式（面板页一定有桥）
  if (!bridge || !bridge.service) {
    location.replace('../view/index.html?nobridge=1')
    return
  }

  function toTarget(url) {
    if (typeof url !== 'string' || !url) return null
    try {
      var abs = new URL(url, location.href)
      if (abs.origin !== location.origin) return null
      for (var i = 0; i < PREFIXES.length; i++) {
        if (abs.pathname.indexOf(PREFIXES[i]) === 0) return abs.pathname + abs.search
      }
      return null
    } catch (_) {
      return null
    }
  }

  function headersToObject(headers) {
    var out = {}
    if (!headers) return out
    if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
      headers.forEach(function (value, key) { out[key] = value })
      return out
    }
    if (Array.isArray(headers)) {
      headers.forEach(function (pair) { if (pair && pair.length === 2) out[pair[0]] = pair[1] })
      return out
    }
    Object.keys(headers).forEach(function (key) { out[key] = headers[key] })
    return out
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () {
        var text = String(reader.result || '')
        var comma = text.indexOf(',')
        resolve(comma >= 0 ? text.slice(comma + 1) : '')
      }
      reader.onerror = function () { reject(reader.error) }
      reader.readAsDataURL(blob)
    })
  }

  function base64ToBlob(base64, type) {
    var binary = atob(base64 || '')
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type: type || 'application/octet-stream' })
  }

  function proxy(target, options) {
    options = options || {}
    var payload = {
      path: target,
      method: options.method || 'GET',
      headers: options.headers || {},
    }
    if (options.bodyText != null) payload.body = options.bodyText
    if (options.bodyBase64 != null) payload.bodyBase64 = options.bodyBase64
    return bridge.service
      .request('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      .then(function (res) { return res.json() })
      .then(function (data) {
        if (!data || data.error) throw new Error((data && data.error) || '代理请求失败')
        return data
      })
  }

  // ---- fetch 覆写：/api/* 与 /attachments/* 全部走桥 ----
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || ''
    var target = toTarget(url)
    if (!target) {
      if (nativeFetch) return nativeFetch(input, init)
      return Promise.reject(new TypeError('fetch 不可用'))
    }
    init = init || {}
    var method = String(init.method || (input && input.method) || 'GET').toUpperCase()
    var headers = headersToObject(init.headers || (input && input.headers))
    var body = init.body != null ? init.body : input && input.body

    var prepared
    if (body == null) prepared = Promise.resolve({})
    else if (typeof body === 'string') prepared = Promise.resolve({ bodyText: body })
    else if (typeof Blob !== 'undefined' && body instanceof Blob) {
      prepared = blobToBase64(body).then(function (base64) { return { bodyBase64: base64 } })
    } else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      prepared = Promise.resolve({ bodyText: body.toString() })
    } else {
      prepared = Promise.resolve({ bodyText: String(body) })
    }

    return prepared
      .then(function (extra) {
        return proxy(target, {
          method: method,
          headers: headers,
          bodyText: extra.bodyText,
          bodyBase64: extra.bodyBase64,
        })
      })
      .then(function (data) {
        var outHeaders = {}
        if (data.headers) {
          Object.keys(data.headers).forEach(function (key) {
            if (data.headers[key]) outHeaders[key] = data.headers[key]
          })
        }
        var status = Number(data.status) || 200
        var payload
        if (status === 204 || status === 304) payload = null
        else if (data.encoding === 'base64') payload = base64ToBlob(data.body, data.headers && data.headers['content-type'])
        else payload = data.body == null ? '' : String(data.body)
        return new Response(payload, { status: status, headers: outHeaders })
      })
  }

  // ---- 图片 / 视频：/attachments/* 转成 blob URL ----
  var blobCache = {}
  function ensureBlobUrl(target) {
    if (blobCache[target]) return blobCache[target]
    blobCache[target] = proxy(target, {})
      .then(function (data) {
        var type = (data.headers && data.headers['content-type']) || 'application/octet-stream'
        var blob = data.encoding === 'base64' ? base64ToBlob(data.body, type) : new Blob([String(data.body || '')], { type: type })
        return URL.createObjectURL(blob)
      })
      .catch(function () { return '' })
    return blobCache[target]
  }

  var MEDIA = ['IMG', 'VIDEO', 'SOURCE', 'AUDIO']
  function rewriteElement(el) {
    if (!el || el.nodeType !== 1) return
    if (!el.tagName || MEDIA.indexOf(el.tagName) < 0) return
    var src = el.getAttribute('src') || ''
    var target = toTarget(src)
    if (!target) return
    if (el.getAttribute('data-xhub-src') === target) return
    el.setAttribute('data-xhub-src', target)
    ensureBlobUrl(target).then(function (blobUrl) {
      if (blobUrl) el.setAttribute('src', blobUrl)
    })
  }

  function sweep(root) {
    if (!root || root.nodeType !== 1) return
    rewriteElement(root)
    var list = root.querySelectorAll('img[src],video[src],source[src],audio[src]')
    for (var i = 0; i < list.length; i++) rewriteElement(list[i])
  }

  if (typeof MutationObserver === 'function') {
    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes
        for (var j = 0; j < added.length; j++) sweep(added[j])
      }
    }).observe(document.documentElement, { childList: true, subtree: true })
  }

  function bootSweep() { sweep(document.body) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootSweep)
  else bootSweep()
})()
