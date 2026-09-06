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

let state = { notes: [], archived: [], trash: [], tasks: [], taskLog: [] };
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
  return { notes: arr(data.notes), archived: arr(data.archived), trash: arr(data.trash), tasks: arr(data.tasks), taskLog: arr(data.taskLog) };
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
  migrateTasks();
  renderAll();
  sweepTasks();
  enforceNotePageLimit(); // 启动时兼容旧数据：最大保留10页（30条）
  currentNotePage = 1; // 进入时显示第1页（最新内容）
  renderNotes();
  $('#btn-lock').classList.toggle('hidden', !hasPassword);
  if (window.ghSync) window.ghSync.onEnter(); // 进入主界面后尝试拉取云端
}

// 手动锁定 / 自动锁定：清空界面数据回到封面
async function lockApp() {
  authed = false;
  state = { notes: [], archived: [], trash: [], tasks: [], taskLog: [] };
  expandedTaskId = null;
  searchTerm = '';
  $('#search').value = '';
  $('#notes-grid').innerHTML = '';
  $('#today-list').innerHTML = '';
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
function noteTextStyle(n) {
  const s = [];
  if (n.font) s.push(`font-family:${n.font}`);
  if (n.textColor) s.push(`color:${n.textColor}`);
  if (n.fontSize) s.push(`font-size:${n.fontSize}px`);
  return s.join(';');
}
function noteHtml(n) {
  return `
  <div class="note-card c-${n.color || 'yellow'}" data-id="${n.id}">
    <div class="note-top">
      <span class="note-date">${fmtDate(n.updatedAt || n.createdAt)}</span>
      <button class="note-recolor" title="换个颜色">🎨</button>
    </div>
    <div class="note-text" contenteditable="true" data-placeholder="写点什么…" style="${noteTextStyle(n)}">${escapeHtml(n.text)}</div>
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

  paintNotesPage(pageNotes, totalPages);
}

function paintNotesPage(pageNotes, totalPages) {
  $('#notes-grid').innerHTML = pageNotes.map(noteHtml).join('');
  updatePager(totalPages);
}
function updatePager(totalPages) {
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

// ---------- 便签格式工具条（字体 / 颜色 / 字号 / 行首符号） ----------
const NOTE_FONTS = [
  ['', '默认字体'],
  ['"Microsoft YaHei", sans-serif', '微软雅黑'],
  ['SimSun, serif', '宋体'],
  ['SimHei, sans-serif', '黑体'],
  ['KaiTi, serif', '楷体'],
  ['Consolas, monospace', '等宽'],
];
const NOTE_COLORS = [
  ['', '默认'], ['#d9534f', '红'], ['#e07f06', '橙'], ['#2e8b57', '绿'],
  ['#3b6fc4', '蓝'], ['#8e5bb8', '紫'], ['#8a857a', '灰'],
];
const NOTE_SIZES = [[13, '小'], [15, '中'], [18, '大'], [22, '特大']];
const LINE_SYMBOLS = ['□', '○', '●', '★', '☆', '✓', '■', '▶'];

const ntb = document.createElement('div');
ntb.id = 'note-toolbar';
ntb.innerHTML = `
  <div class="ntb-row">
    <select id="ntb-font" title="字体">${NOTE_FONTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    <select id="ntb-size" title="字号">${NOTE_SIZES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    <span class="ntb-colors">${NOTE_COLORS.map(([v, l]) => `<button class="ntb-color${v ? '' : ' def'}" data-c="${v}" title="${l}" style="${v ? 'background:' + v : ''}">${v ? '' : '默'}</button>`).join('')}</span>
  </div>
  <div class="ntb-row">
    <span class="ntb-label">行首符号</span>
    ${LINE_SYMBOLS.map((s) => `<button class="ntb-sym" data-sym="${s}" title="在光标所在行首插入 ${s}">${s}</button>`).join('')}
  </div>`;
$('#page-notes').appendChild(ntb);

let ntbNoteId = null;
function ntbCurrentNote() { return state.notes.find((x) => x.id === ntbNoteId); }
function ntbSync() {
  const n = ntbCurrentNote(); if (!n) return;
  $('#ntb-font').value = n.font || '';
  $('#ntb-size').value = String(n.fontSize || 15);
  ntb.querySelectorAll('.ntb-color').forEach((b) => b.classList.toggle('active', (b.dataset.c || '') === (n.textColor || '')));
}
function ntbApply() {
  const n = ntbCurrentNote(); if (!n) return;
  const el = document.querySelector(`.note-card[data-id="${n.id}"] .note-text`);
  if (el) el.style.cssText = noteTextStyle(n);
}
function showNtb(card) {
  ntbNoteId = card.dataset.id;
  ntbSync();
  ntb.classList.add('open');
  const page = $('#page-notes');
  const pr = page.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  ntb.style.left = Math.max(8, cr.left - pr.left) + 'px';
  ntb.style.top = Math.max(4, cr.top - pr.top - ntb.offsetHeight - 6) + 'px';
}
function hideNtb() { ntb.classList.remove('open'); ntbNoteId = null; }

$('#notes-grid').addEventListener('focusin', (e) => {
  if (!e.target.classList || !e.target.classList.contains('note-text')) return;
  showNtb(e.target.closest('.note-card'));
});
$('#notes-grid').addEventListener('focusout', (e) => {
  if (!e.target.classList || !e.target.classList.contains('note-text')) return;
  setTimeout(() => {
    const a = document.activeElement;
    if (a && (a.closest('#note-toolbar') || (a.classList && a.classList.contains('note-text')))) return;
    hideNtb();
  }, 120);
});
ntb.addEventListener('mousedown', (e) => e.preventDefault()); // 保持便签焦点与选区
ntb.addEventListener('change', (e) => {
  const n = ntbCurrentNote(); if (!n) return;
  if (e.target.id === 'ntb-font') n.font = e.target.value;
  if (e.target.id === 'ntb-size') n.fontSize = Number(e.target.value);
  n.updatedAt = Date.now();
  ntbApply(); scheduleSave();
});
ntb.addEventListener('click', (e) => {
  const n = ntbCurrentNote(); if (!n) return;
  const cb = e.target.closest('.ntb-color');
  if (cb) {
    n.textColor = cb.dataset.c || '';
    n.updatedAt = Date.now();
    ntbSync(); ntbApply(); scheduleSave();
    return;
  }
  const sb = e.target.closest('.ntb-sym');
  if (sb) insertLineSymbol(sb.dataset.sym);
});

// 在光标所在行首插入符号
function insertLineSymbol(sym) {
  const el = document.querySelector(`.note-card[data-id="${ntbNoteId}"] .note-text`);
  if (!el) return;
  const sel = window.getSelection();
  let off = (el.textContent || '').length;
  if (sel.rangeCount && el.contains(sel.anchorNode)) {
    const r = sel.getRangeAt(0).cloneRange();
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    off = pre.toString().length;
  }
  const text = el.textContent || '';
  const lineStart = text.lastIndexOf('\n', off - 1) + 1;
  const insert = sym + ' ';
  el.textContent = text.slice(0, lineStart) + insert + text.slice(lineStart);
  // 还原光标到插入点之后
  const pos = lineStart + insert.length;
  const range = document.createRange();
  let walked = 0, placed = false;
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = tw.nextNode())) {
    if (walked + node.length >= pos) { range.setStart(node, pos - walked); placed = true; break; }
    walked += node.length;
  }
  if (!placed) range.setStart(el, el.childNodes.length);
  range.collapse(true);
  sel.removeAllRanges(); sel.addRange(range);
  el.focus();
  // 触发保存
  const n = ntbCurrentNote();
  if (n) { n.text = el.textContent; n.updatedAt = Date.now(); scheduleSave(); }
}

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

/* ================= 任务 v2：循环 / 一次性 / 自动归档 / 全局查询 ================= */
const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtTime = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtFull = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const WEEK_CN = '日一二三四五六';

function migrateTasks() {
  if (!Array.isArray(state.tasks)) state.tasks = [];
  for (const t of state.tasks) {
    if (!t.type) t.type = 'once';
    if (t.remind === undefined) t.remind = true;
    if (t.type !== 'once' && !t.time) t.time = '09:00';
  }
  if (!Array.isArray(state.taskLog)) state.taskLog = [];
}

function recurApplies(t, d) {
  switch (t.type) {
    case 'daily': return true;
    case 'weekdays': return d.getDay() >= 1 && d.getDay() <= 5;
    case 'weekly': return d.getDay() === Number(t.weekday == null ? 1 : t.weekday);
    case 'monthly': return d.getDate() === Number(t.monthDay || 1);
    case 'yearly': return (d.getMonth() + 1) === Number(t.yearMonth || 1) && d.getDate() === Number(t.yearDay || 1);
    default: return false;
  }
}
function instanceDueMs(t, d) {
  if (t.type === 'once') return dueMs(t.due);
  const [hh, mm] = String(t.time || '09:00').split(':').map(Number);
  const x = new Date(d); x.setHours(hh || 0, mm || 0, 0, 0);
  return x.getTime();
}
function recurLabel(t) {
  switch (t.type) {
    case 'daily': return `每天 ${t.time}`;
    case 'weekdays': return `工作日 ${t.time}`;
    case 'weekly': return `每周${WEEK_CN[Number(t.weekday == null ? 1 : t.weekday)]} ${t.time}`;
    case 'monthly': return `每月${t.monthDay || 1}日 ${t.time}`;
    case 'yearly': return `每年${t.yearMonth || 1}月${t.yearDay || 1}日 ${t.time}`;
    default: return t.due ? `一次性 ${fmtFull(dueMs(t.due))}` : '一次性';
  }
}
function nextOccurrence(t, from) {
  if (t.type === 'once') { const m = dueMs(t.due); return (m != null && m >= from) ? m : null; }
  for (let i = 0; i < 400; i++) {
    const d = new Date(from + i * 86400000);
    if (recurApplies(t, d)) { const m = instanceDueMs(t, d); if (m >= from) return m; }
  }
  return null;
}

// 今日任务实例（一次性 + 今天适用的循环任务）
function todayTasks() {
  const now = new Date(); const key = dateKey(now); const nowMs = now.getTime();
  const list = [];
  for (const t of state.tasks) {
    if (t.type === 'once') {
      const dm = dueMs(t.due);
      if (dm == null) continue;
      if (dateKey(new Date(dm)) === key || dm <= nowMs) list.push({ t, dueMs: dm, done: false, once: true });
    } else if (recurApplies(t, now)) {
      list.push({ t, dueMs: instanceDueMs(t, now), done: !!(t.doneDates && t.doneDates[key]), once: false });
    }
  }
  return list.sort((a, b) => a.dueMs - b.dueMs);
}

// 到点自动完成并归档
function sweepTasks() {
  const now = new Date(); const nowMs = now.getTime(); const key = dateKey(now);
  let changed = false;
  for (const t of [...state.tasks]) {
    if (t.type === 'once') {
      const dm = dueMs(t.due);
      if (dm != null && nowMs >= dm) {
        state.tasks = state.tasks.filter((x) => x.id !== t.id);
        state.taskLog.unshift({ id: uid(), taskId: t.id, title: t.title, dueMs: dm, completedAt: nowMs, auto: true });
        changed = true;
      }
    } else if (recurApplies(t, now)) {
      const dm = instanceDueMs(t, now);
      if (nowMs >= dm && !(t.doneDates && t.doneDates[key])) {
        t.doneDates = t.doneDates || {}; t.doneDates[key] = nowMs;
        state.taskLog.unshift({ id: uid(), taskId: t.id, title: t.title, dueMs: dm, completedAt: nowMs, auto: true });
        changed = true;
      }
    }
  }
  if (changed) { scheduleSave(); renderTasks(); }
}

function todayHtml(x) {
  const t = x.t;
  const priCls = t.priority === 2 ? ' pri-2' : t.priority === 1 ? ' pri-1' : '';
  const priChip = t.priority === 2 ? '<span class="chip pri-2">🔴 高</span>'
    : t.priority === 1 ? '<span class="chip pri-1">🟡 中</span>' : '';
  return `
  <div class="task${x.done ? ' done' : ''}${priCls}" data-id="${t.id}">
    <div class="task-time"><b>${fmtTime(x.dueMs)}</b><span>${x.once ? '一次性' : '循环'}</span></div>
    <button class="task-check" title="${x.done ? '已完成' : '标记完成'}">✓</button>
    <div class="task-main">
      <div class="task-title">${escapeHtml(t.title)}</div>
      <div class="task-meta">
        <span class="chip">${x.once ? '📌' : '🔁'} ${escapeHtml(recurLabel(t))}</span>
        ${priChip}
        ${t.remind ? '' : '<span class="chip">🔕 不提醒</span>'}
      </div>
    </div>
    <div class="task-actions">
      <button class="ta-edit" title="编辑内容/时间/提醒">✏️</button>
      <button class="ta-del" title="删除任务">🗑</button>
    </div>
  </div>`;
}

let taskFilter = 'all';
function renderTasks() {
  migrateTasks();
  const list = todayTasks();
  const done = list.filter((x) => x.done).length;
  const pct = list.length ? Math.round((done / list.length) * 100) : 0;
  const C = 2 * Math.PI * 52;
  const fg = $('#ring-fg');
  fg.style.strokeDasharray = C;
  fg.style.strokeDashoffset = C * (1 - pct / 100);
  $('#ring-pct').textContent = pct + '%';
  $('#stat-todo').textContent = list.length - done;
  $('#stat-done').textContent = done;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  $('#stat-today').textContent = state.taskLog.filter((x) => x.completedAt >= t0.getTime()).length;
  // 顶部日期与状态语
  const d = new Date();
  $('#hero-date').textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`;
  $('#hero-sub').textContent = !list.length ? '今天没有安排，享受闲暇 ☕'
    : done === list.length ? '全部完成，太棒了 🎉' : '专注当下，逐项击破 💪';
  // 筛选渲染
  const shown = taskFilter === 'todo' ? list.filter((x) => !x.done)
    : taskFilter === 'done' ? list.filter((x) => x.done) : list;
  document.querySelectorAll('.task-filter .fchip').forEach((b) => b.classList.toggle('active', b.dataset.f === taskFilter));
  $('#today-list').innerHTML = shown.length ? shown.map(todayHtml).join('')
    : `<div class="task-empty">${list.length ? '该筛选下暂无任务' : '🎉 今天没有任务，在上方添加一个吧'}</div>`;
  renderTaskSearch();
}

// 筛选切换
document.querySelector('.task-filter').addEventListener('click', (e) => {
  const b = e.target.closest('.fchip');
  if (!b) return;
  taskFilter = b.dataset.f;
  renderTasks();
});

// 手动完成今日实例并归档
function completeToday(id) {
  const t = state.tasks.find((x) => x.id === id); if (!t) return;
  const now = new Date(); const key = dateKey(now); const nowMs = now.getTime();
  const dm = t.type === 'once' ? dueMs(t.due) : instanceDueMs(t, now);
  if (t.type === 'once') state.tasks = state.tasks.filter((x) => x.id !== id);
  else { t.doneDates = t.doneDates || {}; t.doneDates[key] = nowMs; }
  state.taskLog.unshift({ id: uid(), taskId: id, title: t.title, dueMs: dm, completedAt: nowMs, auto: false });
  scheduleSave(); renderTasks();
  toast('任务完成，干得漂亮 🎉');
}

// ---------- 添加 / 编辑表单字段联动 ----------
function syncTaskFields(prefix) {
  const type = $(`#${prefix}-type`).value;
  const isOnce = type === 'once';
  $(`#${prefix}-due`).classList.toggle('hidden', !isOnce);
  $(`#${prefix}-time`).classList.toggle('hidden', isOnce);
  $(`#${prefix}-weekday`).classList.toggle('hidden', type !== 'weekly');
  $(`#${prefix}-monthday`).classList.toggle('hidden', type !== 'monthly');
  $(`#${prefix}-yearmonth`).classList.toggle('hidden', type !== 'yearly');
  $(`#${prefix}-yearday`).classList.toggle('hidden', type !== 'yearly');
}

function readTaskForm(prefix) {
  const type = $(`#${prefix}-type`).value;
  return {
    type,
    time: $(`#${prefix}-time`).value || '09:00',
    due: $(`#${prefix}-due`).value || null,
    weekday: Number($(`#${prefix}-weekday`).value),
    monthDay: Number($(`#${prefix}-monthday`).value) || 1,
    yearMonth: Number($(`#${prefix}-yearmonth`).value) || 1,
    yearDay: Number($(`#${prefix}-yearday`).value) || 1,
    priority: Number($(`#${prefix}-priority`).value) || 0,
    remind: $(`#${prefix}-remind`).checked,
  };
}

// 添加任务
$('#task-add-btn').addEventListener('click', () => {
  const title = $('#task-input').value.trim();
  if (!title) return toast('先输入任务内容', 'err');
  const f = readTaskForm('task');
  if (f.type === 'once' && !f.due) return toast('一次性任务请选择日期时间', 'err');
  state.tasks.unshift({ id: uid(), title, createdAt: Date.now(), ...f });
  $('#task-input').value = '';
  scheduleSave(); renderTasks();
  toast('任务已添加 ✓');
});
$('#task-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#task-add-btn').click(); });
['task-type'].forEach((id) => $(`#${id}`).addEventListener('change', () => syncTaskFields('task')));

// 任务输入一键复制
$('#task-copy').addEventListener('click', async () => {
  const v = $('#task-input').value;
  if (!v.trim()) return toast('输入框是空的，先写点任务内容吧', 'err');
  await window.api.copyText(v);
  toast('任务内容已复制 📋');
});

// ---------- 今日任务列表交互 ----------
$('#today-list').addEventListener('click', (e) => {
  const el = e.target.closest('.task'); if (!el) return;
  const id = el.dataset.id;
  if (e.target.closest('.task-check')) return completeToday(id);
  if (e.target.closest('.ta-edit')) return openTaskEdit(id);
  if (e.target.closest('.ta-del')) {
    if (!confirm('删除该任务？删除后不再出现（已完成记录保留）。')) return;
    state.tasks = state.tasks.filter((x) => x.id !== id);
    scheduleSave(); renderTasks();
    toast('任务已删除');
  }
});

// ---------- 编辑弹窗 ----------
let editingTaskId = null;
function openTaskEdit(id) {
  const t = state.tasks.find((x) => x.id === id); if (!t) return;
  editingTaskId = id;
  $('#te-title').value = t.title || '';
  $('#te-type').value = t.type || 'once';
  $('#te-time').value = t.time || '09:00';
  $('#te-due').value = dueInputVal(t.due);
  $('#te-weekday').value = String(t.weekday == null ? 1 : t.weekday);
  $('#te-monthday').value = t.monthDay || 1;
  $('#te-yearmonth').value = t.yearMonth || 1;
  $('#te-yearday').value = t.yearDay || 1;
  $('#te-priority').value = String(t.priority || 0);
  $('#te-remind').checked = t.remind !== false;
  syncTaskFields('te');
  showModal('modal-task');
}
$('#te-type').addEventListener('change', () => syncTaskFields('te'));
$('#te-save').addEventListener('click', () => {
  const t = state.tasks.find((x) => x.id === editingTaskId); if (!t) return;
  const title = $('#te-title').value.trim();
  if (!title) return toast('任务内容不能为空', 'err');
  const f = readTaskForm('te');
  if (f.type === 'once' && !f.due) return toast('一次性任务请选择日期时间', 'err');
  Object.assign(t, { title, ...f });
  $('#modal-task').classList.remove('open');
  scheduleSave(); renderTasks();
  toast('任务已更新 ✓');
});
$('#te-del').addEventListener('click', () => {
  if (!confirm('删除该任务？删除后不再出现（已完成记录保留）。')) return;
  state.tasks = state.tasks.filter((x) => x.id !== editingTaskId);
  $('#modal-task').classList.remove('open');
  scheduleSave(); renderTasks();
  toast('任务已删除');
});

// ---------- 全局查询（过去 + 未来） ----------
function renderTaskSearch() {
  const box = $('#task-search-results');
  const term = ($('#task-search').value || '').trim().toLowerCase();
  if (!term) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const nowMs = Date.now();
  const rows = [];
  for (const t of state.tasks) {
    if (!(t.title || '').toLowerCase().includes(term)) continue;
    if (t.type === 'once') rows.push({ when: dueMs(t.due), title: t.title, tag: '一次性', future: dueMs(t.due) >= nowMs, done: false });
    else rows.push({ when: nextOccurrence(t, nowMs), title: t.title, tag: recurLabel(t), future: true, done: false });
  }
  for (const l of state.taskLog) {
    if (!(l.title || '').toLowerCase().includes(term)) continue;
    rows.push({ when: l.dueMs, title: l.title, tag: l.auto ? '自动完成' : '手动完成', future: false, done: true });
  }
  rows.sort((a, b) => (a.when || 0) - (b.when || 0));
  box.classList.remove('hidden');
  box.innerHTML = rows.length ? rows.map((r) => `
    <div class="search-row ${r.done ? 'done' : ''}">
      <span class="s-time">${r.when ? fmtFull(r.when) : '—'}</span>
      <span class="s-title">${escapeHtml(r.title)}</span>
      <span class="s-tag">${r.future ? '🔜' : '✅'} ${escapeHtml(r.tag)}</span>
    </div>`).join('')
    : `<div class="task-empty">🔍 没有匹配的任务</div>`;
}
$('#task-search').addEventListener('input', renderTaskSearch);

// 填充「每月几号 / 每年几月 / 几号」下拉选项
function fillDayOptions() {
  [['#task-monthday', '#te-monthday', 31, '日'], ['#task-yearday', '#te-yearday', 31, '日']].forEach(([a, b, n, unit]) => {
    const opts = Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${i + 1}${unit}</option>`).join('');
    $(a).innerHTML = opts; $(b).innerHTML = opts;
  });
  const months = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}月</option>`).join('');
  $('#task-yearmonth').innerHTML = months;
  $('#te-yearmonth').innerHTML = months;
}
fillDayOptions();
syncTaskFields('task');

// 定时扫描：到点自动归档 + 刷新今日列表
setInterval(() => { if (authed) { sweepTasks(); } }, 30 * 1000);


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
