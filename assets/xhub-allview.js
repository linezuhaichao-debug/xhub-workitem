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
  var scope = { active: false, assignee: '' }
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
    try {
      renderPersonalView()
    } catch (e) { /* 忽略 */ }
  }

  function enterAll() {
    scope.active = true
    try {
      if (typeof setMyView === 'function') setMyView('all')
      state.activeModule = 'my'
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
    window[name] = function () {
      var result = original.apply(this, arguments)
      try { after(result) } catch (e) { /* 忽略 */ }
      return result
    }
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
    patchSubstance()
    buildRailButton()
    bindRailExit()
    ensureAssigneeUi()
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
