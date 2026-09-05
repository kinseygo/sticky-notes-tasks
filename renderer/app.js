// app.js — 渲染进程逻辑：状态管理、便签、任务、搜索、云备份
/* global window, document */

const COLORS = ['yellow', 'pink', 'blue', 'green', 'purple'];
const CATEGORIES = [
  { id: 'vault', name: '密码箱', icon: '🔐' },
  { id: 'tech', name: '技术笔记', icon: '💻' },
  { id: 'work', name: '工作纪要', icon: '📋' },
  { id: 'daily', name: '日常记录', icon: '🏡' },
];
const catOf = (id) => CATEGORIES.find((c) => c.id === id) || null;
const MAX_PAGES = 10;            // 最多10页便签页
const NOTES_PER_PAGE = 3;        // 每页3个便签位置
const MAX_ACTIVE_NOTES = MAX_PAGES * NOTES_PER_PAGE; // 共30个位置

let state = { notes: [], archived: [], trash: [], tasks: [] };
let config = { theme: 'light', webdav: { server: '', username: '' }, autoBackupHours: 0, lastBackupAt: null };
let currentTab = 'notes';
let searchTerm = '';
let expandedTaskId = null;
let saveTimer = null;
let authed = false;        // 已解锁进入主界面（或无需密码）
let hasPassword = false;   // 是否启用了封面密码
let archiveFilter = 'all'; // 归档库当前分类筛选
let currentNotePage = 1;    // 当前便签页码（1~10）

const $ = (s) => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 截止时间解析：旧数据只有日期（YYYY-MM-DD）按当天 09:00 处理，新数据为 datetime-local 值
function dueMs(due) {
  if (!due) return null;
  let s = String(due);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T09:00';
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}
function dueInputVal(due) {
  if (!due) return '';
  const s = String(due);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T09:00' : s;
}
function normalize(data) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  return { notes: arr(data.notes), archived: arr(data.archived), trash: arr(data.trash), tasks: arr(data.tasks) };
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.api.saveData(state);
    if (window.ghSync) window.ghSync.onSave(); // 标记本地改动并调度云推送
  }, 500);
}
function renderAll() {
  renderNotes();
  renderTasks();
}

// ---------- 云同步桥 ----------
window.appBridge = {
  getState: () => state,
  applyState: (d) => { state = normalize(d); renderAll(); },
  toast: (m, t) => toast(m, t),
};


// ---------- Toast ----------
let toastTimer = null;
function toast(msg, type = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (type === 'err' ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------- 弹窗 ----------
function showModal(id) {
  $('#' + id).classList.add('open');
}
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('mousedown', (e) => { if (e.target === m) m.classList.remove('open'); });
});
document.querySelectorAll('.modal-close').forEach((b) => {
  b.addEventListener('click', () => b.closest('.modal').classList.remove('open'));
});
document.querySelectorAll('.modal-close2').forEach((b) => {
  b.addEventListener('click', () => b.closest('.modal').classList.remove('open'));
});

// ---------- 标签页 ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $('#page-notes').classList.toggle('active', tab === 'notes');
  $('#page-tasks').classList.toggle('active', tab === 'tasks');
}

// ---------- 主题 ----------
function applyTheme() {
  document.body.classList.toggle('dark', config.theme === 'dark');
  $('#btn-theme').textContent = config.theme === 'dark' ? '☀️' : '🌙';
}

/* ================= 封面密码锁 ================= */
function showCover(mode) {
  const cover = $('#cover');
  cover.classList.remove('hidden', 'open');
  $('#cover-unlock').classList.toggle('hidden', mode !== 'unlock');
  $('#cover-setup').classList.toggle('hidden', mode !== 'setup');
  $('#cover-err').textContent = '';
  $('#cover-err2').textContent = '';
  $('#cover-pass').classList.remove('shake');
  setTimeout(() => $(mode === 'unlock' ? '#cover-pass' : '#cover-pass-new').focus(), 60);
}

// 解锁成功：翻页动画打开封面，同时加载数据
function openCoverWithEnter() {
  const p = enterApp();
  $('#cover').classList.add('open');
  setTimeout(() => $('#cover').classList.add('hidden'), 1100);
  return p;
}

async function enterApp() {
  authed = true;
  const loaded = await window.api.loadData();
  if (loaded) state = normalize(loaded);
  config = Object.assign({ theme: 'light', webdav: {}, autoBackupHours: 0, lastBackupAt: null }, await window.api.loadConfig());
  if (!config.webdav) config.webdav = {};
  applyTheme();
  renderAll();
  enforceNotePageLimit(); // 启动时兼容旧数据：最大保留10页（30条）
  currentNotePage = 1; // 进入时显示第1页（最新内容）
  renderNotes();
  $('#btn-lock').classList.toggle('hidden', !hasPassword);
  if (window.ghSync) window.ghSync.onEnter(); // 进入主界面后尝试拉取云端
}

// 手动锁定 / 自动锁定：清空界面数据回到封面
async function lockApp() {
  authed = false;
  state = { notes: [], archived: [], trash: [], tasks: [] };
  expandedTaskId = null;
  searchTerm = '';
  $('#search').value = '';
  $('#notes-grid').innerHTML = '';
  $('#todo-list').innerHTML = '';
  $('#done-list').innerHTML = '';
  document.querySelectorAll('.modal.open').forEach((m) => m.classList.remove('open'));
  $('#cover-pass').value = '';
  await window.api.authLock();
  if (window.ghSync) window.ghSync.onLock();
  showCover('unlock');
}

function coverFail(errEl, inputSel, msg) {
  const el = $(errEl);
  el.textContent = msg;
  const input = $(inputSel);
  input.classList.remove('shake');
  void input.offsetWidth; // 重新触发动画
  input.classList.add('shake');
  input.select();
}

async function tryUnlock() {
  const btn = $('#cover-unlock-btn');
  btn.disabled = true;
  const r = await window.api.authVerify($('#cover-pass').value);
  btn.disabled = false;
  if (r.ok) return openCoverWithEnter();
  coverFail('#cover-err', '#cover-pass', r.error || '密码不正确');
}

async function trySetupPassword() {
  const pw = $('#cover-pass-new').value;
  const pw2 = $('#cover-pass-new2').value;
  if (pw.length < 4) return coverFail('#cover-err2', '#cover-pass-new', '密码至少需要 4 位');
  if (pw !== pw2) return coverFail('#cover-err2', '#cover-pass-new2', '两次输入的密码不一致');
  const r = await window.api.authSet({ next: pw });
  if (!r.ok) return coverFail('#cover-err2', '#cover-pass-new', r.error || '设置失败');
  hasPassword = true;
  $('#btn-lock').classList.remove('hidden');
  await openCoverWithEnter();
  toast('密码已设置，下次启动需输入密码解锁 🔒');
}

$('#cover-unlock-btn').addEventListener('click', tryUnlock);
$('#cover-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
$('#cover-setup-btn').addEventListener('click', trySetupPassword);
$('#cover-pass-new2').addEventListener('keydown', (e) => { if (e.key === 'Enter') trySetupPassword(); });
$('#cover-skip-btn').addEventListener('click', async () => { await openCoverWithEnter(); });
$('#btn-lock').addEventListener('click', lockApp);
$('#btn-theme').addEventListener('click', async () => {
  config.theme = config.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  await window.api.saveConfig(config);
});

// ---------- 搜索 ----------
$('#search').addEventListener('input', (e) => {
  searchTerm = e.target.value;
  renderNotes();
  renderTasks();
});

/* ================= 便签 ================= */
function noteHtml(n) {
  return `
  <div class="note-card c-${n.color || 'yellow'}" data-id="${n.id}">
    <div class="note-top">
      <span class="note-date">${fmtDate(n.updatedAt || n.createdAt)}</span>
      <button class="note-recolor" title="换个颜色">🎨</button>
    </div>
    <div class="note-text" contenteditable="true" data-placeholder="写点什么…">${escapeHtml(n.text)}</div>
    <div class="note-actions">
      <button class="note-act act-tear">🗑 撕掉</button>
      <button class="note-act act-arch">📄 存入文档</button>
      <button class="note-act act-copy">📋 一键复制</button>
    </div>
  </div>`;
}

function renderNotes() {
  const grid = $('#notes-grid');
  const term = searchTerm.trim().toLowerCase();
  const allNotes = state.notes.filter((n) => !term || (n.text || '').toLowerCase().includes(term));
  $('#notes-count').textContent = state.notes.length ? `共 ${state.notes.length} 张（${Math.ceil(state.notes.length / NOTES_PER_PAGE)}/${MAX_PAGES}页）` : '';

  const empty = $('#notes-empty');
  if (!allNotes.length) {
    grid.innerHTML = '';
    $('#notes-pager').classList.add('hidden');
    empty.classList.remove('hidden');
    empty.querySelector('.empty-title').textContent = term ? '没有匹配的便签' : '还没有便签';
    empty.querySelector('.empty-sub').textContent = term ? '换个关键词试试' : '点击「＋ 新建便签」，或按 Ctrl+N 开始记录';
    return;
  }
  empty.classList.add('hidden');

  // 翻页计算：每页3条，当前页从最新开始（第1页=最新3条）
  const totalPages = Math.min(Math.ceil(allNotes.length / NOTES_PER_PAGE), MAX_PAGES);
  if (currentNotePage > totalPages && totalPages > 0) currentNotePage = totalPages;
  if (currentNotePage < 1) currentNotePage = 1;

  const startIdx = (currentNotePage - 1) * NOTES_PER_PAGE;
  const pageNotes = allNotes.slice(startIdx, startIdx + NOTES_PER_PAGE);

  grid.innerHTML = pageNotes.map(noteHtml).join('');

  // 翻页控件显示/隐藏及状态更新
  if (totalPages > 1) {
    $('#notes-pager').classList.remove('hidden');
    $('#notes-page-label').textContent = `第 ${currentNotePage} / ${totalPages} 页`;
    $('#btn-page-prev').disabled = currentNotePage <= 1;
    $('#btn-page-next').disabled = currentNotePage >= totalPages;
  } else {
    $('#notes-pager').classList.add('hidden');
  }
}

function newNote() {
  if (!authed) return;
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  state.notes.unshift({ id: uid(), text: '', color, createdAt: Date.now(), updatedAt: Date.now() });
  // 当便签超过10页（30条）时，自动归档最早一页（最旧3条）
  enforceNotePageLimit();
  renderNotes();
  scheduleSave();
  const first = $('#notes-grid .note-text');
  if (first) first.focus();
}

// 便签页管理：最多10页，每页3条。超出10页时归档最早一页（最旧3条）到归档库
function enforceNotePageLimit() {
  let n = 0;
  while (state.notes.length > MAX_ACTIVE_NOTES) {
    // 取出最旧的3条（数组尾部）作为一页归档
    const pageItems = state.notes.splice(-NOTES_PER_PAGE);
    // 归档到归档库，每条保留原内容，并设置类型为默认日常记录（用户可在归档库修改）
    for (const old of pageItems) {
      state.archived.unshift({ id: old.id, text: old.text || '（空白便签）', color: old.color, createdAt: old.createdAt, archivedAt: Date.now(), category: 'daily' });
    }
    n++;
  }
  if (n) {
    scheduleSave();
    renderNotes();
    renderArchiveIfOpen();
    toast(`便签已满 ${MAX_PAGES} 页（${MAX_ACTIVE_NOTES} 条），最早的 ${NOTES_PER_PAGE} 条已自动归档到「日常记录」📄`);
  }
  return n;
}

// 编辑（不重渲染，保持光标）
$('#notes-grid').addEventListener('input', (e) => {
  if (!e.target.classList.contains('note-text')) return;
  const card = e.target.closest('.note-card');
  const n = state.notes.find((x) => x.id === card.dataset.id);
  if (!n) return;
  n.text = e.target.textContent;
  n.updatedAt = Date.now();
  scheduleSave();
});
$('#notes-grid').addEventListener('blur', (e) => {
  if (!e.target.classList || !e.target.classList.contains('note-text')) return;
  const card = e.target.closest('.note-card');
  const n = state.notes.find((x) => x.id === card.dataset.id);
  if (n) card.querySelector('.note-date').textContent = fmtDate(n.updatedAt || n.createdAt);
}, true);

$('#notes-grid').addEventListener('click', (e) => {
  const card = e.target.closest('.note-card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('.act-tear')) return tearNote(id);
  if (e.target.closest('.act-arch')) return openCatPop(e.target.closest('.act-arch'), id);
  if (e.target.closest('.act-copy')) {
    const n = state.notes.find((x) => x.id === id);
    if (!n) return;
    if (!(n.text || '').trim()) return toast('便签还是空的，先写点什么吧', 'err');
    window.api.copyText(n.text);
    return toast('便签内容已复制 📋');
  }
  if (e.target.closest('.note-recolor')) {
    const n = state.notes.find((x) => x.id === id);
    if (!n) return;
    n.color = COLORS[(COLORS.indexOf(n.color) + 1) % COLORS.length];
    card.className = `note-card c-${n.color}`;
    scheduleSave();
  }
});

$('#btn-new-note').addEventListener('click', newNote);

// 翻页按钮事件
$('#btn-page-prev').addEventListener('click', () => {
  if (currentNotePage > 1) { currentNotePage--; renderNotes(); }
});
$('#btn-page-next').addEventListener('click', () => {
  const totalPages = Math.min(Math.ceil(state.notes.length / NOTES_PER_PAGE), MAX_PAGES);
  if (currentNotePage < totalPages) { currentNotePage++; renderNotes(); }
});

// 撕掉（撕纸动画 → 回收站）
function tearNote(id) {
  const card = document.querySelector(`.note-card[data-id="${id}"]`);
  const note = state.notes.find((n) => n.id === id);
  if (!card || !note || card.dataset.tearing) return;
  card.dataset.tearing = '1';

  const rect = card.getBoundingClientRect();
  const stage = document.createElement('div');
  stage.className = 'tear-stage';
  Object.assign(stage.style, {
    left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
  });
  for (const pos of ['top', 'bottom']) {
    const half = card.cloneNode(true);
    half.removeAttribute('data-id');
    half.removeAttribute('data-tearing');
    half.classList.add('tear-' + pos);
    half.querySelectorAll('[contenteditable]').forEach((el) => el.setAttribute('contenteditable', 'false'));
    stage.appendChild(half);
  }
  document.body.appendChild(stage);
  card.style.visibility = 'hidden';

  setTimeout(() => {
    stage.remove();
    state.notes = state.notes.filter((n) => n.id !== id);
    state.trash.unshift({ id: note.id, text: note.text || '（空白便签）', color: note.color, tornAt: Date.now() });
    scheduleSave();
    renderNotes();
    renderTrashIfOpen();
    toast('便签已撕掉，可在回收站找回 🗑');
  }, 760);
}

// 存入文档（先选归档分类）
function openCatPop(anchor, noteId) {
  const pop = $('#cat-pop');
  pop.innerHTML = CATEGORIES.map((c) => `<button data-cat="${c.id}">${c.icon} ${c.name}</button>`).join('');
  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = 170;
  pop.style.left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8) + 'px';
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px';
  pop.dataset.noteId = noteId;
}
$('#cat-pop').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cat]');
  if (!btn) return;
  const noteId = $('#cat-pop').dataset.noteId;
  $('#cat-pop').classList.add('hidden');
  archiveNote(noteId, btn.dataset.cat);
});
document.addEventListener('mousedown', (e) => {
  const pop = $('#cat-pop');
  if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !e.target.closest('.act-arch')) {
    pop.classList.add('hidden');
  }
});

function archiveNote(id, category) {
  const i = state.notes.findIndex((n) => n.id === id);
  if (i < 0) return;
  const n = state.notes.splice(i, 1)[0];
  state.archived.unshift({ id: n.id, text: n.text || '（空白便签）', color: n.color, createdAt: n.createdAt, archivedAt: Date.now(), category: category || 'daily' });
  scheduleSave();
  renderNotes();
  renderArchiveIfOpen();
  toast(`已归档到「${(catOf(category) || { name: '日常记录' }).name}」📄`);
}

/* ================= 归档库 / 回收站弹窗 ================= */
function catBadge(cat) {
  if (!cat || !catOf(cat)) return '<span class="cat-badge cat-none">未分类</span>';
  const c = catOf(cat);
  return `<span class="cat-badge cat-${c.id}">${c.icon} ${c.name}</span>`;
}

function rowHtml(n, kind) {
  const ts = kind === 'archive' ? n.archivedAt : n.tornAt;
  const label = kind === 'archive' ? '归档于' : '撕掉于';
  const cat = kind === 'archive' ? catBadge(n.category) : '';
  const clickable = kind === 'archive' ? ' clickable' : '';
  // 归档类型修改下拉：密码箱/技术笔记/工作纪要/日常记录
  const catOptions = CATEGORIES.map(c => `<option value="${c.id}" ${n.category === c.id ? 'selected' : ''}>${c.icon} ${c.name}</option>`).join('');
  const catSelectHtml = kind === 'archive'
    ? `<select class="row-cat-select" data-id="${n.id}" title="修改归档类型">${catOptions}</select>`
    : '';
  return `
  <div class="row-item" data-id="${n.id}">
    <div class="row-body${clickable} c-${n.color || 'yellow'}" title="${kind === 'archive' ? '点击查看全文' : ''}">
      <div class="row-text">${escapeHtml(n.text)}</div>
      <div class="row-date">${cat}${catSelectHtml}<span>${label} ${fmtDate(ts)}</span></div>
    </div>
    <div class="row-ops">
      <button class="op-restore">↩ 恢复</button>
      <button class="op-delete">删除</button>
    </div>
  </div>`;
}

function renderArchiveTabs() {
  const hasLegacy = state.archived.some((n) => !catOf(n.category));
  const tabs = [{ id: 'all', name: '全部', icon: '📦' }, ...CATEGORIES];
  if (hasLegacy) tabs.push({ id: 'none', name: '未分类', icon: '🗂' });
  if (!tabs.some((t) => t.id === archiveFilter)) archiveFilter = 'all';
  $('#archive-tabs').innerHTML = tabs.map((t) => {
    const count = t.id === 'all' ? state.archived.length
      : t.id === 'none' ? state.archived.filter((n) => !catOf(n.category)).length
      : state.archived.filter((n) => n.category === t.id).length;
    return `<button class="arch-tab ${archiveFilter === t.id ? 'active' : ''}" data-filter="${t.id}">${t.icon} ${t.name}${count ? ` <i>${count}</i>` : ''}</button>`;
  }).join('');
}

function renderArchiveList() {
  renderArchiveTabs();
  $('#archive-count').textContent = state.archived.length || '';
  const list = archiveFilter === 'all' ? state.archived
    : archiveFilter === 'none' ? state.archived.filter((n) => !catOf(n.category))
    : state.archived.filter((n) => n.category === archiveFilter);
  $('#archive-list').innerHTML = list.length
    ? list.map((n) => rowHtml(n, 'archive')).join('')
    : `<div class="modal-empty">📦 该分类下还没有归档<br><small>在便签卡片上点「📄 存入文档」选择分类归档</small></div>`;
}
function renderTrashList() {
  $('#trash-count').textContent = state.trash.length || '';
  $('#trash-list').innerHTML = state.trash.length
    ? state.trash.map((n) => rowHtml(n, 'trash')).join('')
    : `<div class="modal-empty">🗑 回收站是空的<br><small>撕掉的便签会先放到这里，可随时恢复</small></div>`;
}
function renderArchiveIfOpen() { if ($('#modal-archive').classList.contains('open')) renderArchiveList(); }
function renderTrashIfOpen() { if ($('#modal-trash').classList.contains('open')) renderTrashList(); }

$('#btn-archive').addEventListener('click', () => { renderArchiveList(); showModal('modal-archive'); });
$('#archive-tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.arch-tab');
  if (!t) return;
  archiveFilter = t.dataset.filter;
  renderArchiveList();
});
$('#btn-trash').addEventListener('click', () => { renderTrashList(); showModal('modal-trash'); });

function bindRowList(modalId, listName) {
  $(`#${modalId} .row-list`).addEventListener('click', (e) => {
    const item = e.target.closest('.row-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('.op-restore')) {
      const i = state[listName].findIndex((n) => n.id === id);
      if (i < 0) return;
      const n = state[listName].splice(i, 1)[0];
      state.notes.unshift({ id: uid(), text: n.text === '（空白便签）' ? '' : n.text, color: n.color, createdAt: n.createdAt || Date.now(), updatedAt: Date.now() });
      scheduleSave(); renderNotes();
      enforceNotePageLimit(); // 恢复后同样只保留最多10页
      listName === 'archived' ? renderArchiveList() : renderTrashList();
      toast('已恢复到便签列表 ↩');
    } else if (e.target.closest('.op-delete')) {
      if (!confirm('确定彻底删除？删除后无法恢复。')) return;
      state[listName] = state[listName].filter((n) => n.id !== id);
      scheduleSave();
      listName === 'archived' ? renderArchiveList() : renderTrashList();
      toast('已彻底删除');
    } else if (listName === 'archived' && e.target.closest('.row-body')) {
      openArchiveView(id); // 点击归档条目查看全文
    }
  });
}
bindRowList('modal-archive', 'archived');
bindRowList('modal-trash', 'trash');

// 归档类型修改：在归档列表中直接通过下拉选择修改类型
$('#archive-list').addEventListener('change', (e) => {
  if (!e.target.classList.contains('row-cat-select')) return;
  const id = e.target.dataset.id;
  const newCat = e.target.value;
  const n = state.archived.find((x) => x.id === id);
  if (!n) return;
  n.category = newCat || 'daily';
  scheduleSave();
  renderArchiveList();
  toast(`已修改归档类型为「${(catOf(newCat) || { name: '日常记录' }).name}」`);
});

/* ---------- 归档详情弹窗 ---------- */
function openArchiveView(id) {
  const n = state.archived.find((x) => x.id === id);
  if (!n) return;
  $('#archview-badge').innerHTML = catBadge(n.category);
  $('#archview-meta').textContent =
    `${n.createdAt ? `创建于 ${fmtDate(n.createdAt)} · ` : ''}归档于 ${fmtDate(n.archivedAt)}`;
  $('#archview-text').value = n.text || '';
  showModal('modal-archview');
}
$('#btn-archview-copy').addEventListener('click', async () => {
  await window.api.copyText($('#archview-text').value);
  toast('已复制全文 📋');
});

$('#btn-clear-trash').addEventListener('click', () => {
  if (!state.trash.length) return toast('回收站已经是空的');
  if (!confirm(`确定清空回收站的 ${state.trash.length} 张便签？清空后无法恢复。`)) return;
  state.trash = [];
  scheduleSave();
  renderTrashList();
  toast('回收站已清空');
});

// 归档导出（按分类分组）
async function exportArchive(kind) {
  if (!state.archived.length) return toast('归档库是空的，先归档一些便签吧', 'err');
  const stamp = new Date().toISOString().slice(0, 10);
  // 按分类分组：四个细项在前，未分类（旧数据）最后
  const groups = [...CATEGORIES.map((c) => ({ ...c, items: state.archived.filter((n) => n.category === c.id) }))];
  const legacy = state.archived.filter((n) => !catOf(n.category));
  if (legacy.length) groups.push({ id: 'none', name: '未分类', icon: '🗂', items: legacy });

  const groups2 = groups.filter((g) => g.items.length);
  let content, name;
  if (kind === 'md') {
    const lines = ['# 便签归档', '', `> 共 ${state.archived.length} 条 · 导出于 ${new Date().toLocaleString('zh-CN')}`, ''];
    groups2.forEach((g) => {
      lines.push(`## ${g.icon} ${g.name}（${g.items.length} 条）`, '');
      g.items.forEach((n) => lines.push(`- **${fmtDate(n.archivedAt)}** ${(n.text || '').trim() || '（空白便签）'}`));
      lines.push('');
    });
    content = lines.join('\n');
    name = `便签归档-${stamp}.md`;
  } else {
    content = groups2.map((g) => {
      const items = g.items.map((n) => `[${fmtDate(n.archivedAt)}] ${(n.text || '').trim() || '（空白便签）'}`).join('\n');
      return `===== ${g.name} =====\n${items}`;
    }).join('\n\n');
    name = `便签归档-${stamp}.txt`;
  }
  const r = await window.api.exportFile(name, content);
  if (r.ok) toast('已导出：' + r.filePath);
  else if (!r.canceled) toast('导出失败：' + (r.error || ''), 'err');
}
$('#btn-export-md').addEventListener('click', () => exportArchive('md'));
$('#btn-export-txt').addEventListener('click', () => exportArchive('txt'));

/* ================= 任务 ================= */
function taskHtml(t) {
  const priChip = t.priority === 2 ? '<span class="chip pri-2">🔴 高优先级</span>'
    : t.priority === 1 ? '<span class="chip pri-1">🟡 中优先级</span>' : '';
  const due = dueChip(t.due);
  let sub = '';
  if (t.subtasks && t.subtasks.length) {
    const d = t.subtasks.filter((s) => s.done).length;
    const pct = Math.round((d / t.subtasks.length) * 100);
    sub = `<span class="chip">☑ 子任务 ${d}/${t.subtasks.length}</span><div class="sub-bar"><i style="width:${pct}%"></i></div>`;
  }
  const expanded = expandedTaskId === t.id;
  return `
  <div class="task ${t.done ? 'done' : ''}" data-id="${t.id}">
    <button class="task-check" title="${t.done ? '标记为待办' : '标记为完成'}">✓</button>
    <div class="task-main">
      <div class="task-title">${escapeHtml(t.title)}</div>
      <div class="task-meta">${priChip}${due}${sub}</div>
      <div class="task-detail ${expanded ? '' : 'hidden'}">
        <div class="detail-row">
          <label>优先级</label>
          <select class="detail-pri">
            <option value="0" ${!t.priority ? 'selected' : ''}>⚪ 无</option>
            <option value="1" ${t.priority === 1 ? 'selected' : ''}>🟡 中</option>
            <option value="2" ${t.priority === 2 ? 'selected' : ''}>🔴 高</option>
          </select>
          <label>截止时间</label>
          <input type="datetime-local" class="detail-due" value="${dueInputVal(t.due)}" title="到点自动提醒">
        </div>
        <div class="subtasks">
          ${(t.subtasks || []).map((s, i) => `
          <div class="subtask" data-i="${i}">
            <button class="sub-check ${s.done ? 'on' : ''}">✓</button>
            <span class="sub-text ${s.done ? 'done' : ''}">${escapeHtml(s.text)}</span>
            <button class="sub-del" title="删除子任务">✕</button>
          </div>`).join('')}
          <input class="sub-add" type="text" placeholder="＋ 添加子任务，回车保存">
        </div>
      </div>
    </div>
    <div class="task-actions">
      <button class="ta-edit" title="详情 / 编辑">⋯</button>
      <button class="ta-del" title="删除任务">🗑</button>
    </div>
  </div>`;
}

function dueChip(due) {
  if (!due) return '';
  const dayPart = String(due).slice(0, 10); // 兼容「日期」和「日期+时间」两种存法
  const end = new Date(dayPart + 'T23:59:59');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((end - today) / 86400000);
  let label, cls = '';
  if (diff < 0) { label = `已过期 ${-diff} 天`; cls = 'overdue'; }
  else if (diff === 0) label = '今天到期';
  else if (diff === 1) label = '明天到期';
  else label = `${diff} 天后到期`;
  return `<span class="chip due ${cls}">📅 ${label}</span>`;
}

function cmpTodo(a, b) {
  if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
  const da = dueMs(a.due) ?? Infinity;
  const db = dueMs(b.due) ?? Infinity;
  if (da !== db) return da - db;
  return (b.createdAt || 0) - (a.createdAt || 0);
}

function renderTasks() {
  const term = searchTerm.trim().toLowerCase();
  const all = state.tasks.filter((t) => !term || (t.title || '').toLowerCase().includes(term));
  const todo = all.filter((t) => !t.done).sort(cmpTodo);
  const done = all.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  $('#todo-count').textContent = todo.length || '';
  $('#done-count').textContent = done.length || '';
  renderRing(all);

  $('#todo-list').innerHTML = todo.length ? todo.map(taskHtml).join('')
    : `<div class="task-empty">${term ? '🔍 没有匹配的任务' : '🎉 没有待办任务，在上方添加一个吧'}</div>`;
  $('#done-list').innerHTML = done.length ? done.map(taskHtml).join('')
    : `<div class="task-empty">${term ? '🔍 没有匹配的任务' : '还没有完成的任务 ✨'}</div>`;
}

function renderRing(tasks) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const C = 2 * Math.PI * 52;
  const fg = $('#ring-fg');
  fg.style.strokeDasharray = C;
  fg.style.strokeDashoffset = C * (1 - pct / 100);
  $('#ring-pct').textContent = pct + '%';
  $('#stat-todo').textContent = total - done;
  $('#stat-done').textContent = done;
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  $('#stat-today').textContent = state.tasks.filter((t) => t.completedAt && t.completedAt >= t0.getTime()).length;
}

// 添加任务
$('#task-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const title = e.target.value.trim();
  if (!title) return;
  state.tasks.unshift({
    id: uid(), title, done: false,
    priority: Number($('#task-priority').value) || 0,
    due: $('#task-due').value || null,
    subtasks: [], createdAt: Date.now(), completedAt: null,
  });
  e.target.value = '';
  renderTasks();
  scheduleSave();
});

// 任务输入一键复制
$('#task-copy').addEventListener('click', async () => {
  const v = $('#task-input').value;
  if (!v.trim()) return toast('输入框是空的，先写点任务内容吧', 'err');
  await window.api.copyText(v);
  toast('任务内容已复制 📋');
});

// 勾选完成 / 取消完成（划线动画）
function toggleTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  const el = document.querySelector(`.task[data-id="${id}"]`);
  if (!t || !el) return;
  if (!t.done) {
    el.classList.add('completing');
    setTimeout(() => {
      t.done = true;
      t.completedAt = Date.now();
      scheduleSave();
      renderTasks();
      toast('任务完成，干得漂亮 🎉');
    }, 480);
  } else {
    t.done = false;
    t.completedAt = null;
    scheduleSave();
    renderTasks();
  }
}

function bindTaskList(sel) {
  const el = $(sel);

  el.addEventListener('click', (e) => {
    const taskEl = e.target.closest('.task');
    if (!taskEl) return;
    const t = state.tasks.find((x) => x.id === taskEl.dataset.id);
    if (!t) return;

    if (e.target.closest('.task-check')) return toggleTask(t.id);
    if (e.target.closest('.ta-edit')) {
      expandedTaskId = expandedTaskId === t.id ? null : t.id;
      return renderTasks();
    }
    if (e.target.closest('.ta-del')) {
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      if (expandedTaskId === t.id) expandedTaskId = null;
      scheduleSave();
      renderTasks();
      return toast('任务已删除');
    }
    const sub = e.target.closest('.subtask');
    if (sub) {
      const i = Number(sub.dataset.i);
      if (e.target.closest('.sub-check')) {
        t.subtasks[i].done = !t.subtasks[i].done;
        scheduleSave();
        renderTasks();
      } else if (e.target.closest('.sub-del')) {
        t.subtasks.splice(i, 1);
        scheduleSave();
        renderTasks();
      }
    }
  });

  el.addEventListener('change', (e) => {
    const taskEl = e.target.closest('.task');
    if (!taskEl) return;
    const t = state.tasks.find((x) => x.id === taskEl.dataset.id);
    if (!t) return;
    if (e.target.classList.contains('detail-pri')) {
      t.priority = Number(e.target.value) || 0;
      scheduleSave();
      renderTasks();
    } else if (e.target.classList.contains('detail-due')) {
      t.due = e.target.value || null;
      scheduleSave();
      renderTasks();
    }
  });

  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.classList.contains('sub-add')) return;
    const v = e.target.value.trim();
    if (!v) return;
    const taskEl = e.target.closest('.task');
    const t = state.tasks.find((x) => x.id === taskEl.dataset.id);
    t.subtasks.push({ text: v, done: false });
    scheduleSave();
    renderTasks();
    const again = document.querySelector(`.task[data-id="${t.id}"] .sub-add`);
    if (again) again.focus();
  });
}
bindTaskList('#todo-list');
bindTaskList('#done-list');

/* ================= 设置 / 云备份 ================= */
$('#btn-settings').addEventListener('click', async () => {
  const wd = config.webdav || {};
  $('#wd-server').value = wd.server || '';
  $('#wd-user').value = wd.username || '';
  $('#wd-pass').value = (await window.api.getSecret('webdavPassword')) || '';
  $('#auto-backup').value = String(config.autoBackupHours || 0);
  updateLastBackup();
  await refreshLaunchSetting();
  updatePwStatus();
  showModal('modal-settings');
});

/* ---------- 开机启动 ---------- */
async function refreshLaunchSetting() {
  try {
    const r = await window.api.getLaunch();
    if (r && r.ok) $('#chk-launch').checked = !!r.enabled;
  } catch { /* 忽略，保持关闭状态 */ }
}
$('#chk-launch').addEventListener('change', async (e) => {
  const want = e.target.checked;
  const r = await window.api.setLaunch(want);
  if (r && r.ok) {
    e.target.checked = !!r.enabled;
    toast(r.enabled ? '已开启开机自动启动 🚀' : '已关闭开机自动启动');
  } else {
    e.target.checked = !want;
    toast('设置失败：' + ((r && r.error) || '未知错误'), 'err');
  }
});

/* ---------- 密码保护（封面登录） ---------- */
function updatePwStatus() {
  const enabled = hasPassword;
  $('#pw-status').textContent = enabled
    ? '当前状态：已启用 —— 启动应用与从托盘重新打开时，需先在封面输入密码。'
    : '当前状态：未启用 —— 可在下方设置登录密码，启动后先经书本封面解锁再进入。';
  $('#lbl-pw-current').classList.toggle('hidden', !enabled);
  $('#pw-current').classList.toggle('hidden', !enabled);
  $('#btn-pw-disable').classList.toggle('hidden', !enabled);
  $('#pw-current').value = '';
  $('#pw-new').value = '';
  $('#pw-new2').value = '';
}

$('#btn-pw-save').addEventListener('click', async () => {
  const current = $('#pw-current').value;
  const nw = $('#pw-new').value;
  const nw2 = $('#pw-new2').value;
  if (hasPassword && !current) return toast('请先输入当前密码', 'err');
  if (nw.length < 4) return toast('新密码至少需要 4 位', 'err');
  if (nw !== nw2) return toast('两次输入的新密码不一致', 'err');
  const r = await window.api.authSet({ current, next: nw });
  if (!r.ok) return toast(r.error || '保存失败', 'err');
  hasPassword = true;
  $('#btn-lock').classList.remove('hidden');
  updatePwStatus();
  toast('密码已保存，下次启动需解锁进入 🔒');
});

$('#btn-pw-disable').addEventListener('click', async () => {
  const current = $('#pw-current').value;
  if (!current) return toast('请输入当前密码以关闭保护', 'err');
  if (!confirm('确定关闭密码保护？关闭后打开应用将不再需要密码。')) return;
  const r = await window.api.authSet({ current, next: null });
  if (!r.ok) return toast(r.error || '操作失败', 'err');
  hasPassword = false;
  $('#btn-lock').classList.add('hidden');
  updatePwStatus();
  toast('已关闭密码保护');
});

function updateLastBackup() {
  $('#last-backup').textContent = config.lastBackupAt
    ? `上次备份：${new Date(config.lastBackupAt).toLocaleString('zh-CN')}`
    : '上次备份：从未';
}

async function persistWebdavSettings() {
  config.webdav = { server: $('#wd-server').value.trim(), username: $('#wd-user').value.trim() };
  config.autoBackupHours = Number($('#auto-backup').value) || 0;
  await window.api.setSecret('webdavPassword', $('#wd-pass').value || null);
  await window.api.saveConfig(config);
}
$('#auto-backup').addEventListener('change', persistWebdavSettings);

function readWdFields() {
  return { server: $('#wd-server').value.trim(), username: $('#wd-user').value.trim(), password: $('#wd-pass').value };
}
function setBusy(sel, busy) {
  const b = $(sel);
  b.disabled = busy;
  b.textContent = busy ? '… 处理中' : b.dataset.label;
}
['#btn-wd-test', '#btn-wd-backup', '#btn-wd-restore'].forEach((s) => { $(s).dataset.label = $(s).textContent; });

$('#btn-wd-test').addEventListener('click', async () => {
  const cfg = readWdFields();
  if (!cfg.server) return toast('请先填写 WebDAV 服务器地址', 'err');
  setBusy('#btn-wd-test', true);
  await persistWebdavSettings();
  const r = await window.api.webdavTest(cfg);
  setBusy('#btn-wd-test', false);
  toast(r.ok ? r.message : '连接失败：' + r.error, r.ok ? 'ok' : 'err');
});

$('#btn-wd-backup').addEventListener('click', async () => {
  const cfg = readWdFields();
  if (!cfg.server) return toast('请先填写 WebDAV 服务器地址', 'err');
  setBusy('#btn-wd-backup', true);
  await persistWebdavSettings();
  const r = await window.api.webdavBackup({ ...cfg, data: state });
  setBusy('#btn-wd-backup', false);
  if (r.ok) {
    config.lastBackupAt = new Date().toISOString();
    await window.api.saveConfig(config);
    updateLastBackup();
    toast('☁ 已备份到云端');
  } else {
    toast('备份失败：' + r.error, 'err');
  }
});

$('#btn-wd-restore').addEventListener('click', async () => {
  const cfg = readWdFields();
  if (!cfg.server) return toast('请先填写 WebDAV 服务器地址', 'err');
  if (!confirm('从云端恢复将覆盖当前全部便签和任务，确定继续？')) return;
  setBusy('#btn-wd-restore', true);
  const r = await window.api.webdavRestore(cfg);
  setBusy('#btn-wd-restore', false);
  if (!r.ok) return toast('恢复失败：' + r.error, 'err');
  state = normalize(r.data);
  await window.api.saveData(state);
  renderAll();
  toast(`已从云端恢复（备份于 ${new Date(r.exportedAt).toLocaleString('zh-CN')}）`);
});

// 手动导出 / 导入
$('#btn-export-json').addEventListener('click', async () => {
  const payload = { app: 'sticky-notes-tasks', version: 1, exportedAt: new Date().toISOString(), data: state };
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const r = await window.api.exportFile(`便签备份-${stamp}.json`, JSON.stringify(payload, null, 2));
  if (r.ok) toast('备份已导出：' + r.filePath);
  else if (!r.canceled) toast('导出失败：' + (r.error || ''), 'err');
});

$('#btn-import-json').addEventListener('click', async () => {
  const r = await window.api.importFile();
  if (!r.ok) return r.canceled ? null : toast('读取文件失败：' + (r.error || ''), 'err');
  let payload;
  try { payload = JSON.parse(r.content); } catch { return toast('文件不是有效的 JSON', 'err'); }
  const data = payload && payload.app === 'sticky-notes-tasks' ? payload.data : (payload && payload.notes ? payload : null);
  if (!data) return toast('备份文件格式不正确', 'err');
  if (!confirm('从文件恢复将覆盖当前全部便签和任务，确定继续？')) return;
  state = normalize(data);
  await window.api.saveData(state);
  renderAll();
  document.querySelectorAll('.modal.open').forEach((m) => m.classList.remove('open'));
  toast('已从文件恢复 ✓');
});

/* ================= 全局快捷键 / 托盘事件 ================= */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    if (currentTab === 'notes') newNote();
    else $('#task-input').focus();
  }
  if (e.key === 'Escape') document.querySelectorAll('.modal.open').forEach((m) => m.classList.remove('open'));
});

window.api.onTrayNewNote(() => { if (!authed) return; switchTab('notes'); newNote(); });
window.api.onTrayNewTask(() => { if (!authed) return; switchTab('tasks'); $('#task-input').focus(); });
window.api.onAutoBackup((r) => {
  if (r.at) { config.lastBackupAt = r.at; updateLastBackup(); }
  toast(r.ok ? '⏰ 已自动备份到云端' : '自动备份失败：' + r.error, r.ok ? 'ok' : 'err');
});

/* ================= 待办到点提醒 ================= */
function shakeTask(id, scroll) {
  const el = document.querySelector(`.task[data-id="${id}"]`);
  if (!el) return;
  if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('remind');
  void el.offsetWidth;
  el.classList.add('remind');
  setTimeout(() => el.classList.remove('remind'), 4000);
}
window.api.onTaskReminded((r) => {
  if (!authed || r.locked) return; // 锁定时不显示任务内容
  toast(`⏰ 到点提醒：${r.title}`);
  shakeTask(r.id);
  // 网页版：尝试系统通知（不支持时仅 toast 提示）
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('⏰ 到点提醒', { body: r.title });
    }
  } catch { /* 忽略 */ }
});
window.api.onTaskLocate((id) => {
  if (!authed) return;
  switchTab('tasks');
  setTimeout(() => shakeTask(id, true), 80);
});

// 未捕获错误打到 console（主进程会转发出来，便于排查）
window.addEventListener('error', (e) => console.error('Uncaught:', e.message));

/* ================= 初始化：封面密码门禁 ================= */
(async function init() {
  let st = { hasPassword: false, unlocked: false };
  try { st = await window.api.authStatus(); } catch { /* 主进程不可用时直接进入 */ }
  hasPassword = !!st.hasPassword;
  if (hasPassword && !st.unlocked) return showCover('unlock'); // 数据等解锁后再加载
  if (!hasPassword) return showCover('setup');                 // 首次使用：设置或跳过密码
  await enterApp(); // 主进程已是解锁状态（如窗口重建前的会话）
})();
