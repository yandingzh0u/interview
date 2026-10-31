/* 背题 · 前端逻辑 */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const SESSION_KEY = 'beiti.session.v3';

  const state = {
    items: [],
    fw: null,
    view: 'review',
    step: 0,
    session: null,
    filter: { cat: '', order: 'seq' },
    bankFilter: 'active',
    bankCat: '',
    search: '',
    editing: null,
    editCat: '',
    editSub: '',
    editSegs: [],
    editFu: [],
  };

  const el = {
    banner: $('#banner'),
    posInfo: $('#posInfo'),
    saveState: $('#saveState'),
    progressBar: $('#progressBar'),
    viewReview: $('#view-review'),
    viewBank: $('#view-bank'),
    stage: $('#stage'),
    qMeta: $('#qMeta'),
    qText: $('#qText'),
    frameBlock: $('#frameBlock'),
    skeleton: $('#skeleton'),
    layers: $('#layers'),
    hint: $('#hint'),
    emptyState: $('#emptyState'),
    summary: $('#summary'),
    filterPop: $('#filterPop'),
    orderChips: $('#orderChips'),
    catChips: $('#catChips'),
    catFilter: $('#catFilter'),
    bankList: $('#bankList'),
    bankStat: $('#bankStat'),
    searchInput: $('#searchInput'),
    drawer: $('#drawer'),
    drawerTitle: $('#drawerTitle'),
    fQ: $('#fQ'),
    segEditor: $('#segEditor'),
    segHint: $('#segHint'),
    catPicker: $('#catPicker'),
    subPicker: $('#subPicker'),
    skeletonPreview: $('#skeletonPreview'),
    focusHint: $('#focusHint'),
    fuEditor: $('#fuEditor'),
    btnDelete: $('#btnDelete'),
    mask: $('#mask'),
    importModal: $('#importModal'),
    importText: $('#importText'),
    importCount: $('#importCount'),
  };

  // ---------------- 基础工具 ----------------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function md(text) {
    if (!text) return '';
    const safe = String(text).replace(/<script/gi, '&lt;script');
    try {
      return marked.parse(safe, { breaks: true, gfm: true });
    } catch {
      return `<p>${escapeHtml(safe)}</p>`;
    }
  }

  function paint(root) {
    $$('pre code', root).forEach((block) => {
      try {
        hljs.highlightElement(block);
      } catch {}
    });
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function normQ(s) {
    return String(s)
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[，。？！、；：""''（）【】《》,.?!;:()\[\]]/g, '');
  }

  function setSaveState(text, isError = false) {
    el.saveState.textContent = text;
    el.saveState.classList.toggle('is-error', isError);
  }

  async function api(path, body) {
    const opt =
      body === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(path, opt);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  // ---------------- 骨架库 ----------------

  function cats() {
    return (state.fw && state.fw.categories) || [];
  }
  function findCat(id) {
    return cats().find((c) => c.id === id);
  }
  function subsOf(catId) {
    const c = findCat(catId);
    return c ? c.subtypes : [];
  }
  function findSub(catId, subId) {
    return subsOf(catId).find((s) => s.id === subId);
  }

  function stepsOf(item) {
    const c = findCat(item.cat);
    return c && Array.isArray(c.steps) ? c.steps : [];
  }

  // 这道题该用哪套分段标题：优先二级的 labels，退回一级的抽象步骤
  function labelsOf(item) {
    const sub = findSub(item.cat, item.sub);
    if (sub && Array.isArray(sub.labels) && sub.labels.length) return sub.labels;
    const c = findCat(item.cat);
    return c && Array.isArray(c.steps) ? c.steps : [];
  }

  // ---------------- 层：骨架的每一段就是一层 ----------------

  function buildLayers(item) {
    const labels = labelsOf(item);
    const segs = Array.isArray(item.segments) ? item.segments : [];
    const layers = [];

    const n = Math.max(labels.length, segs.length);
    for (let i = 0; i < n; i++) {
      const text = segs[i] || '';
      if (!text.trim()) continue;
      layers.push({ key: 'seg' + i, kind: 'seg', num: i + 1, label: labels[i] || `补充 ${i + 1}`, text });
    }

    if ((item.fu || []).length) {
      layers.push({ key: 'fu', kind: 'fu', label: '追问' });
    }
    return layers;
  }

  function isBlank(item) {
    const hasSeg = (item.segments || []).some((s) => (s || '').trim());
    return !hasSeg && !(item.fu || []).length;
  }

  // ---------------- 数据加载 ----------------

  async function loadAll() {
    try {
      const [fwRes, qRes] = await Promise.all([fetch('/api/frameworks'), fetch('/api/questions')]);

      if (fwRes.ok) {
        state.fw = await fwRes.json();
      } else {
        showBanner('骨架配置 frameworks.json 读取失败，分段标题会退化成通用名。');
      }

      const data = await qRes.json();
      state.items = data.items || [];
      if (data.errors && data.errors.length) {
        const sample = data.errors.slice(0, 3).map((e) => `第 ${e.line} 行：${e.msg}`).join('；');
        showBanner(
          `bank.jsonl 有 ${data.errors.length} 行无法解析，已跳过。${sample}。如果在记事本里改过，请确认保存为 UTF-8 编码。`
        );
      }
      restoreSession();
      renderAll();
    } catch (err) {
      showBanner('读取题库失败：' + err.message);
    }
  }

  function showBanner(text) {
    el.banner.textContent = text;
    el.banner.hidden = false;
  }

  // ---------------- 会话 ----------------

  function aliveItems() {
    return state.items.filter((x) => !x.deleted);
  }

  function buildQueue(filter) {
    let pool = aliveItems();
    if (filter.cat) pool = pool.filter((x) => x.cat === filter.cat);

    if (filter.order === 'random') {
      pool = shuffle(pool.slice());
    } else {
      pool = pool.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    }
    return pool.map((x) => x.id);
  }

  function newSession(filter) {
    const queue = buildQueue(filter);
    state.session = {
      queue,
      idx: 0,
      filter: { ...filter },
      startedAt: Date.now(),
      done: queue.length === 0,
    };
    state.step = 0;
    persistSession();
  }

  function persistSession() {
    if (!state.session) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
    } catch {}
  }

  function restoreSession() {
    let raw = null;
    try {
      raw = localStorage.getItem(SESSION_KEY);
    } catch {}
    if (!raw) return;
    let s;
    try {
      s = JSON.parse(raw);
    } catch {
      return;
    }
    if (!s || !Array.isArray(s.queue) || !s.queue.length || s.done) return;
    if (s.idx >= s.queue.length) return;
    const alive = new Set(aliveItems().map((x) => x.id));
    if (!s.queue.every((id) => alive.has(id))) return;
    state.session = s;
    if (s.filter) {
      state.filter = {
        cat: s.filter.cat || '',
        order: s.filter.order || 'seq',
      };
    }
  }

  function currentItem() {
    const s = state.session;
    if (!s || s.done) return null;
    return state.items.find((x) => x.id === s.queue[s.idx]) || null;
  }

  // ---------------- 渲染：背诵 ----------------

  function renderAll() {
    renderReview();
    renderBank();
    renderCatFilter();
    renderFilterPopover();
  }

  function renderReview() {
    if (state.view !== 'review') return;

    if (aliveItems().length === 0) {
      el.stage.hidden = true;
      el.emptyState.hidden = false;
      el.summary.hidden = true;
      el.progressBar.style.width = '0';
      el.posInfo.textContent = '';
      return;
    }

    el.emptyState.hidden = true;

    if (!state.session) newSession(state.filter);
    if (!state.session || state.session.done) return renderSummary();

    const sess = state.session;
    let item = currentItem();
    let guard = 0;
    while (!item && guard < sess.queue.length) {
      sess.idx = (sess.idx + 1) % sess.queue.length;
      guard += 1;
      item = currentItem();
    }
    if (!item) {
      sess.done = true;
      persistSession();
      return renderReview();
    }

    el.stage.hidden = false;
    el.summary.hidden = true;

    el.qMeta.innerHTML =
      `<span class="cat-chip">${escapeHtml(item.cat)}</span>` +
      (item.sub ? `<span class="sub-chip">${escapeHtml(item.sub)}</span>` : '');

    el.qText.textContent = item.q;

    renderSkeleton(item);

    // 分段内容：增量渲染，避免每次都重放动画
    renderLayers(item);

    const layers = buildLayers(item);
    el.hint.textContent = hintText(layers);

    if (!layers.length) {
      el.layers.innerHTML = `<div class="empty-note">这道题还没有内容。先按上面的骨架自己讲一遍，再去「题库」把每一段补上。</div>`;
      el.layers.dataset.qid = item.id;
      el.layers.dataset.count = '0';
    }

    const total = sess.queue.length;
    el.posInfo.textContent = `${Math.min(sess.idx + 1, total)}/${total}`;
    el.progressBar.style.width = `${(sess.idx / total) * 100}%`;
  }

  function renderSkeleton(item) {
    const labels = labelsOf(item);
    if (!labels.length) {
      el.frameBlock.hidden = true;
      return;
    }
    el.frameBlock.hidden = false;

    const steps = stepsOf(item);
    el.skeleton.innerHTML = labels
      .map((l, i) => {
        const step = steps[i];
        const body =
          step && step !== l
            ? `<b>${escapeHtml(step)}</b><em>（${escapeHtml(l)}）</em>`
            : escapeHtml(l || step);
        return (i ? '<span class="sep">→</span>' : '') + `<span class="sk"><i>${i + 1}</i>${body}</span>`;
      })
      .join('');
  }

  function renderLayers(item) {
    const want = buildLayers(item).slice(0, state.step);
    const sameQuestion = el.layers.dataset.qid === item.id;
    let done = Number(el.layers.dataset.count || 0);

    // 换题、回退、或有旧内容需要清掉：整块重建一次
    if (!sameQuestion || done > want.length) {
      el.layers.innerHTML = '';
      el.layers.dataset.qid = item.id;
      el.layers.dataset.count = '0';
      done = 0;
    }

    if (done >= want.length) return;

    const html = want.slice(done).map((L) => layerHTML(L, item)).join('');
    const before = el.layers.children.length;
    el.layers.insertAdjacentHTML('beforeend', html);

    [...el.layers.children].slice(before).forEach((node) => paint(node));
    el.layers.dataset.count = String(want.length);
  }

  function layerHTML(L, item) {
    if (L.kind === 'fu') {
      return `<section class="layer l-fu">
        <div class="layer-head"><span class="layer-num is-plain">问</span><span class="layer-label">面试官接着会问</span></div>
        <div class="layer-body">${fuHtml(item)}</div>
      </section>`;
    }
    return `<section class="layer l-seg">
      <div class="layer-head">
        <span class="layer-num">${L.num}</span>
        <span class="layer-label">${escapeHtml(L.label)}</span>
      </div>
      <div class="layer-body markdown">${md(L.text)}</div>
    </section>`;
  }

  function fuHtml(item) {
    return (
      '<div class="fu-list">' +
      item.fu
        .map(
          (f, i) => `<div class="fu-item">
            <span class="fu-arrow">→</span>
            <span class="fu-q">${escapeHtml(f.q)}</span>
            ${f.hint ? `<button class="fu-toggle" data-fu="${i}">提示</button>` : ''}
            ${f.hint ? `<div class="fu-hint" data-fuhint="${i}" hidden>${escapeHtml(f.hint)}</div>` : ''}
          </div>`
        )
        .join('') +
      '</div>'
    );
  }

  function renderSummary() {
    el.stage.hidden = true;
    el.emptyState.hidden = true;
    el.summary.hidden = false;
    el.progressBar.style.width = '0';
    el.posInfo.textContent = '';

    el.summary.innerHTML = `
      <h2 class="summary-title">这个类型下没有题目</h2>
      <p class="summary-sub">换个一级 Tag，或者先把题目录进来。</p>
      <div class="summary-actions">
        <button class="primary-btn" id="btnResetScope">看全部题目</button>
        <button class="text-btn" id="btnToBank2">去题库</button>
      </div>`;

    $('#btnResetScope').addEventListener('click', () => {
      state.filter = { cat: '', order: 'seq' };
      state.session = null;
      renderFilterPopover();
      renderReview();
    });
    $('#btnToBank2').addEventListener('click', () => switchView('bank'));
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // ---------------- 渲染：题库 ----------------

  function renderCatFilter() {
    el.catFilter.innerHTML =
      `<button class="chip ${state.bankCat ? '' : 'is-active'}" data-bankcat="">全部类型</button>` +
      cats()
        .map(
          (c) =>
            `<button class="chip ${state.bankCat === c.id ? 'is-active' : ''}" data-bankcat="${escapeHtml(c.id)}">${escapeHtml(c.id)}</button>`
        )
        .join('');
  }

  function renderBank() {
    let list = state.items.slice();

    if (state.bankFilter === 'deleted') {
      list = list.filter((x) => x.deleted);
    } else {
      list = list.filter((x) => !x.deleted);
      if (state.bankFilter === 'empty') list = list.filter((x) => isBlank(x));
    }

    if (state.bankCat) list = list.filter((x) => x.cat === state.bankCat);

    const kw = state.search.trim().toLowerCase();
    if (kw) {
      list = list.filter((x) =>
        [x.q, (x.segments || []).join(' ')]
          .join('\n')
          .toLowerCase()
          .includes(kw)
      );
    }

    list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    el.bankStat.textContent = `${list.length} 题`;

    if (!list.length) {
      const text =
        state.bankFilter === 'deleted'
          ? '回收站是空的'
          : state.search
            ? '没有匹配的题目'
            : state.bankCat
              ? '这个类型下还没有题目'
              : '还没有题目，点右上角「新建题目」或「批量导入」';
      el.bankList.innerHTML = `<div class="list-empty">${text}</div>`;
      return;
    }

    el.bankList.innerHTML = list
      .map((x) => {
        return `
          <div class="q-row ${x.deleted ? 'is-deleted' : ''}" data-id="${x.id}">
            <div class="q-row-main">
              <div class="q-row-cat">
                <span class="c">${escapeHtml(x.cat)}</span>
                ${x.sub ? `<span class="s">${escapeHtml(x.sub)}</span>` : ''}
              </div>
              <div class="q-row-title">${escapeHtml(x.q.replace(/\n+/g, ' '))}</div>
              <div class="q-row-meta">
                ${isBlank(x) ? '<span class="blank">空白题</span>' : ''}
              </div>
            </div>
          </div>`;
      })
      .join('');
  }

  function renderFilterPopover() {
    $$('[data-order]', el.orderChips).forEach((b) =>
      b.classList.toggle('is-active', b.dataset.order === state.filter.order)
    );

    el.catChips.innerHTML =
      `<button class="chip ${state.filter.cat ? '' : 'is-active'}" data-fcat="">不限</button>` +
      cats()
        .map(
          (c) =>
            `<button class="chip ${state.filter.cat === c.id ? 'is-active' : ''}" data-fcat="${escapeHtml(c.id)}">${escapeHtml(c.id)}</button>`
        )
        .join('');

  }

  // ---------------- 背诵交互 ----------------

  function advance() {
    const item = currentItem();
    if (!item) return;
    const layers = buildLayers(item);
    if (state.step >= layers.length) return;

    state.step += 1;

    const before = el.layers.children.length;
    renderLayers(item);
    el.hint.textContent = hintText(layers);

    const added = [...el.layers.children].slice(before);
    if (added.length) {
      const last = added[added.length - 1];
      const rect = last.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 130) {
        window.scrollBy({ top: rect.top - 120, behavior: 'smooth' });
      }
    }
  }

  function hintText(layers) {
    const s = state.session;
    const total = s ? s.queue.length : 0;
    const idx = s ? s.idx : 0;

    if (state.step < layers.length) {
      return state.step === 0 ? '空格　先按骨架自己讲一遍' : '空格　下一段';
    }
    if (total <= 1) return '';
    if (idx === 0) return '→ 下一题';
    if (idx >= total - 1) return '← 上一题';
    return '← 上一题　　→ 下一题';
  }

  function next() {
    const s = state.session;
    const item = currentItem();
    if (!s || !item || !s.queue.length) return;
    if (s.idx >= s.queue.length - 1) return;

    s.idx += 1;
    state.step = 0;

    persistSession();
    renderReview();
    saveItem(item);
  }

  function goPrev() {
    const s = state.session;
    if (!s || !s.queue.length) return;
    if (s.idx <= 0) return;
    s.idx -= 1;
    const prev = state.items.find((x) => x.id === s.queue[s.idx]);
    state.step = prev ? buildLayers(prev).length : 0;
    persistSession();
    renderReview();
  }

  // ---------------- 保存 ----------------

  let saveChain = Promise.resolve();

  function saveItem(item) {
    setSaveState('保存中…');
    const payload = {
      id: item.id,
      q: item.q,
      cat: item.cat,
      sub: item.sub,
      segments: item.segments,
      fu: item.fu,
      deleted: item.deleted,
    };
    saveChain = saveChain
      .then(() => api('/api/questions', payload))
      .then((res) => {
        Object.assign(item, res.item);
        setSaveState('已保存');
      })
      .catch((err) => setSaveState('保存失败：' + err.message, true));
    return saveChain;
  }

  // ---------------- 视图 ----------------

  function switchView(view) {
    state.view = view;
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
    el.viewReview.classList.toggle('is-active', view === 'review');
    el.viewBank.classList.toggle('is-active', view === 'bank');
    el.filterPop.hidden = true;
    if (view === 'review') {
      renderReview();
    } else {
      el.posInfo.textContent = '';
      el.progressBar.style.width = '0';
      renderCatFilter();
      renderBank();
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // ---------------- 抽屉 ----------------

  function openDrawer(id) {
    const found = id ? state.items.find((x) => x.id === id) : null;
    if (id && !found) return;
    state.editing = found || null;

    const item = state.editing;
    el.drawerTitle.textContent = item ? (item.deleted ? '查看题目（已删除）' : '编辑题目') : '新建题目';
    el.fQ.value = item ? item.q : '';

    state.editCat = item ? item.cat : cats()[0] ? cats()[0].id : '解释原理';
    state.editSub = item ? item.sub : (subsOf(state.editCat)[0] || {}).id || '';
    state.editSegs = item ? (item.segments || []).slice() : [];
    state.editFu = item ? item.fu.map((f) => ({ ...f })) : [];

    renderCatPicker();
    renderSubPicker();
    renderFuEditor();

    el.btnDelete.hidden = !item;
    el.btnDelete.textContent = item && item.deleted ? '彻底删除' : '删除';

    el.drawer.classList.add('is-open');
    el.mask.classList.add('is-open');
    setTimeout(() => el.fQ.focus(), 120);
  }

  function closeDrawer() {
    el.drawer.classList.remove('is-open');
    el.mask.classList.remove('is-open');
    state.editing = null;
  }

  function renderCatPicker() {
    el.catPicker.innerHTML = cats()
      .map(
        (c) =>
          `<button type="button" class="${c.id === state.editCat ? 'is-on' : ''}" data-cat="${escapeHtml(c.id)}">${escapeHtml(c.id)}</button>`
      )
      .join('');
  }

  function renderSubPicker() {
    el.subPicker.innerHTML = subsOf(state.editCat)
      .map(
        (s) =>
          `<button type="button" class="${s.id === state.editSub ? 'is-on' : ''}" data-sub="${escapeHtml(s.id)}">${escapeHtml(s.id)}</button>`
      )
      .join('');

    const sub = findSub(state.editCat, state.editSub);
    const labels = labelsOf({ cat: state.editCat, sub: state.editSub });
    const steps = stepsOf({ cat: state.editCat });
    el.skeletonPreview.textContent = labels
      .map((l, i) => (steps[i] ? `${steps[i]}（${l}）` : l))
      .join(' → ');
    el.focusHint.textContent = sub && sub.focus ? `重点：${sub.focus}` : '';

    renderSegEditor();
  }

  function renderSegEditor() {
    const labels = labelsOf({ cat: state.editCat, sub: state.editSub });

    if (!labels.length) {
      el.segEditor.innerHTML = '<div class="focus-hint">这套骨架没有配置分段。</div>';
      el.segHint.textContent = '';
      return;
    }

    el.segHint.textContent = `${labels.length} 段，跟着骨架走`;

    el.segEditor.innerHTML = labels
      .map(
        (l, i) => `<div class="seg-row">
          <div class="seg-head">
            <span class="seg-idx">${i + 1}</span>
            <span class="seg-label">${escapeHtml(l)}</span>
          </div>
          <textarea data-seg="${i}" rows="3" placeholder="写「${escapeHtml(l)}」这一段"></textarea>
        </div>`
      )
      .join('');

    $$('[data-seg]', el.segEditor).forEach((t) => {
      const v = state.editSegs[Number(t.dataset.seg)];
      t.value = typeof v === 'string' ? v : '';
    });
  }

  function renderFuEditor() {
    if (!state.editFu.length) {
      el.fuEditor.innerHTML = '<div class="focus-hint">还没有追问。答完这道题，面试官通常会接着问什么？</div>';
      return;
    }
    el.fuEditor.innerHTML = state.editFu
      .map(
        (f, i) => `<div class="fu-row">
          <input data-fuq="${i}" value="${escapeHtml(f.q)}" placeholder="追问的问题">
          <input data-fuh="${i}" value="${escapeHtml(f.hint)}" placeholder="答题提示（可空）">
          <button type="button" class="fu-del" data-fudel="${i}" title="删除">✕</button>
        </div>`
      )
      .join('');
  }

  async function saveDrawer() {
    const q = el.fQ.value.trim();
    if (!q) {
      el.fQ.focus();
      return;
    }

    const labels = labelsOf({ cat: state.editCat, sub: state.editSub });
    const segs = [];
    for (let i = 0; i < labels.length; i++) {
      const node = el.segEditor.querySelector(`[data-seg="${i}"]`);
      segs.push(node ? node.value : state.editSegs[i] || '');
    }

    const payload = {
      q,
      cat: state.editCat,
      sub: state.editSub,
      segments: segs,
      fu: state.editFu.filter((f) => f.q.trim()),
    };
    if (state.editing) payload.id = state.editing.id;

    const btn = $('#drawerSave');
    btn.disabled = true;
    try {
      const res = await api('/api/questions', payload);
      if (state.editing) {
        Object.assign(state.editing, res.item);
      } else {
        state.items.push(res.item);
        appendToQueue([res.item.id]);
      }
      setSaveState('已保存');
      closeDrawer();
      renderAll();
    } catch (err) {
      setSaveState('保存失败：' + err.message, true);
      alert('保存失败：' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteFromDrawer() {
    const item = state.editing;
    if (!item) return;

    if (item.deleted) {
      if (!confirm('彻底删除这道题？删了就找不回来了。')) return;
      try {
        await api('/api/questions/purge', { id: item.id });
        state.items = state.items.filter((x) => x.id !== item.id);
        closeDrawer();
        renderAll();
      } catch (err) {
        alert('删除失败：' + err.message);
      }
      return;
    }

    try {
      await api('/api/questions/delete', { id: item.id });
      item.deleted = true;
      closeDrawer();
      renderAll();
    } catch (err) {
      alert('删除失败：' + err.message);
    }
  }

  // ---------------- 导入 ----------------

  function appendToQueue(ids) {
    if (!ids || !ids.length || !state.session) return;
    if (state.session.done) {
      state.session = null;
      return;
    }
    state.session.queue.push(...ids);
    persistSession();
  }

  function parseImport(text) {
    const out = [];
    let cur = null;
    let field = null;

    const flush = () => {
      if (cur && cur.q.trim()) out.push(cur);
      cur = null;
      field = null;
    };

    for (const raw of text.split(/\r?\n/)) {
      const m = raw.match(/^\s*(Q|CAT|SUB|A|BRIEF|S|SEG|FU|SRC|TAGS|SOURCE)\s*[:：]\s*(.*)$/i);
      if (m) {
        const key = m[1].toUpperCase();
        const val = m[2];
        if (key === 'Q') {
          flush();
          cur = { q: val, cat: '', sub: '', segments: [], fu: [] };
          field = 'q';
          continue;
        }
        if (!cur) continue;
        if (key === 'CAT') {
          const parts = val.split(/[/／｜|>]/).map((s) => s.trim()).filter(Boolean);
          cur.cat = parts[0] || '';
          cur.sub = parts[1] || '';
          field = null;
        } else if (key === 'SUB') {
          cur.sub = val.trim();
          field = null;
        } else if (key === 'BRIEF') {
          field = null;
        } else if (key === 'S' || key === 'SEG' || key === 'A') {
          cur.segments.push(val);
          field = 'seg';
        } else if (key === 'BRIEF') {
          if (!cur.segments.length) {
            cur.segments.push(val);
            field = 'seg';
          } else {
            field = null;
          }
        } else if (key === 'FU') {
          const [fq, fh] = val.split(/\s*\|\s*/);
          if (fq && fq.trim()) cur.fu.push({ q: fq.trim(), hint: (fh || '').trim() });
          field = null;
        } else if (key === 'SRC' || key === 'SOURCE' || key === 'TAGS') {
          field = null;
        }
        continue;
      }
      if (cur && field === 'seg' && cur.segments.length) {
        cur.segments[cur.segments.length - 1] += '\n' + raw;
      } else if (cur && field) {
        cur[field] += (cur[field] ? '\n' : '') + raw;
      }
    }
    flush();

    return out
      .map((o) => ({
        ...o,
        q: o.q.trim(),
        segments: o.segments.map((s) => s.trim()).filter((s, i, arr) => s || i < arr.length - 1),
      }))
      .filter((o) => o.q);
  }

  function openImport() {
    el.importText.value = '';
    el.importCount.textContent = '';
    el.importModal.hidden = false;
    setTimeout(() => el.importText.focus(), 80);
  }

  function closeImport() {
    el.importModal.hidden = true;
  }

  async function doImport() {
    const parsed = parseImport(el.importText.value);
    if (!parsed.length) {
      el.importCount.textContent = '没识别出题目，检查一下格式';
      return;
    }

    const seen = new Set(aliveItems().map((x) => normQ(x.q)));
    const fresh = [];
    let dup = 0;
    for (const p of parsed) {
      const k = normQ(p.q);
      if (seen.has(k)) {
        dup += 1;
        continue;
      }
      seen.add(k);
      fresh.push(p);
    }

    if (!fresh.length) {
      el.importCount.textContent = `${parsed.length} 题全部重复，没有导入`;
      return;
    }

    const btn = $('#importConfirm');
    btn.disabled = true;
    el.importCount.textContent = `正在导入 ${fresh.length} 题…`;

    let ok = 0;
    const newIds = [];
    for (const p of fresh) {
      try {
        const cat = p.cat || '解释原理';
        const sub = p.sub || ((subsOf(cat)[0] || {}).id || '');
        const res = await api('/api/questions', {
          q: p.q,
          cat,
          sub,
          segments: p.segments,
          fu: p.fu,
          level: 2,
        });
        state.items.push(res.item);
        newIds.push(res.item.id);
        ok += 1;
      } catch {}
    }

    btn.disabled = false;
    closeImport();
    appendToQueue(newIds);
    renderAll();
    setSaveState(`已导入 ${ok} 题${dup ? `，跳过 ${dup} 题重复` : ''}`);
  }

  // ---------------- 筛选 ----------------

  function applyFilter() {
    state.session = null;
    state.step = 0;
    newSession(state.filter);
    el.filterPop.hidden = true;
    renderReview();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // ---------------- 事件 ----------------

  function bindEvents() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
    $$('[data-goto]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.goto)));


    el.layers.addEventListener('click', (e) => {
      const btn = e.target.closest('.fu-toggle');
      if (!btn) return;
      const hint = el.layers.querySelector(`[data-fuhint="${btn.dataset.fu}"]`);
      if (!hint) return;
      hint.hidden = !hint.hidden;
      btn.textContent = hint.hidden ? '提示' : '收起';
    });

    // 筛选
    $('#btnFilter').addEventListener('click', (e) => {
      e.stopPropagation();
      el.filterPop.hidden = !el.filterPop.hidden;
      if (!el.filterPop.hidden) renderFilterPopover();
    });
    el.orderChips.addEventListener('click', (e) => {
      const b = e.target.closest('[data-order]');
      if (!b) return;
      state.filter.order = b.dataset.order;
      renderFilterPopover();
    });
    el.catChips.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fcat]');
      if (!b) return;
      state.filter.cat = b.dataset.fcat;
      renderFilterPopover();
    });
    $('#btnResetFilter').addEventListener('click', () => {
      state.filter = { cat: '', order: 'seq' };
      renderFilterPopover();
    });
    $('#btnApplyFilter').addEventListener('click', applyFilter);

    document.addEventListener('click', (e) => {
      if (!el.filterPop.hidden && !el.filterPop.contains(e.target) && e.target.id !== 'btnFilter') {
        el.filterPop.hidden = true;
      }
    });

    // 题库
    $$('[data-bankfilter]').forEach((b) =>
      b.addEventListener('click', () => {
        state.bankFilter = b.dataset.bankfilter;
        $$('[data-bankfilter]').forEach((x) => x.classList.toggle('is-active', x === b));
        renderBank();
      })
    );
    el.catFilter.addEventListener('click', (e) => {
      const b = e.target.closest('[data-bankcat]');
      if (!b) return;
      state.bankCat = b.dataset.bankcat;
      renderCatFilter();
      renderBank();
    });
    el.searchInput.addEventListener('input', () => {
      state.search = el.searchInput.value;
      renderBank();
    });
    el.bankList.addEventListener('click', (e) => {
      const row = e.target.closest('.q-row');
      if (row) openDrawer(row.dataset.id);
    });

    // 抽屉
    $('#btnNew').addEventListener('click', () => openDrawer(null));
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerCancel').addEventListener('click', closeDrawer);
    $('#drawerSave').addEventListener('click', saveDrawer);
    el.btnDelete.addEventListener('click', deleteFromDrawer);
    el.mask.addEventListener('click', closeDrawer);

    el.catPicker.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      state.editCat = b.dataset.cat;
      if (!findSub(state.editCat, state.editSub)) state.editSub = (subsOf(state.editCat)[0] || {}).id || '';
      renderCatPicker();
      renderSubPicker();
    });
    el.subPicker.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sub]');
      if (!b) return;
      state.editSub = b.dataset.sub;
      renderSubPicker();
    });
    el.segEditor.addEventListener('input', (e) => {
      const node = e.target.closest('[data-seg]');
      if (!node) return;
      state.editSegs[Number(node.dataset.seg)] = node.value;
    });
    $('#btnAddFu').addEventListener('click', () => {
      state.editFu.push({ q: '', hint: '' });
      renderFuEditor();
      const inputs = $$('[data-fuq]', el.fuEditor);
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    el.fuEditor.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fudel]');
      if (!b) return;
      state.editFu.splice(Number(b.dataset.fudel), 1);
      renderFuEditor();
    });
    el.fuEditor.addEventListener('input', (e) => {
      const qi = e.target.dataset.fuq;
      const hi = e.target.dataset.fuh;
      if (qi !== undefined) state.editFu[Number(qi)].q = e.target.value;
      if (hi !== undefined) state.editFu[Number(hi)].hint = e.target.value;
    });

    // 导入
    $('#btnImport').addEventListener('click', openImport);
    $('#importCancel').addEventListener('click', closeImport);
    $('#importConfirm').addEventListener('click', doImport);
    el.importText.addEventListener('input', () => {
      const n = parseImport(el.importText.value).length;
      el.importCount.textContent = n ? `识别到 ${n} 题` : '';
    });

    document.addEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    const tag = (e.target && e.target.tagName) || '';

    if (!el.importModal.hidden) {
      if (e.key === 'Escape') closeImport();
      return;
    }

    if (el.drawer.classList.contains('is-open')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDrawer();
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveDrawer();
      }
      return;
    }

    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (state.view !== 'review') {
      if (e.key === '/') {
        e.preventDefault();
        el.searchInput.focus();
      }
      return;
    }
    if (!state.session || state.session.done) return;

    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      advance();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goPrev();
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    }
  }

  bindEvents();
  loadAll().then(() => {
    // 调试参数（正常使用不会带）：?step=N 展开前 N 段 / ?view=bank 进题库 / ?edit=new 开录入 / ?dbg=1 关动画
    const p = new URLSearchParams(location.search);
    if (p.has('dbg')) {
      el.drawer.style.transition = 'none';
      el.mask.style.transition = 'none';
    }
    if (p.get('view') === 'bank') switchView('bank');
    const n = Number(p.get('step') || 0);
    if (n > 0) {
      state.step = n;
      renderReview();
    }
    if (p.has('edit')) openDrawer(p.get('edit') === 'new' ? null : p.get('edit'));
    if (p.has('import')) openImport();
  });
})();
