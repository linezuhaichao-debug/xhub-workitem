/* x-hub Workitem 扩展：在工作区界面里加一个「全部」页签。
 *
 * 复用个人视图的整套布局与渲染，只做三件事：
 * 1) 左栏「甘特」下面加一个 全部 入口；
 * 2) 个人视图的数据源放开 isAssignedToActor 限制 → 显示所有人的工单；
 * 3) 头部加「执行人」下拉（默认所有人），并隐藏「快捷」「创建工单」。
 *
 * 该脚本注入在 app.js 之后、由扩展的 service 后端在同步同源副本时加进 web/index.html。
 */
(function () {
  'use strict'
  if (window.__xhubAllView) return
  window.__xhubAllView = true

  var STORE_KEY = 'xhub.workitem.all.assignee'
  var PAGE_SIZE = 30
  var scope = { active: false, assignee: '', expanded: {}, inHtml: false }
  var memberSig = ''

  function $(id) {
    return document.getElementById(id)
  }

  function readStored() {
    try { return localStorage.getItem(STORE_KEY) || '' } catch (e) { return '' }
  }

  function storeAssignee(value) {
    try {
      if (value) localStorage.setItem(STORE_KEY, value)
      else localStorage.removeItem(STORE_KEY)
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function autostart() {
    try { return new URLSearchParams(location.search).get('xhub-all') === '1' } catch (e) { return false }
  }

  function assigneeFromQuery() {
    try { return (new URLSearchParams(location.search).get('xhub-assignee') || '').trim() } catch (e) { return '' }
  }

  function injectStyle() {
    if ($('xhub-all-style')) return
    var style = document.createElement('style')
    style.id = 'xhub-all-style'
    style.textContent = [
      '.xhub-all-owner{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);white-space:nowrap;}',
      '.xhub-all-owner select{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--line-strong);',
      'border-radius:6px;padding:3px 8px;max-width:190px;cursor:pointer;}',
      '.xhub-all-owner select:focus{outline:none;border-color:var(--primary);}',
      'body.xhub-all-mode #personalPage .personal-head h2{color:var(--text);}',
      '.xhub-all-more{display:flex;align-items:center;gap:10px;padding:10px 12px;border-top:1px dashed var(--line);',
      'color:var(--muted);font-size:12px;}',      '.xhub-all-more button{font:inherit;color:var(--primary);background:var(--surface);border:1px solid var(--line-strong);',
      'border-radius:6px;padding:4px 12px;cursor:pointer;}',
      '.xhub-all-more button:hover{border-color:var(--primary);background:var(--primary-soft);}',
      '.xhub-req-list{padding:8px 12px 12px;}',
      '.xhub-req-list-head{color:var(--muted);font-size:12px;margin:4px 0 8px;}',
      '.xhub-req-list-head b{color:var(--text);}',
      '.xhub-req-list-wrap{max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:8px;}',
      '.xhub-req-list table{width:100%;border-collapse:collapse;font-size:12px;}',
      '.xhub-req-list th,.xhub-req-list td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;}',
      '.xhub-req-list th{position:sticky;top:0;z-index:1;background:var(--surface-soft);color:var(--muted);font-weight:500;}',
      '.xhub-req-list tbody tr:last-child td{border-bottom:none;}',
      '.xhub-req-list tr[data-personal-open]{cursor:pointer;}',
      '.xhub-req-list tr[data-personal-open]:hover td{background:var(--surface-hover);}',
      '.xhub-req-list td.key{font-family:"Cascadia Mono",Consolas,monospace;color:var(--muted);}',
      '.xhub-req-list td.title{max-width:560px;overflow:hidden;text-overflow:ellipsis;}',
      '.xhub-req-list td.done{color:var(--green);}',
    ].join('')
    document.head.appendChild(style)
  }

  function buildRailButton() {
    if ($('xhubAllRailBtn')) return
    var rail = document.querySelector('.rail')
    if (!rail) return
    var btn = document.createElement('button')
    btn.id = 'xhubAllRailBtn'
    btn.className = 'rail-item'
    btn.type = 'button'
    btn.title = '全部工单（所有人）'
    btn.setAttribute('data-xhub-all-rail', '1')
    btn.innerHTML = '<span>\u25a9</span><em>全部</em>'
    var anchor = $('allRailBtn')
    if (anchor && anchor.parentNode === rail) rail.insertBefore(btn, anchor.nextSibling)
    else rail.appendChild(btn)
    btn.addEventListener('click', function () { enterAll() })
  }

  function projectMembers() {
    var list = []
    try {
      var currentId = state.currentProjectId
      var projects = (state.bootstrap && state.bootstrap.projects) || []
      var project = null
      for (var i = 0; i < projects.length; i += 1) {
        if (projects[i].id === currentId || projects[i].project_id === currentId) { project = projects[i]; break }
      }
      list = (project && project.members) || (state.bootstrap && state.bootstrap.members) || []
    } catch (e) {
      list = []
    }
    var seen = {}
    var out = []
    list.forEach(function (member) {
      var login = String((member && (member.login || member.id)) || '').trim()
      if (!login || seen[login]) return
      seen[login] = true
      out.push({ login: login, name: String((member && (member.name || member.login)) || login) })
    })
    out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN') })
    return out
  }

  function assigneeName(login) {
    var members = projectMembers()
    for (var i = 0; i < members.length; i += 1) if (members[i].login === login) return members[i].name
    return login
  }

  function ensureAssigneeUi() {
    var actions = document.querySelector('#personalPage .personal-head-actions')
    if (!actions) return
    var wrap = $('xhubAllAssigneeWrap')
    if (!wrap) {
      wrap = document.createElement('label')
      wrap.id = 'xhubAllAssigneeWrap'
      wrap.className = 'xhub-all-owner'
      wrap.title = '按执行人筛选（默认所有人）'
      var label = document.createElement('span')
      label.textContent = '执行人'
      var select = document.createElement('select')
      select.id = 'xhubAllAssignee'
      select.addEventListener('change', function () {
        scope.assignee = select.value || ''
        storeAssignee(scope.assignee)
        refreshPersonal()
      })
      wrap.appendChild(label)
      wrap.appendChild(select)
      var anchor = $('qcEmbedBtn') || $('personalCreateBtn')
      if (anchor && anchor.parentNode === actions) actions.insertBefore(wrap, anchor)
      else actions.insertBefore(wrap, actions.firstChild)
    }
    syncAssigneeOptions()
    wrap.style.display = scope.active ? '' : 'none'
  }

  function syncAssigneeOptions() {
    var select = $('xhubAllAssignee')
    if (!select) return
    var members = projectMembers()
    var sig = members.map(function (m) { return m.login }).join('|')
    if (sig !== memberSig) {
      memberSig = sig
      while (select.firstChild) select.removeChild(select.firstChild)
      var allOption = document.createElement('option')
      allOption.value = ''
      allOption.textContent = '所有人'
      select.appendChild(allOption)
      members.forEach(function (member) {
        var option = document.createElement('option')
        option.value = member.login
        option.textContent = member.name
        select.appendChild(option)
      })
    }
    var matched = members.some(function (m) { return m.login === scope.assignee })
    if (members.length && !matched) {
      scope.assignee = ''
      storeAssignee('')
      matched = true
    }
    select.value = matched ? scope.assignee : ''
  }

  function toggleWriteButtons(hidden) {
    ;[$('qcEmbedBtn'), $('personalCreateBtn')].forEach(function (node) {
      if (!node) return
      node.style.display = hidden ? 'none' : ''
    })
  }

  function markRail() {
    var mine = $('xhubAllRailBtn')
    if (!mine) return
    if (scope.active) {
      mine.classList.add('active')
      ;['projectRailBtn', 'myRailBtn', 'statsRailBtn', 'allRailBtn'].forEach(function (id) {
        var node = $(id)
        if (node) node.classList.remove('active')
      })
      document.querySelectorAll('[data-module-tab]').forEach(function (tab) {
        tab.classList.remove('active')
      })
    } else {
      mine.classList.remove('active')
      if (typeof renderRailState === 'function') {
        try { renderRailState() } catch (e) { /* 忽略 */ }
      }
    }
  }

  function applyAllUi() {
    if (!scope.active) return
    ensureAssigneeUi()
    enhanceCreateDialog()
    document.body.classList.add('xhub-all-mode')
    var page = $('personalPage')
    if (page) {
      var heading = page.querySelector('.personal-head h2')
      if (heading) heading.textContent = '全部工单'
    }
    var identity = $('personalIdentityText')
    if (identity) {
      identity.textContent = scope.assignee
        ? '执行人：' + assigneeName(scope.assignee) + ' · 全部工单'
        : '所有人的工单 · 可按执行人筛选'
    }
    toggleWriteButtons(true)
    // 需求展开的提示文案：现在是子工单列表，不是甘特图
    var carets = document.querySelectorAll('#personalSections .personal-req-caret')
    for (var c = 0; c < carets.length; c += 1) {
      carets[c].title = '展开/收起子工单'
      carets[c].setAttribute('aria-label', '展开/收起子工单')
    }
    var reqRows = document.querySelectorAll('#personalSections tr[data-personal-req-row]')
    for (var r2 = 0; r2 < reqRows.length; r2 += 1) reqRows[r2].title = '点击展开/收起子工单'
    markRail()
  }

  function restoreUi() {
    document.body.classList.remove('xhub-all-mode')
    var page = $('personalPage')
    if (page) {
      var heading = page.querySelector('.personal-head h2')
      if (heading) heading.textContent = '我的工作'
    }
    toggleWriteButtons(false)
    var wrap = $('xhubAllAssigneeWrap')
    if (wrap) wrap.style.display = 'none'
    markRail()
  }

  function refreshPersonal() {
    var scrollY = window.scrollY
    try {
      renderPersonalView()
    } catch (e) { /* 忽略 */ }
    if (scrollY) {
      requestAnimationFrame(function () { window.scrollTo(0, scrollY) })
    }
  }

  // 每个分区首屏只渲染 30 行，行尾给「加载全部」；点开后再渲染整个分区。
  function installSectionPaging() {
    var originalItems = window.personalSectionItems
    var originalHtml = window.personalSectionHtml
    if (typeof originalItems !== 'function' || typeof originalHtml !== 'function') return

    window.personalSectionItems = function (section, settings) {
      var rows = originalItems.call(this, section, settings)
      if (!scope.active || !scope.inHtml || !section || !rows || !rows.length) return rows
      if (scope.expanded[section.id]) return rows
      return rows.slice(0, PAGE_SIZE)
    }

    window.personalSectionHtml = function (section) {
      if (!scope.active || !section) return originalHtml.apply(this, arguments)
      var total = 0
      try {
        total = originalItems.call(this, section, loadPersonalSettings(section)).length
      } catch (e) {
        total = 0
      }
      scope.inHtml = true
      var html
      try {
        html = originalHtml.apply(this, arguments)
      } finally {
        scope.inHtml = false
      }
      var expanded = Boolean(scope.expanded[section.id])
      var shown = expanded ? total : Math.min(PAGE_SIZE, total)
      html = html.replace(/(<h3>[^<]*<\/h3>\s*<strong>)\d+(<\/strong>)/, function (match, head, tail) {
        return head + total + tail
      })
      if (!total || total <= PAGE_SIZE) return html
      if (/class="personal-section collapsed"/.test(html)) return html
      var footer = expanded
        ? '<div class="xhub-all-more"><span>已显示全部 ' + total + ' 条</span>'
          + '<button type="button" data-xhub-all-less="' + section.id + '">收起</button></div>'
        : '<div class="xhub-all-more"><button type="button" data-xhub-all-more="' + section.id + '">加载全部 ' + total + ' 条</button>'
          + '<span>已显示前 ' + shown + ' 条</span></div>'
      var sectionEnd = html.lastIndexOf('</section>')
      if (sectionEnd >= 0) html = html.slice(0, sectionEnd) + footer + html.slice(sectionEnd)
      else html += footer
      return html
    }
  }

  // ---- 创建工单弹窗：默认带出当前迭代，校验失败给常驻提示（toast 容易漏看） ----
  function reqEscape(value) {
    try { if (typeof escapeHtml === 'function') return escapeHtml(value == null ? '' : String(value)) } catch (e) { /* 忽略 */ }
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  // 需求展开：用子工单列表代替甘特图
  function buildReqChildrenHtml(requirementItem, descendants) {
    var rows = Array.isArray(descendants) ? descendants.slice() : []
    var scheduled = rows.filter(function (item) { return item.start_date && item.due_date })
    var unscheduled = rows.filter(function (item) { return !(item.start_date && item.due_date) })
    var sorted = scheduled.slice().sort(function (a, b) {
      return String(a.start_date).localeCompare(String(b.start_date)) || String(a.key).localeCompare(String(b.key))
    }).concat(unscheduled.slice().sort(function (a, b) { return String(a.key).localeCompare(String(b.key)) }))

    var head = '<div class="xhub-req-list">'
      + '<div class="xhub-req-list-head">子工单 <b>' + sorted.length + '</b>'
      + ' · 已排期 ' + scheduled.length + ' · 未排期 ' + unscheduled.length
      + '（点击行打开工单）</div>'
    if (!sorted.length) {
      return head + '<div class="personal-req-gantt-empty">该需求下暂无子工单</div></div>'
    }
    var body = sorted.map(function (item) {
      var done = item.is_completed ? ' done' : ''
      return '<tr data-personal-open="' + reqEscape(item.project_id) + '|' + reqEscape(item.key) + '"'
        + ' title="' + reqEscape(item.title || '') + '">'
        + '<td class="key">' + reqEscape(item.key) + '</td>'
        + '<td class="title">' + reqEscape(item.title || '') + '</td>'
        + '<td>' + reqEscape(item.assignee || item.assignee_login || '') + '</td>'
        + '<td class="' + done.trim() + '">' + reqEscape(item.status || '') + '</td>'
        + '<td>' + reqEscape(item.priority || '') + '</td>'
        + '<td>' + reqEscape(item.iteration || '') + '</td>'
        + '<td>' + reqEscape(item.start_date || '') + '</td>'
        + '<td>' + reqEscape(item.due_date || '') + '</td>'
        + '</tr>'
    }).join('')
    var table = '<div class="xhub-req-list-wrap"><table><thead><tr>'
      + '<th>工单号</th><th>标题</th><th>执行人</th><th>状态</th><th>优先级</th><th>迭代</th><th>开始时间</th><th>截止时间</th>'
      + '</tr></thead><tbody>' + body + '</tbody></table></div>'
    return head + table + '</div>'
  }

  function preferredIteration() {
    try {
      if (typeof personalSectionDefs !== 'undefined' && typeof loadPersonalSettings === 'function') {
        var order = ['production', 'defects', 'requirements']
        for (var i = 0; i < order.length; i += 1) {
          var def = null
          for (var j = 0; j < personalSectionDefs.length; j += 1) {
            if (personalSectionDefs[j].id === order[i]) { def = personalSectionDefs[j]; break }
          }
          if (!def) continue
          var settings = loadPersonalSettings(def)
          var picked = settings && Array.isArray(settings.iteration) ? settings.iteration.filter(Boolean) : []
          if (picked.length === 1) return picked[0]
        }
      }
      if (state && state.activeIteration && state.activeIteration !== '__all__') return state.activeIteration
    } catch (e) { /* 忽略 */ }
    return ''
  }

  function describeCreateState() {
    function val(id) {
      var node = document.getElementById(id)
      return node ? String(node.value == null ? '' : node.value).slice(0, 40) : ''
    }
    var info = {
      pending: null,
      title: val('createTitle'),
      assignee: val('createAssigneeSearch'),
      iteration: val('createIteration'),
      type: val('createType'),
    }
    try {
      info.pending = state ? state.pendingAction : null
      info.writeAccess = typeof canWriteProject === 'function' ? Boolean(canWriteProject(state.currentProjectId)) : null
    } catch (e) { info.stateError = e.message }
    return info
  }

  // 诊断上报默认关闭：地址栏加 ?xhub-debug=1 才记录，避免平时写日志
  var DEBUG_ENABLED = (function () {
    try { return new URLSearchParams(location.search).get('xhub-debug') === '1' } catch (e) { return false }
  })()

  function reportDebug(kind, payload) {
    if (!DEBUG_ENABLED) return
    try {
      if (!window.xhub || !window.xhub.service) return
      window.xhub.service.request('/api/debug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: kind, payload: payload || {} }),
      }).catch(function () {})
    } catch (e) { /* 忽略 */ }
  }

  function ensureCreateHint() {
    var hint = document.getElementById('xhubCreateHint')
    if (hint) return hint
    var form = document.getElementById('createForm')
    if (!form) return null
    hint = document.createElement('div')
    hint.id = 'xhubCreateHint'
    hint.style.cssText = 'display:none;margin:0 18px 10px;padding:8px 10px;border-radius:8px;' +
      'background:#fff1f0;color:#c0341d;border:1px solid #ffc9c0;font-size:12px;line-height:1.5;white-space:pre-wrap'
    var actions = form.querySelector('.form-actions')
    if (actions && actions.parentNode) actions.parentNode.insertBefore(hint, actions)
    else form.appendChild(hint)
    return hint
  }

  function showCreateError(message) {
    var hint = ensureCreateHint()
    if (!hint || !message) return
    hint.textContent = '创建失败：' + message
    hint.style.display = ''
  }

  function enhanceCreateDialog() {
    var form = document.getElementById('createForm')
    if (!form || form.getAttribute('data-xhub-create') === '1') return
    form.setAttribute('data-xhub-create', '1')
    // 关掉浏览器原生校验：它在 submit 之前就拦下表单，而扩展 iframe 里不显示提示气泡，
    // 表现就是「点创建完全没反应」。交给 app 自己的校验 + 我们的常驻红字。
    form.noValidate = true
    try {
      var nativeRequired = form.querySelectorAll('[required]')
      for (var r = 0; r < nativeRequired.length; r += 1) nativeRequired[r].removeAttribute('required')
    } catch (e) { /* 忽略 */ }
    reportDebug('dialog-ready', { noValidate: form.noValidate })

    var hint = document.createElement('div')
    hint.id = 'xhubCreateHint'
    hint.style.cssText = 'display:none;margin:0 18px 10px;padding:8px 10px;border-radius:8px;' +
      'background:#fff1f0;color:#c0341d;border:1px solid #ffc9c0;font-size:12px;line-height:1.5'
    var actions = form.querySelector('.form-actions')
    if (actions && actions.parentNode) actions.parentNode.insertBefore(hint, actions)
    else form.appendChild(hint)

    function missingField() {
      var title = document.getElementById('createTitle')
      if (!title || !String(title.value || '').trim()) return '标题不能为空'
      var assignee = document.getElementById('createAssigneeSearch')
      if (!assignee || !String(assignee.value || '').trim()) return '请选择执行人'
      var iteration = document.getElementById('createIteration')
      if (!iteration || !iteration.value) return '请选择「迭代」（下拉默认是「未指定」，无法创建）'
      return ''
    }

    function refreshHint() {
      var msg = missingField()
      if (msg) {
        hint.textContent = msg
        hint.style.display = ''
      } else {
        hint.textContent = ''
        hint.style.display = 'none'
      }
      return msg
    }

    function describeInvalid(node) {
      if (!node) return '还有必填项没填'
      if (node.id === 'createTitle') return '请填写标题'
      if (node.id === 'createAssigneeSearch') return '请选择执行人'
      if (node.id === 'createIteration') return '请选择「迭代」：下拉现在是「未指定」，不能创建'
      var label = node.closest && node.closest('label')
      var text = label ? String(label.textContent || '').trim().split('\n')[0] : ''
      return text ? '请填写「' + text.slice(0, 12) + '」' : '还有必填项没填'
    }
    function markInvalid(node) {
      if (!node) return
      node.style.outline = '2px solid #e04b3a'
      node.style.outlineOffset = '1px'
      node.addEventListener('input', function clear() {
        node.style.outline = ''
        node.removeEventListener('input', clear)
      })
    }
    // 浏览器原生校验（required）会在 submit 事件之前就拦下：点「创建」毫无反应就是这个原因。
    // 所以在按钮点击后主动检查 :invalid，把原因常驻显示出来。
    function showInvalidHint() {
      var invalid = form.querySelector(':invalid')
      if (!invalid) { hint.textContent = ''; hint.style.display = 'none'; return '' }
      hint.textContent = describeInvalid(invalid)
      hint.style.display = ''
      markInvalid(invalid)
      return hint.textContent
    }
    // 兜底：创建弹窗打开时记录所有点击，防止"点到了别处"这种查不出来的情况
    document.addEventListener('click', function (event) {
      var modal = document.getElementById('createModal')
      if (!modal || modal.classList.contains('hidden')) return
      var node = event.target
      reportDebug('modal-click', {
        tag: node && node.tagName ? node.tagName : '',
        id: node && node.id ? node.id : '',
        cls: node && node.className ? String(node.className).slice(0, 40) : '',
      })
    }, true)

    var submitFired = false
    document.addEventListener('submit', function (event) {
      if (event.target === form) submitFired = true
    }, true)

    var submitBtn = document.getElementById('createSubmitBtn')
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var invalid = form.querySelector(':invalid')
        reportDebug('create-click', { valid: form.checkValidity(), invalid: invalid ? invalid.id : '', state: describeCreateState() })
        setTimeout(showInvalidHint, 0)
        // 兜底：万一宿主环境里 submit 事件没触发（点了按钮却没提交），直接调创建逻辑。
        // 同一 tick 里 submit 若已触发，submitFired 为真，这里跳过，避免重复创建。
        submitFired = false
        setTimeout(function () {
          if (submitFired) return
          reportDebug('submit-missing', describeCreateState())
          try {
            var pending = window.createWorkitem()
            if (pending && typeof pending.catch === 'function') {
              pending.catch(function (err) { showCreateError(err && err.message) })
            }
          } catch (e) {
            showCreateError(e && e.message)
          }
        }, 0)
      }, true)
    }
    document.addEventListener('submit', function (event) {
      if (event.target !== form) return
      var msg = refreshHint()
      if (!msg) msg = showInvalidHint()
      reportDebug('form-submit', {
        message: msg || '',
        hintDisplay: hint.style.display,
        hintVisible: Boolean(hint.offsetParent),
        hintRect: hint.getBoundingClientRect ? Math.round(hint.getBoundingClientRect().top) : -1,
      })
      setTimeout(function () {
        reportDebug('after-submit', {
          modalHidden: document.getElementById('createModal').classList.contains('hidden'),
          pending: state ? state.pendingAction : null,
        })
      }, 1500)
    }, true)
    form.addEventListener('input', function () {
      if (hint.style.display !== 'none' && !missingField()) {
        hint.textContent = ''
        hint.style.display = 'none'
      }
    })
    form.addEventListener('change', function () {
      if (hint.style.display !== 'none' && !missingField()) {
        hint.textContent = ''
        hint.style.display = 'none'
      }
    })
  }

  function bindSectionPaging() {    var host = document.getElementById('personalSections')
    if (!host) return
    host.addEventListener('click', function (event) {
      var target = event.target
      if (!target || !target.closest) return
      var more = target.closest('[data-xhub-all-more]')
      if (more) {
        event.preventDefault()
        scope.expanded[more.getAttribute('data-xhub-all-more')] = true
        refreshPersonal()
        return
      }
      var less = target.closest('[data-xhub-all-less]')
      if (less) {
        event.preventDefault()
        delete scope.expanded[less.getAttribute('data-xhub-all-less')]
        refreshPersonal()
      }
    }, true)
  }

  function enterAll() {
    scope.active = true
    scope.expanded = {}
    try {
      if (typeof setMyView === 'function') setMyView('all')
      state.activeModule = 'my'
      // 30 秒内刚拉过全量就复用，来回切视图不再重复走 7 MB 的列表接口
      var updatedAt = Number(state.allItemsUpdatedAt) || 0
      var fresh = Array.isArray(state.allItems) && state.allItems.length > 0 && Date.now() - updatedAt < 30000
      if (fresh) {
        if (typeof renderModulePages === 'function') renderModulePages()
        applyAllUi()
        refreshPersonal()
        return
      }
      var loading = loadItems({ keepSelection: false, loadAll: true })
      if (loading && typeof loading.then === 'function') {
        loading
          .then(function () {
            applyAllUi()
            refreshPersonal()
          })
          .catch(function (err) {
            if (typeof showToast === 'function') showToast(err && err.message ? err.message : '加载失败')
          })
      }
    } catch (e) { /* 忽略 */ }
    applyAllUi()
    refreshPersonal()
  }

  function exitAll() {
    if (!scope.active) return
    scope.active = false
    scope.expanded = {}
    restoreUi()
  }

  function bindRailExit() {
    var rail = document.querySelector('.rail')
    if (!rail) return
    // 捕获阶段先退出「全部」，再让宿主自己的导航逻辑按正常个人视图渲染
    rail.addEventListener('click', function (event) {
      var target = event.target
      var button = target && target.closest ? target.closest('button.rail-item') : null
      if (!button || button.id === 'xhubAllRailBtn') return
      exitAll()
    }, true)
  }

  function wrapGlobal(name, after) {
    var original = window[name]
    if (typeof original !== 'function') return
    var wrapped = function () {
      var result = original.apply(this, arguments)
      try { after(result) } catch (e) { /* 忽略 */ }
      return result
    }
    wrapped.__xhubWrapped = true
    window[name] = wrapped
  }

  function patchSubstance() {
    var originalAssigned = window.isAssignedToActor
    if (typeof originalAssigned === 'function') {
      window.isAssignedToActor = function (item, actor) {
        if (scope.active) {
          if (!scope.assignee) return true
          var target = String(scope.assignee)
          return String(item.assignee_login || '').trim() === target
            || String(item.assignee || '').trim() === target
        }
        return originalAssigned.call(this, item, actor)
      }
    }
    wrapGlobal('renderPersonalView', function () { if (scope.active) applyAllUi() })
    wrapGlobal('renderRailState', function () { if (scope.active) markRail() })
    // 需求展开：全部视图里改成子工单列表，个人视图保持原来的甘特
    var origReqGantt = window.renderPersonalRequirementGantt
    if (typeof origReqGantt === 'function') {
      window.renderPersonalRequirementGantt = function (requirementItem, container) {
        if (!scope.active || !container) return origReqGantt.apply(this, arguments)
        try {
          var descendants = typeof collectRequirementDescendants === 'function'
            ? collectRequirementDescendants(requirementItem)
            : []
          container.innerHTML = buildReqChildrenHtml(requirementItem, descendants)
        } catch (e) {
          return origReqGantt.apply(this, arguments)
        }
      }
    }

    // 创建结果上报：界面提示之外再写一份给后端，排查时不用靠回忆
    wrapGlobal('createWorkitem', function (result) {
      reportDebug('create-called', describeCreateState())
      var info = describeCreateState()
      if (result && typeof result.then === 'function') {
        result.then(
          function (detail) {
            if (detail && detail.item && detail.item.key) reportDebug('create-ok', { key: detail.item.key })
            else reportDebug('create-noop', describeCreateState())
          },
          function (err) {
            reportDebug('create-fail', { message: err && err.message })
            showCreateError(err && err.message)
          }
        )
      } else {
        reportDebug('create-noop', info)
      }
    })

    // 创建弹窗默认带出当前迭代：否则下拉停在「未指定」，点创建只会弹一条容易被忽略的 toast
    wrapGlobal('openCreateModal', function () {
      var select = document.getElementById('createIteration')
      if (!select || select.value) return
      var want = preferredIteration()
      if (!want) return
      for (var i = 0; i < select.options.length; i += 1) {
        if (select.options[i].value === want) { select.value = want; return }
      }
    })
  }

  function watchHeadActions() {
    var actions = document.querySelector('#personalPage .personal-head-actions')
    if (!actions || typeof MutationObserver !== 'function') return
    new MutationObserver(function () {
      if (!scope.active) return
      toggleWriteButtons(true)
    }).observe(actions, { childList: true })
  }

  function boot() {
    injectStyle()
    // page-ready 在 patchSubstance 之后上报，才能反映包装是否生效
    patchSubstance()
    installSectionPaging()
    buildRailButton()
    bindRailExit()
    reportDebug('page-ready', {
      build: '0.4.6',
      createWrapped: Boolean(window.createWorkitem && window.createWorkitem.__xhubWrapped),
      allRail: Boolean(document.getElementById('xhubAllRailBtn')),
    })
    ensureAssigneeUi()
    enhanceCreateDialog()
    bindSectionPaging()
    watchHeadActions()
    scope.assignee = assigneeFromQuery() || readStored()
    if (autostart()) enterAll()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0) })
  } else {
    setTimeout(boot, 0)
  }
})()
