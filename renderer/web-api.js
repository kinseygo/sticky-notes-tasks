// web-api.js — 浏览器（手机/网页版）回退层
// 仅在非 Electron 环境（window.api 未被 preload 注入）时启用，
// 用 localStorage / WebCrypto / fetch 实现与桌面端一致的 API 形状。
(function () {
  if (window.api) return; // Electron 桌面端：preload 已注入，直接跳过

  const LS = {
    data: 'snt.data',
    config: 'snt.config',
    secrets: 'snt.secrets',
    password: 'snt.password',
  };
  const BACKUP_FILENAME = 'sticky-notes-backup.json';

  const readJson = (key, fallback) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  };
  const writeJson = (key, obj) => localStorage.setItem(key, JSON.stringify(obj));

  // ---------- 密码门禁（WebCrypto PBKDF2，与桌面端 scrypt 存储各自独立） ----------
  let unlocked = false;
  let authFailCount = 0;
  let authLockUntil = 0;

  const readPasswordEntry = () => readJson(LS.password, null);
  const hasPassword = () => { const e = readPasswordEntry(); return !!(e && e.hash && e.salt); };
  const isUnlocked = () => unlocked || !hasPassword();

  async function passwordMatches(entry, pw) {
    try {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', enc.encode(String(pw || '')), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: Buffer_hex(entry.salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
      const a = btoa(String.fromCharCode(...new Uint8Array(bits)));
      return a === entry.hash;
    } catch { return false; }
  }
  function Buffer_hex(hex) {
    const u = new Uint8Array(hex.length / 2);
    for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.substr(i * 2, 2), 16);
    return u;
  }
  async function hashPassword(pw, saltHex) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: Buffer_hex(saltHex), iterations: 100000, hash: 'SHA-256' }, key, 256);
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  }
  const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, '0')).join('');

  // ---------- WebDAV（浏览器直接 fetch） ----------
  function webdavUrl(server) {
    let s = String(server || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return `${s}/${BACKUP_FILENAME}`;
  }
  function friendlyNetError(err) {
    return (err && err.message) ? err.message : String(err);
  }
  async function webdavFetch(cfg, options = {}) {
    return fetch(webdavUrl(cfg.server), {
      ...options,
      headers: { Authorization: 'Basic ' + btoa(`${cfg.username || ''}:${cfg.password || ''}`), ...(options.headers || {}) },
    });
  }
  async function doBackup(cfg, data) {
    const payload = { app: 'sticky-notes-tasks', version: 1, exportedAt: new Date().toISOString(), data };
    try {
      const res = await webdavFetch(cfg, { method: 'PUT', headers: { 'Content-Type': 'application/json', Overwrite: 'T' }, body: JSON.stringify(payload, null, 2) });
      if (res.status === 401 || res.status === 403) return { ok: false, error: '认证失败：账号或应用密码不正确' };
      if (res.status === 404) return { ok: false, error: '路径不存在（404）：地址需包含完整目录' };
      if (res.status === 409) return { ok: false, error: '目标目录不存在（409）：请先在网盘中创建该文件夹' };
      if (!res.ok) return { ok: false, error: `备份失败：HTTP ${res.status}` };
      return { ok: true };
    } catch (err) { return { ok: false, error: friendlyNetError(err) }; }
  }

  // ---------- 网页版到点提醒（页面打开期间，每 30 秒扫描一次） ----------
  const reminded = new Map();
  let remindCb = null;
  function dueMs(due) {
    if (!due) return null;
    let s = String(due);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T09:00:00';
    const t = new Date(s).getTime();
    return Number.isNaN(t) ? null : t;
  }
  function checkReminders() {
    const data = readJson(LS.data, null);
    if (!data || !Array.isArray(data.tasks) || !remindCb || !isUnlocked()) return;
    const now = Date.now();
    for (const t of data.tasks) {
      if (t.done || !t.id || !t.due) continue;
      const key = t.id + ':' + t.due;
      if (reminded.has(key)) continue;
      const ms = dueMs(t.due);
      if (ms == null) continue;
      if (now >= ms) {
        reminded.set(key, now);
        if (now - ms <= 30 * 60 * 1000) remindCb({ id: t.id, title: t.title || '（无标题任务）', locked: false });
      }
    }
  }
  // 启动时把早已过期的任务标记为已提醒，避免一打开就弹旧通知
  (function prime() {
    const data = readJson(LS.data, null);
    if (!data || !Array.isArray(data.tasks)) return;
    const now = Date.now();
    for (const t of data.tasks) {
      if (t.done || !t.id || !t.due) continue;
      const ms = dueMs(t.due);
      if (ms != null && now >= ms) reminded.set(t.id + ':' + t.due, now);
    }
  })();
  setInterval(checkReminders, 30 * 1000);

  // ---------- 导出 / 导入（浏览器下载与文件选择） ----------
  function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return resolve({ ok: false, canceled: true });
        try { resolve({ ok: true, content: await f.text() }); }
        catch (err) { resolve({ ok: false, error: String(err.message || err) }); }
      };
      input.click();
    });
  }

  window.api = {
    loadData: async () => (isUnlocked() ? readJson(LS.data, null) : null),
    saveData: async (data) => {
      if (!isUnlocked()) return { ok: false, locked: true };
      writeJson(LS.data, data);
      return { ok: true };
    },
    loadConfig: async () => readJson(LS.config, {}),
    saveConfig: async (cfg) => { writeJson(LS.config, cfg || {}); return { ok: true }; },

    copyText: async (text) => {
      try { await navigator.clipboard.writeText(String(text == null ? '' : text)); }
      catch {
        const ta = document.createElement('textarea');
        ta.value = String(text == null ? '' : text);
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      return { ok: true };
    },

    getSecret: async (key) => {
      const s = readJson(LS.secrets, {});
      return s[key] ? atob(s[key].v) : null;
    },
    setSecret: async (key, value) => {
      const s = readJson(LS.secrets, {});
      s[key] = value ? { v: btoa(unescape(encodeURIComponent(value))) } : null;
      writeJson(LS.secrets, s);
      return { ok: true };
    },

    exportFile: async ({ filename, content }) => { downloadFile(filename, content); return { ok: true }; },
    importFile: pickFile,

    webdavTest: async (cfg) => {
      try {
        const res = await webdavFetch(cfg, { method: 'GET' });
        if (res.status === 401 || res.status === 403) return { ok: false, error: '认证失败：账号或应用密码不正确' };
        if (res.status === 404) return { ok: true, message: '连接成功（云端暂无备份文件）' };
        if (!res.ok) return { ok: false, error: `连接失败：HTTP ${res.status}` };
        return { ok: true, message: '连接成功，云端已有备份' };
      } catch (err) { return { ok: false, error: friendlyNetError(err) }; }
    },
    webdavBackup: (args) => doBackup(args, args.data),
    webdavRestore: async (cfg) => {
      try {
        const res = await webdavFetch(cfg, { method: 'GET' });
        if (res.status === 404) return { ok: false, error: '云端没有找到备份文件' };
        if (res.status === 401 || res.status === 403) return { ok: false, error: '认证失败：账号或应用密码不正确' };
        if (!res.ok) return { ok: false, error: `恢复失败：HTTP ${res.status}` };
        const payload = await res.json();
        if (!payload || payload.app !== 'sticky-notes-tasks' || !payload.data) return { ok: false, error: '备份文件格式不正确' };
        return { ok: true, data: payload.data, exportedAt: payload.exportedAt };
      } catch (err) { return { ok: false, error: friendlyNetError(err) }; }
    },

    // 桌面端专有事件：网页版空实现
    onTrayNewNote: () => {},
    onTrayNewTask: () => {},
    onAutoBackup: () => {},
    onTaskReminded: (cb) => { remindCb = cb; },
    onTaskLocate: () => {},

    // 密码门禁
    authStatus: async () => ({ hasPassword: hasPassword(), unlocked: isUnlocked() }),
    authVerify: async (pw) => {
      const entry = readPasswordEntry();
      if (!entry || !entry.hash) { unlocked = true; return { ok: true }; }
      const waitMs = authLockUntil - Date.now();
      if (waitMs > 0) return { ok: false, error: `尝试次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后再试` };
      if (await passwordMatches(entry, pw)) { authFailCount = 0; unlocked = true; return { ok: true }; }
      authFailCount++;
      if (authFailCount >= 5) { authLockUntil = Date.now() + 10000; authFailCount = 0; return { ok: false, error: '密码错误次数过多，请 10 秒后再试' }; }
      return { ok: false, error: `密码不正确（还可尝试 ${5 - authFailCount} 次）` };
    },
    authSet: async ({ current, next } = {}) => {
      const entry = readPasswordEntry();
      if (entry && entry.hash && !(await passwordMatches(entry, current))) return { ok: false, error: '当前密码不正确' };
      if (next) {
        if (String(next).length < 4) return { ok: false, error: '密码至少需要 4 位' };
        const salt = randHex(16);
        writeJson(LS.password, { salt, hash: await hashPassword(String(next), salt) });
      } else {
        localStorage.removeItem(LS.password);
      }
      unlocked = true;
      return { ok: true };
    },
    authLock: async () => { unlocked = false; authFailCount = 0; return { ok: true }; },

    // 开机启动：网页版不支持
    getLaunch: async () => ({ ok: false }),
    setLaunch: async () => ({ ok: false }),
  };
})();
