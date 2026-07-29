/* ============================================================
   面试抽题器 · 逻辑层（多题库版）
   - 支持在多个题库之间切换（面渣逆袭 / JavaGuide …），切换后侧栏、配置、统计全部随题库变化
   - 隔离保证：每个题库的题目、记忆(答题/标熟/标不想看/熟练度)、配置都按 bankId 分别存储，
     抽题池永远只基于"当前活动题库"的题目，从根上做到 A 库是 A 库、B 库是 B 库、不混抽不混记
   - 记忆状态：记住 / 模糊 / 没记住
   - 特殊标记：标熟(mastered) / 标不想看(skip) —— 二者均不参与抽取
   - 记忆粒度：EMA(指数移动平均) 0~100，分 陌生/模糊/熟悉/精通 四档
   - 抽取：按 (1-掌握度)×遗忘衰减 加权随机，偏向薄弱且久未复习的题目
   - 持久化：localStorage（记忆 / 配置 / 主题），按题库隔离
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 多题库注册表 ---------------- */
  const BANKS = window.BANKS || [];
  const BANK_DATA = {};
  BANKS.forEach(b => {
    BANK_DATA[b.id] = window[b.global] || { meta: { bank: b.id, topics: [], total: 0, highFreqTotal: 0 }, questions: [] };
  });

  // 当前活动题库（在 init 中确定）；QUESTIONS / META 始终只指向当前库。
  let bankId = null;
  let QUESTIONS = [];
  let META = { topics: [], total: 0, highFreqTotal: 0 };

  // 存储键：记忆与配置按 bankId 隔离；UI 布局与主题全局共享。
  function lsKeys(id) { return { mem: `mem::${id}`, cfg: `cfg::${id}` }; }
  const LS_UI = 'ui::v1';
  const LS_THEME = 'theme::v1';
  const LS_ACTIVE = 'active-bank';

  const DAY = 86400000;

  const state = {
    config: { cats: new Set(), count: 5, highFreqOnly: false },
    session: [],
    open: new Set(),            // 已展开答案的 qid
    answers: {},                // 本轮作答状态：qid -> 'remembered'|'fuzzy'|'forgotten'（仅本轮有效，抽题时清空）
    theme: 'dark',
    leftView: 'explorer',
    leftCollapsed: false,
    rightCollapsed: false,
    inspectQid: null,
  };

  /* ---------------- 工具 ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function loadJSON(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function granuleInfo(score) {
    const t = MemoryAlgo.tier(score);
    return { label: t.label, tier: t.key };
  }

  /* ---------------- Markdown ---------------- */
  if (window.marked) {
    marked.setOptions({ gfm: true, breaks: false });
  }
  function md(src) {
    if (!window.marked) return esc(src);
    try { return marked.parse(src || ''); } catch (e) { return esc(src); }
  }
  function postAnchors(node) {
    $$('a', node).forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  }

  /* ---------------- 记忆存储（按题库隔离） ---------------- */
  let memory = {};

  function getMem(qid) {
    if (!memory[qid]) {
      memory[qid] = { status: null, score: 0, reviews: 0, streak: 0, mastery: 0, sum: 0, seen: 0, lastReviewed: null, flags: { skip: false, mastered: false }, history: [] };
    }
    if (!memory[qid].flags) memory[qid].flags = { skip: false, mastered: false };
    if (!memory[qid].history) memory[qid].history = [];
    if (memory[qid].score == null) memory[qid].score = memory[qid].mastery || 0;
    if (memory[qid].seen == null) memory[qid].seen = 0;
    return memory[qid];
  }
  function saveMem() { localStorage.setItem(lsKeys(bankId).mem, JSON.stringify(memory)); }

  // 记录一次作答。基于"本轮基准分数"查表计算，支持修正选项时回退，避免叠加错误。
  function recordReview(qid, act) {
    const m = getMem(qid);
    const base = (state.answers[qid] && state.answers[qid].prevScore != null)
      ? state.answers[qid].prevScore
      : m.score;
    const newScore = MemoryAlgo.apply(base, act);
    m.score = newScore;
    m.status = act;
    m.lastReviewed = Date.now();
    m.reviews = (m.reviews || 0) + 1;
    state.answers[qid] = { act: act, prevScore: base };
    saveMem();
  }
  function toggleFlag(qid, which) {
    const m = getMem(qid);
    m.flags[which] = !m.flags[which];
    saveMem();
  }

  /* ---------------- 配置（按题库隔离）+ UI 偏好（全局） ---------------- */
  // 载入当前题库的"题目种类/数量/只抽高频"配置。
  function loadConfig() {
    const c = loadJSON(lsKeys(bankId).cfg, null);
    const all = META.topics.map(t => t.slug);
    if (c && c.cats) {
      state.config.cats = new Set(c.cats.filter(s => all.includes(s)));
      if (state.config.cats.size === 0) state.config.cats = new Set(all);
      state.config.count = Math.min(10, Math.max(1, c.count || 5));
      state.config.highFreqOnly = !!c.highFreqOnly;
    } else {
      state.config.cats = new Set(all);
    }
  }
  // 保存：题目配置写入当前题库键；UI 布局偏好写入全局键。
  function saveConfig() {
    localStorage.setItem(lsKeys(bankId).cfg, JSON.stringify({
      cats: [...state.config.cats], count: state.config.count, highFreqOnly: state.config.highFreqOnly,
    }));
    localStorage.setItem(LS_UI, JSON.stringify({
      leftView: state.leftView, leftCollapsed: state.leftCollapsed, rightCollapsed: state.rightCollapsed,
    }));
  }
  // 载入全局 UI 布局偏好（侧栏视图、折叠状态）。
  function loadUIPrefs() {
    const u = loadJSON(LS_UI, null);
    if (u) {
      if (typeof u.leftView === 'string') state.leftView = u.leftView;
      if (typeof u.leftCollapsed === 'boolean') state.leftCollapsed = u.leftCollapsed;
      if (typeof u.rightCollapsed === 'boolean') state.rightCollapsed = u.rightCollapsed;
    }
  }

  /* ---------------- 抽取 ---------------- */
  function eligiblePool() {
    const cfg = state.config;
    return QUESTIONS.filter(q =>
      cfg.cats.has(q.topic) &&
      !getMem(q.id).flags.skip &&
      !getMem(q.id).flags.mastered &&
      (!cfg.highFreqOnly || q.highFreq)
    );
  }
  function weight(q) {
    const m = getMem(q.id);
    let recency = 1;
    if (m.lastReviewed) {
      const days = (Date.now() - m.lastReviewed) / DAY;
      recency = Math.min(3, 1 + days / 7);   // 越久未复习权重越高
    }
    return (1 - m.score / 100) * recency + 0.05;
  }
  function drawQuestions() {
    const pool = eligiblePool();
    if (pool.length === 0) { state.session = []; return; }
    const n = Math.min(state.config.count, pool.length);
    const arr = pool.map(q => ({ q, w: weight(q) }));
    const taken = new Set();
    const res = [];
    while (res.length < n && taken.size < arr.length) {
      let total = 0;
      for (let i = 0; i < arr.length; i++) if (!taken.has(i)) total += arr[i].w;
      let r = Math.random() * total;
      for (let i = 0; i < arr.length; i++) {
        if (taken.has(i)) continue;
        r -= arr[i].w;
        if (r <= 0) { taken.add(i); res.push(arr[i].q); break; }
      }
    }
    state.session = res;
  }

  /* ---------------- 渲染：右侧配置 ---------------- */
  function renderConfig() {
    const list = $('#catList');
    list.innerHTML = '';
    META.topics.forEach(t => {
      const row = el('label', 'cat-row');
      row.innerHTML =
        `<input type="checkbox" data-cat="${t.slug}" ${state.config.cats.has(t.slug) ? 'checked' : ''}/>` +
        `<span class="cat-name">${esc(t.label)}</span>` +
        (t.highFreq ? `<span class="cat-hf">🌟${t.highFreq}</span>` : '') +
        `<span class="cat-count">${t.count}</span>`;
      list.appendChild(row);
    });
    $('#countRange').value = state.config.count;
    $('#countVal').textContent = state.config.count;
    $('#hfToggle').checked = state.config.highFreqOnly;
    updateEligible();
  }
  function updateEligible() {
    $('#eligibleCount').textContent = eligiblePool().length;
  }

  /* ---------------- 渲染：主会话卡片 ---------------- */
  function cardHTML(q) {
    const m = getMem(q.id);
    const g = granuleInfo(m.score);
    const star = q.highFreq ? '<span class="card-star" title="高频题">🌟</span>' : '';
    const open = state.open.has(q.id);
    const mastChip = `<span class="flag-chip mastered" data-chip="mastered" style="display:${m.flags.mastered ? 'inline-block' : 'none'}">已熟</span>`;
    const skipChip = `<span class="flag-chip skip" data-chip="skip" style="display:${m.flags.skip ? 'inline-block' : 'none'}">不想看</span>`;
    return `
    <div class="card ${m.flags.skip || m.flags.mastered ? 'skip-flag' : ''}" data-qid="${esc(q.id)}">
      <div class="card-head">
        <span class="topic-badge">${esc(q.topicLabel)}</span>
        ${q.section ? `<span class="card-section">${esc(q.section)}</span>` : ''}
        ${star}
        <span class="card-title">${esc(q.title)}</span>
        <span class="seen-chip" title="本题被抽中的次数">见过 ${m.seen}</span>
        ${mastChip}${skipChip}
      </div>
      <button class="toggle-answer" data-act="answer">${open ? '▾ 隐藏答案' : '▸ 展开答案'}</button>
      <div class="answer-wrap ${open ? 'open' : ''}"><div class="md">${md(q.answer)}</div></div>
      <div class="card-foot">
        <div class="granule" title="记忆粒度（0-100）：熟练度 ${g.label} · 分数 ${m.score}">
          <span class="glabel">熟练度</span>
          <span class="gtier tier-text-${g.tier}">${g.label}</span>
          <span class="gpct-label">分数</span>
          <span class="gpct tier-text-${g.tier}">${m.score}</span>
        </div>
        <button class="mem-btn remembered ${state.answers[q.id] === 'remembered' ? 'active' : ''}" data-act="mem" data-mem="remembered">记住</button>
        <button class="mem-btn fuzzy ${state.answers[q.id] === 'fuzzy' ? 'active' : ''}" data-act="mem" data-mem="fuzzy">模糊</button>
        <button class="mem-btn forgotten ${state.answers[q.id] === 'forgotten' ? 'active' : ''}" data-act="mem" data-mem="forgotten">没记住</button>
        <button class="flag-btn mastered ${m.flags.mastered ? 'on' : ''}" data-act="flag" data-flag="mastered">标熟</button>
        <button class="flag-btn skip ${m.flags.skip ? 'on' : ''}" data-act="flag" data-flag="skip">标不想看</button>
      </div>
    </div>`;
  }

  function renderSession() {
    const wrap = $('#cards');
    if (state.session.length === 0) {
      const pool = eligiblePool();
      const msg = pool.length === 0
        ? '当前筛选条件下没有可抽取的题目。<br>试试取消「只抽高频」或勾选更多种类。'
        : '点击右侧「抽题」，或按 <span class="kbd">Ctrl/Cmd + Enter</span> 开始一轮抽题。';
      wrap.innerHTML = `<div class="empty">
        <div class="big">❯_</div>
        <div class="t1">还没有抽题</div>
        <div class="t2">${msg}</div>
      </div>`;
      $('#sessionTitle').textContent = '抽题会话';
      $('#sessionMeta').textContent = '';
      return;
    }
    wrap.innerHTML = state.session.map(cardHTML).join('');
    $$('.answer-wrap .md', wrap).forEach(postAnchors);
    $('#sessionTitle').textContent = `本次抽题 · ${state.session.length} 道`;
    const reviewed = state.session.filter(q => getMem(q.id).reviews > 0).length;
    $('#sessionMeta').textContent = `已抽过 ${reviewed}/${state.session.length}`;
  }

  /* ---------------- 渲染：顶栏统计 ---------------- */
  function memoryCounts() {
    const c = { remembered: 0, fuzzy: 0, forgotten: 0, mastered: 0, skip: 0, reviewed: 0 };
    for (const q of QUESTIONS) {
      const m = getMem(q.id);
      if (m.flags.mastered) c.mastered++;
      if (m.flags.skip) c.skip++;
      if (m.status) c[m.status]++;
      if (m.reviews > 0) c.reviewed++;
    }
    return c;
  }
  function renderTopStats() {
    let sum = 0;
    for (const q of QUESTIONS) sum += getMem(q.id).score;
    const avg = QUESTIONS.length ? Math.round(sum / QUESTIONS.length) : 0;
    const reviewed = QUESTIONS.filter(q => getMem(q.id).reviews > 0).length;
    $('#topStats').innerHTML =
      `<span class="stat" title="全局平均熟练度（0-100）">熟练度 <b>${avg}</b></span>` +
      `<span class="stat" style="color:var(--text-faint)" title="已抽过题目数 / 总题数">已抽过 <b>${reviewed}</b>/${META.total}</span>`;
  }

  /* ---------------- 渲染：左侧面板 ---------------- */
  function renderLeft() {
    const titles = { explorer: '题目库', stats: '记忆概览', cache: '缓存', settings: '设置' };
    $('#leftTitle').textContent = titles[state.leftView] || '题目库';
    const body = $('#leftBody');
    body.innerHTML = '';
    if (state.leftView === 'explorer') body.appendChild(buildExplorer());
    else if (state.leftView === 'stats') body.appendChild(buildStats());
    else if (state.leftView === 'cache') body.appendChild(buildCache());
    else body.appendChild(buildSettings());
  }

  function buildExplorer() {
    const wrap = el('div', 'tree');
    META.topics.forEach(t => {
      const node = el('div', 'tree-topic');
      node.innerHTML =
        `<div class="node"><span class="tree-caret">▶</span>` +
        `<span class="tname">${esc(t.label)}</span>` +
        `<span class="count">${t.count}</span></div>` +
        `<div class="tree-children"></div>`;
      node.querySelector('.node').addEventListener('click', () => {
        node.classList.toggle('open');
        const ch = node.querySelector('.tree-children');
        if (node.classList.contains('open') && !ch.dataset.filled) {
          ch.appendChild(buildTopicChildren(t.slug));
          ch.dataset.filled = '1';
        }
      });
      wrap.appendChild(node);
    });
    return wrap;
  }
  function buildTopicChildren(slug) {
    const frag = document.createDocumentFragment();
    const qs = QUESTIONS.filter(q => q.topic === slug);
    let section = '__none__';
    let secWrap = null;
    qs.forEach(q => {
      if (q.section !== section) {
        section = q.section;
        secWrap = el('div', 'tree-section');
        if (section) {
          const h = el('div', 'tree-section-h', `<span style="color:var(--text-faint);font-size:11px;padding:2px 10px 2px 22px;display:block">${esc(section)}</span>`);
          secWrap.appendChild(h);
        }
        frag.appendChild(secWrap);
      }
      const m = getMem(q.id);
      const dotCls = m.flags.skip ? 'skip' : (m.status || '');
      const item = el('div', 'tree-q');
      item.dataset.qid = q.id;
      item.innerHTML =
        `<span class="qdot ${dotCls}"></span>` +
        (q.highFreq ? `<span class="qstar">🌟</span>` : '') +
        `<span class="qtitle">${esc(q.title)}</span>`;
      item.addEventListener('click', () => openInspect(q.id));
      secWrap.appendChild(item);
    });
    return frag;
  }

  function buildStats() {
    const wrap = el('div', 'stats-wrap');
    const avg = (() => {
      let s = 0;
      for (const q of QUESTIONS) s += getMem(q.id).score;
      return QUESTIONS.length ? Math.round(s / QUESTIONS.length) : 0;
    })();
    const g = granuleInfo(avg);
    const reviewed = QUESTIONS.filter(q => getMem(q.id).reviews > 0).length;
    wrap.innerHTML = `
      <div class="stat-block">
        <h4>全局平均熟练度</h4>
        <div class="big-mastery tier-text-${g.tier}">${avg}<small>/100 · ${g.label}</small></div>
      </div>
      <div class="stat-block">
        <h4>已抽过</h4>
        <div class="big-mastery">${reviewed}<small> / ${META.total} 题</small></div>
      </div>
      <div class="stat-block">
        <h4>各主题熟练度</h4>
        <div class="topic-bars">${META.topics.map(t => {
          let s = 0; const qs = QUESTIONS.filter(q => q.topic === t.slug);
          qs.forEach(q => s += getMem(q.id).score);
          const p = qs.length ? Math.round(s / qs.length) : 0;
          const tk = granuleInfo(p).tier;
          const tkLabel = granuleInfo(p).label;
          return `<div class="topic-bar"><span class="nm" title="${esc(t.label)}">${esc(t.label)}</span>` +
            `<span class="gtier tier-text-${tk}">${tkLabel}</span>` +
            `<span class="gpct-label">分数</span>` +
            `<span class="pct tier-text-${tk}">${p}</span></div>`;
        }).join('')}</div>
      </div>`;
    return wrap;
  }

  function buildSettings() {
    const wrap = el('div', 'settings-wrap');
    wrap.innerHTML = `
      <div class="set-row">
        <label>主题</label>
        <div class="btn-line">
          <button class="btn ${state.theme === 'light' ? 'primary' : ''}" data-theme-set="light">浅色</button>
          <button class="btn ${state.theme === 'dark' ? 'primary' : ''}" data-theme-set="dark">深色</button>
        </div>
        <span class="set-desc">默认跟随系统，可手动切换。</span>
      </div>
      <div class="set-row">
        <label>数据备份</label>
        <div class="btn-line">
          <button class="btn" id="exportBtn">导出记忆</button>
          <button class="btn" id="importBtn">导入</button>
        </div>
        <span class="set-desc">记忆进度保存在浏览器本地（localStorage），可导出为 JSON 备份。</span>
        <input type="file" id="importFile" accept="application/json" style="display:none" />
      </div>
      <div class="set-row">
        <label>重置</label>
        <button class="btn danger" id="resetMem">清空全部记忆进度</button>
        <span class="set-desc">仅清除「记住/模糊/没记住/标熟/不想看」与掌握度，不影响题目数据。</span>
      </div>`;
    wrap.querySelector('[data-theme-set="light"]').addEventListener('click', () => setTheme('light'));
    wrap.querySelector('[data-theme-set="dark"]').addEventListener('click', () => setTheme('dark'));
    wrap.querySelector('#exportBtn').addEventListener('click', exportMemory);
    wrap.querySelector('#importBtn').addEventListener('click', () => $('#importFile').click());
    wrap.querySelector('#importFile').addEventListener('change', importMemory);
    wrap.querySelector('#resetMem').addEventListener('click', resetMemory);
    return wrap;
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }
  function storeUsage() {
    const keys = [];
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || '';
      const bytes = (k.length + v.length) * 2; // JS 字符串 UTF-16，约 2 字节/字符
      let items = null;
      if (k === lsKeys(bankId).mem) { try { items = Object.keys(JSON.parse(v) || {}).length; } catch (e) {} }
      keys.push({ k: k, bytes: bytes, items: items });
      total += bytes;
    }
    return { keys: keys, total: total };
  }
  function buildCache() {
    const wrap = el('div', 'settings-wrap');
    const { keys, total } = storeUsage();
    const tip = 'localStorage 是同步读写，但本工具数据量极小（最多约 ' + META.total + ' 题 × 每条几百字节，总计一百多 KB 量级），只在「抽题 / 作答 / 导入导出」时才触发读写，绝不出现在动画或滚动的逐帧逻辑里，因此对你的使用没有任何可感知的性能影响。浏览器对单个域名的 localStorage 上限通常为 5 MB，当前占用远低于此，无需担心。';
    wrap.innerHTML =
      '<div class="set-row">' +
        '<label>本地缓存总占用</label>' +
        '<div class="big-mastery">' + fmtBytes(total) + '</div>' +
        '<span class="set-desc">即当前浏览器（localhost 或 file://）下 localStorage 的全部数据，仅保存在你本机，不会上传。</span>' +
      '</div>' +
      '<div class="set-row">' +
        '<label>明细</label>' +
        '<div class="kv-list">' +
          keys.map(x => '<div class="kv"><span>' + esc(x.k) + '</span><b>' + fmtBytes(x.bytes) + (x.items != null ? ' · ' + x.items + ' 题' : '') + '</b></div>').join('') +
        '</div>' +
      '</div>' +
      '<div class="set-row">' +
        '<label>性能提示</label>' +
        '<span class="set-desc">' + tip + '</span>' +
      '</div>';
    return wrap;
  }

  /* ---------------- 单题查看浮层 ---------------- */
  function openInspect(qid) {
    const q = QUESTIONS.find(x => x.id === qid);
    if (!q) return;
    state.inspectQid = qid;
    const m = getMem(qid);
    const g = granuleInfo(m.score);
    const mastChip = `<span class="flag-chip mastered" data-chip="mastered" style="display:${m.flags.mastered ? 'inline-block' : 'none'}">已熟</span>`;
    const skipChip = `<span class="flag-chip skip" data-chip="skip" style="display:${m.flags.skip ? 'inline-block' : 'none'}">不想看</span>`;
    const modal = $('#inspectModal');
    modal.innerHTML = `
      <div class="im-head">
        <span class="topic-badge">${esc(q.topicLabel)}</span>
        ${q.section ? `<span class="card-section">${esc(q.section)}</span>` : ''}
        ${q.highFreq ? '<span class="card-star">🌟</span>' : ''}
        <span class="card-title">${esc(q.title)}</span>
        <span class="seen-chip" title="本题被抽中的次数">见过 ${m.seen}</span>
        ${mastChip}${skipChip}
        <button class="icon-btn im-close" title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
      </div>
      <div class="im-scroll"><div class="md">${md(q.answer)}</div></div>
      <div class="im-foot">
        <div class="granule" title="记忆粒度（0-100）：熟练度 ${g.label} · 分数 ${m.score}">
          <span class="glabel">熟练度</span>
          <span class="gtier tier-text-${g.tier}">${g.label}</span>
          <span class="gpct-label">分数</span>
          <span class="gpct tier-text-${g.tier}">${m.score}</span>
        </div>
        <button class="mem-btn remembered ${state.answers[q.id] === 'remembered' ? 'active' : ''}" data-act="mem" data-mem="remembered">记住</button>
        <button class="mem-btn fuzzy ${state.answers[q.id] === 'fuzzy' ? 'active' : ''}" data-act="mem" data-mem="fuzzy">模糊</button>
        <button class="mem-btn forgotten ${state.answers[q.id] === 'forgotten' ? 'active' : ''}" data-act="mem" data-mem="forgotten">没记住</button>
        <button class="flag-btn mastered ${m.flags.mastered ? 'on' : ''}" data-act="flag" data-flag="mastered">标熟</button>
        <button class="flag-btn skip ${m.flags.skip ? 'on' : ''}" data-act="flag" data-flag="skip">标不想看</button>
      </div>`;
    postAnchors(modal.querySelector('.md'));
    $('#inspectOverlay').hidden = false;
    modal.querySelector('.im-close').addEventListener('click', closeInspect);
    modal.onclick = (e) => {
      const actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      const act = actEl.dataset.act;
      if (act === 'mem') { recordReview(qid, actEl.dataset.mem); afterInspectChange(qid); }
      else if (act === 'flag') { toggleFlag(qid, actEl.dataset.flag); afterInspectChange(qid); }
    };
  }
  function afterInspectChange(qid) {
    openInspect(qid);          // 重绘浮层
    renderTopStats();
    refreshExplorerDot(qid);
  }
  function closeInspect() {
    $('#inspectOverlay').hidden = true;
    state.inspectQid = null;
  }
  function refreshExplorerDot(qid) {
    const m = getMem(qid);
    $$(`.tree-q[data-qid="${CSS.escape(qid)}"]`).forEach(dot => {
      dot.querySelector('.qdot').className = 'qdot ' + (m.flags.skip ? 'skip' : (m.status || ''));
    });
  }

  /* ---------------- 主题 ---------------- */
  function setTheme(t) {
    state.theme = t;
    document.documentElement.dataset.theme = t;
    localStorage.setItem(LS_THEME, t);
    const btn = $('#themeToggle');
    btn.innerHTML = t === 'dark'
      ? '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" fill="currentColor"/></svg>';
    if (state.leftView === 'settings') renderLeft();  // 同步设置里高亮
  }

  /* ---------------- 题库切换 ---------------- */
  // 把旧版（单题库时期）的 localStorage 键一次性迁移到新的按库/全局键，避免进度丢失。
  function migrateLegacy() {
    try {
      const lm = localStorage.getItem('sanfen-memory-v3');
      if (lm && !localStorage.getItem(lsKeys('sanfene').mem)) {
        localStorage.setItem(lsKeys('sanfene').mem, lm);
        localStorage.removeItem('sanfen-memory-v3');
      }
      const lc = localStorage.getItem('sanfen-config-v3');
      if (lc) {
        const o = JSON.parse(lc);
        if (!localStorage.getItem(lsKeys('sanfene').cfg))
          localStorage.setItem(lsKeys('sanfene').cfg, JSON.stringify({ cats: o.cats, count: o.count, highFreqOnly: o.highFreqOnly }));
        if (!localStorage.getItem(LS_UI))
          localStorage.setItem(LS_UI, JSON.stringify({ leftView: o.leftView, leftCollapsed: o.leftCollapsed, rightCollapsed: o.rightCollapsed }));
        localStorage.removeItem('sanfen-config-v3');
      }
      const lt = localStorage.getItem('sanfen-theme-v1');
      if (lt && !localStorage.getItem(LS_THEME)) { localStorage.setItem(LS_THEME, lt); localStorage.removeItem('sanfen-theme-v1'); }
    } catch (e) { /* 迁移失败不影响使用 */ }
  }

  // 切换活动题库：保存旧库、重置会话、载入新库的题目/记忆/配置、重渲染全部面板。
  function switchBank(id) {
    if (id === bankId || !BANK_DATA[id]) return;
    saveMem();
    saveConfig();
    bankId = id;
    const data = BANK_DATA[id];
    QUESTIONS = data.questions || [];
    META = data.meta || { topics: [], total: 0, highFreqTotal: 0 };
    memory = loadJSON(lsKeys(id).mem, {});
    loadConfig();
    state.session = [];
    state.open.clear();
    state.answers = {};
    localStorage.setItem(LS_ACTIVE, id);
    renderConfig();
    renderSession();
    renderTopStats();
    renderLeft();
    updateBankUI();
  }

  function buildBankSelect() {
    const sel = $('#bankSelect');
    if (!sel) return;
    sel.innerHTML = '';
    BANKS.forEach(b => {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.name;
      sel.appendChild(o);
    });
    sel.value = bankId;
  }
  function updateBankUI() {
    const sel = $('#bankSelect');
    if (sel) sel.value = bankId;
    const b = BANKS.find(x => x.id === bankId);
    if (b) {
      const sub = $('#brandSub');
      if (sub) sub.textContent = b.name;
      document.title = b.name + ' · Interview Extractor';
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    // 右侧配置
    $('#catList').addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-cat]');
      if (!cb) return;
      if (cb.checked) state.config.cats.add(cb.dataset.cat); else state.config.cats.delete(cb.dataset.cat);
      saveConfig(); updateEligible();
    });
    $('#selAll').addEventListener('click', () => {
      META.topics.forEach(t => state.config.cats.add(t.slug));
      saveConfig(); renderConfig();
    });
    $('#selNone').addEventListener('click', () => {
      state.config.cats.clear(); saveConfig(); renderConfig();
    });
    $('#countRange').addEventListener('input', (e) => {
      state.config.count = +e.target.value;
      $('#countVal').textContent = state.config.count;
      saveConfig();
    });
    $('#hfToggle').addEventListener('change', (e) => {
      state.config.highFreqOnly = e.target.checked; saveConfig(); updateEligible();
    });
    $('#drawBtn').addEventListener('click', doDraw);

    // 主区
    $('#redraw').addEventListener('click', doDraw);
    $('#clearSession').addEventListener('click', () => { state.session = []; state.open.clear(); renderSession(); });
    $('#cards').addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      const card = e.target.closest('.card');
      const inModal = !!e.target.closest('#inspectModal');
      const qid = card ? card.dataset.qid : (inModal ? state.inspectQid : null);
      if (!qid) return;
      const act = actEl.dataset.act;
      if (act === 'answer') {
        const wrap = card.querySelector('.answer-wrap');
        const open = wrap.classList.toggle('open');
        actEl.textContent = open ? '▾ 隐藏答案' : '▸ 展开答案';
        if (open) state.open.add(qid); else state.open.delete(qid);
        return;
      }
      if (act === 'mem') {
        const val = actEl.dataset.mem;
        if (state.answers[qid] && state.answers[qid].act === val) return;  // 重复点同一按钮：无操作，防刷分
        recordReview(qid, val);                            // 内部处理回退/应用，仅记一次分
        if (card) updateCardEl(card, qid);
        else if (inModal) updateCardEl($('#inspectModal'), qid);
        flash(actEl);
      } else if (act === 'flag') {
        toggleFlag(qid, actEl.dataset.flag);
        if (card) updateCardEl(card, qid);
        else if (inModal) updateCardEl($('#inspectModal'), qid);
      }
      renderTopStats();
      refreshExplorerDot(qid);
    });

    // 顶栏
    $('#themeToggle').addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));
    $('#bankSelect').addEventListener('change', (e) => switchBank(e.target.value));
    $('#toggleRight').addEventListener('click', () => {
      state.rightCollapsed = !state.rightCollapsed;
      $('.app').classList.toggle('right-collapsed', state.rightCollapsed);
      saveConfig();
    });
    $('#collapseRight').addEventListener('click', () => {
      state.rightCollapsed = true; $('.app').classList.add('right-collapsed'); saveConfig();
    });

    // 左侧活动栏
    $('#activitybar').addEventListener('click', (e) => {
      const b = e.target.closest('.act-btn');
      if (!b) return;
      const view = b.dataset.view;
      if (state.leftView === view && !state.leftCollapsed) {
        state.leftCollapsed = true; $('.app').classList.add('left-collapsed');
        saveConfig();
        return;
      }
      state.leftView = view;
      state.leftCollapsed = false;
      $('.app').classList.remove('left-collapsed');
      $$('.act-btn').forEach(x => x.classList.toggle('active', x.dataset.view === view));
      saveConfig();
      renderLeft();
    });
    $('#collapseLeft').addEventListener('click', () => {
      state.leftCollapsed = true; $('.app').classList.add('left-collapsed'); saveConfig();
    });

    // 浮层关闭
    $('#inspectOverlay').addEventListener('click', (e) => { if (e.target.id === 'inspectOverlay') closeInspect(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#inspectOverlay').hidden) closeInspect();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doDraw(); }
    });
  }

  function doDraw() {
    state.answers = {};          // 新一轮：本轮作答状态归零，避免上一轮按钮高亮残留
    state.open.clear();
    drawQuestions();
    // 记录每题被抽中的次数（见过 x）
    state.session.forEach(q => { getMem(q.id).seen++; });
    saveMem();
    renderSession();
    if (state.session.length === 0) {
      // 空池提示已在 renderSession 内
    }
  }

  function updateCardEl(card, qid) {
    const q = QUESTIONS.find(x => x.id === qid) || { id: qid };
    const m = getMem(qid);
    const g = granuleInfo(m.score);
    const gEl = card.querySelector('.granule');
    gEl.querySelector('.gtier').className = 'gtier tier-text-' + g.tier;
    gEl.querySelector('.gtier').textContent = g.label;
    const gpct = gEl.querySelector('.gpct');
    gpct.className = 'gpct tier-text-' + g.tier;
    gpct.textContent = m.score;
    gEl.title = '记忆粒度（0-100）：熟练度 ' + g.label + ' · 分数 ' + m.score;
    card.querySelectorAll('.mem-btn').forEach(b => b.classList.toggle('active', b.dataset.mem === (state.answers[qid] ? state.answers[qid].act : null)));
    card.querySelector('.flag-btn.mastered').classList.toggle('on', m.flags.mastered);
    card.querySelector('.flag-btn.skip').classList.toggle('on', m.flags.skip);
    const mast = card.querySelector('[data-chip="mastered"]');
    const skip = card.querySelector('[data-chip="skip"]');
    if (mast) mast.style.display = m.flags.mastered ? 'inline-block' : 'none';
    if (skip) skip.style.display = m.flags.skip ? 'inline-block' : 'none';
    card.classList.toggle('skip-flag', m.flags.skip || m.flags.mastered);
  }
  function flash(node) { if (!node) return; node.classList.remove('pop'); void node.offsetWidth; node.classList.add('pop'); }

  /* ---------------- 导入/导出/重置 ---------------- */
  function exportMemory() {
    const blob = new Blob([JSON.stringify(memory, null, 2)], { type: 'application/json' });
    const a = el('a'); a.href = URL.createObjectURL(blob);
    a.download = bankId + '-memory-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click(); URL.revokeObjectURL(a.href);
  }
  function importMemory(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        memory = Object.assign({}, memory, data);
        saveMem(); renderTopStats(); renderSession(); renderLeft();
        alert('导入成功，已合并记忆进度。');
      } catch (err) { alert('导入失败：文件格式不正确。'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }
  function resetMemory() {
    if (!confirm('确定清空全部记忆进度？此操作不可恢复。')) return;
    memory = {}; saveMem();
    renderTopStats(); renderSession(); renderLeft();
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    migrateLegacy();
    // 确定活动题库：优先用上次选择，否则默认第一个注册的题库。
    const stored = localStorage.getItem(LS_ACTIVE);
    bankId = (stored && BANK_DATA[stored]) ? stored : (BANKS[0] && BANKS[0].id);
    if (!bankId) {
      $('#cards').innerHTML = '<div class="empty"><div class="big">!</div><div class="t1">没有可用的题库</div><div class="t2">请先运行 node build-all.mjs 生成 data/*.js</div></div>';
      return;
    }
    const data = BANK_DATA[bankId];
    QUESTIONS = data.questions || [];
    META = data.meta || { topics: [], total: 0, highFreqTotal: 0 };
    memory = loadJSON(lsKeys(bankId).mem, {});

    // 恢复 UI 布局偏好与题目配置
    loadUIPrefs();
    loadConfig();
    $('.app').classList.toggle('left-collapsed', state.leftCollapsed);
    $('.app').classList.toggle('right-collapsed', state.rightCollapsed);
    $$('.act-btn').forEach(x => x.classList.toggle('active', x.dataset.view === state.leftView));

    state.theme = localStorage.getItem(LS_THEME) ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    setTheme(state.theme);

    buildBankSelect();
    renderConfig();
    renderSession();
    renderTopStats();
    renderLeft();
    bindEvents();
    updateBankUI();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
