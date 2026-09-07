// main.js — Electron 主进程：窗口、托盘、IPC、WebDAV 云备份、导出导入、密码门禁、到点提醒、开机启动
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, safeStorage, nativeImage, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ICON = path.join(__dirname, 'assets', '1557.ico');
const BACKUP_FILENAME = 'sticky-notes-backup.json';

let mainWindow = null;
let tray = null;
let autoBackupTimer = null;
let reminderTimer = null;

// Windows 系统通知需要 AppUserModelId 才能正常弹横幅
if (process.platform === 'win32') app.setAppUserModelId('com.gjxin.sticky-notes-tasks');

const dataFile = () => path.join(app.getPath('userData'), 'data.json');
const configFile = () => path.join(app.getPath('userData'), 'config.json');
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
const passwordFile = () => path.join(app.getPath('userData'), 'password.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// ---------- 窗口与托盘 ----------
const START_HIDDEN = process.argv.includes('--hidden'); // 开机自启时静默驻留托盘

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#f2f0eb',
    show: !START_HIDDEN,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 转发渲染进程 console 到 stdout，便于排查问题
  mainWindow.webContents.on('console-message', (_e, _level, message) => console.log('[renderer]', message));
  // 输入框/可选中内容的右键菜单：剪切、复制、粘贴、全选
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const editable = params.isEditable;
    const hasSel = (params.selectionText || '').trim().length > 0;
    if (!editable && !hasSel) return;
    Menu.buildFromTemplate([
      { label: '剪切', role: 'cut', enabled: editable && hasSel },
      { label: '复制', role: 'copy', enabled: hasSel },
      { label: '粘贴', role: 'paste', enabled: editable },
      { type: 'separator' },
      { label: '全选', role: 'selectAll', enabled: editable },
    ]).popup({ window: mainWindow });
  });
  // 窗口关闭（驻留托盘）即重新锁定，下次打开必须重新解锁
  mainWindow.on('closed', () => { mainWindow = null; lockSession(); });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('便签与任务');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '📝 新建便签', click: () => { showMainWindow(); mainWindow.webContents.send('tray:new-note'); } },
    { label: '✅ 新建任务', click: () => { showMainWindow(); mainWindow.webContents.send('tray:new-task'); } },
    { type: 'separator' },
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', () => showMainWindow());
}

// ---------- 数据 / 配置 / 密钥 IPC ----------
// 密码门禁：未解锁时不把数据交给渲染进程，也拒绝写入，避免锁定期间产生脏数据
let unlocked = false;
let authFailCount = 0;
let authLockUntil = 0;

function readPasswordEntry() { return readJson(passwordFile(), null); }
function hasPassword() { const e = readPasswordEntry(); return !!(e && e.hash && e.salt); }
function isUnlocked() { return unlocked || !hasPassword(); }
function lockSession() { unlocked = false; authFailCount = 0; }

function passwordMatches(entry, pw) {
  try {
    const a = Buffer.from(crypto.scryptSync(String(pw || ''), entry.salt, 32).toString('hex'));
    const b = Buffer.from(entry.hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

ipcMain.handle('auth:status', () => ({ hasPassword: hasPassword(), unlocked: isUnlocked() }));

ipcMain.handle('auth:verify', (_e, pw) => {
  const entry = readPasswordEntry();
  if (!entry || !entry.hash) { unlocked = true; return { ok: true }; }
  const waitMs = authLockUntil - Date.now();
  if (waitMs > 0) return { ok: false, error: `尝试次数过多，请 ${Math.ceil(waitMs / 1000)} 秒后再试` };
  if (passwordMatches(entry, pw)) {
    authFailCount = 0;
    unlocked = true;
    return { ok: true };
  }
  authFailCount++;
  if (authFailCount >= 5) {
    authLockUntil = Date.now() + 10000;
    authFailCount = 0;
    return { ok: false, error: '密码错误次数过多，请 10 秒后再试' };
  }
  return { ok: false, error: `密码不正确（还可尝试 ${5 - authFailCount} 次）` };
});

ipcMain.handle('auth:set', (_e, { current, next } = {}) => {
  const entry = readPasswordEntry();
  if (entry && entry.hash && !passwordMatches(entry, current)) {
    return { ok: false, error: '当前密码不正确' };
  }
  if (next) {
    if (String(next).length < 4) return { ok: false, error: '密码至少需要 4 位' };
    const salt = crypto.randomBytes(16).toString('hex');
    writeJson(passwordFile(), { salt, hash: crypto.scryptSync(String(next), salt, 32).toString('hex') });
  } else {
    try { fs.unlinkSync(passwordFile()); } catch { /* 文件本就不存在 */ }
  }
  unlocked = true; // 设置/修改/关闭密码的动作本身即完成了一次验证
  return { ok: true };
});

ipcMain.handle('auth:lock', () => { lockSession(); return { ok: true }; });

ipcMain.handle('data:load', () => (isUnlocked() ? readJson(dataFile(), null) : null));
ipcMain.handle('data:save', (_e, data) => {
  if (!isUnlocked()) return { ok: false, locked: true };
  writeJson(dataFile(), data);
  checkReminders(); // 数据刚保存，及时扫一遍到点任务
  return { ok: true };
});

ipcMain.handle('config:load', () => readJson(configFile(), {}));
ipcMain.handle('config:save', (_e, cfg) => { writeJson(configFile(), cfg || {}); restartAutoBackup(); return { ok: true }; });

// 一键复制（渲染进程不能直接访问剪贴板，经主进程写入）
ipcMain.handle('clip:copy', (_e, text) => {
  clipboard.writeText(String(text == null ? '' : text));
  return { ok: true };
});

function encryptSecret(value) {
  if (safeStorage.isEncryptionAvailable()) return { enc: true, v: safeStorage.encryptString(value).toString('base64') };
  return { enc: false, v: Buffer.from(value, 'utf8').toString('base64') };
}
function decryptSecret(entry) {
  if (!entry || !entry.v) return null;
  try {
    return entry.enc
      ? safeStorage.decryptString(Buffer.from(entry.v, 'base64'))
      : Buffer.from(entry.v, 'base64').toString('utf8');
  } catch { return null; }
}
ipcMain.handle('secret:set', (_e, key, value) => {
  const secrets = readJson(secretsFile(), {});
  secrets[key] = value ? encryptSecret(value) : null;
  writeJson(secretsFile(), secrets);
  return { ok: true };
});
ipcMain.handle('secret:get', (_e, key) => decryptSecret(readJson(secretsFile(), {})[key]));

// ---------- 导出 / 导入 ----------
ipcMain.handle('export:file', async (_e, { filename, content }) => {
  const ext = (String(filename).match(/\.([a-z0-9]+)$/i) || [])[1];
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename,
    filters: ext ? [{ name: ext.toUpperCase() + ' 文件', extensions: [ext] }] : undefined,
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('import:file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'JSON 备份', extensions: ['json'] }],
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
  try {
    return { ok: true, content: fs.readFileSync(filePaths[0], 'utf8') };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------- WebDAV（用内置 fetch 实现 PUT/GET） ----------
function webdavUrl(server) {
  let s = String(server || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return `${s}/${BACKUP_FILENAME}`;
}
function authHeader(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}
async function webdavFetch(cfg, options = {}) {
  return fetch(webdavUrl(cfg.server), {
    ...options,
    headers: { Authorization: authHeader(cfg.username || '', cfg.password || ''), ...(options.headers || {}) },
  });
}
function friendlyNetError(err) {
  const code = err && err.cause && err.cause.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析服务器地址，请检查 WebDAV 地址';
  if (code === 'ECONNREFUSED') return '连接被服务器拒绝';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return 'SSL 证书校验失败';
  if (code === 'ETIMEDOUT') return '连接超时';
  return (err && err.message) ? err.message : String(err);
}

async function doBackup(cfg, data) {
  const payload = { app: 'sticky-notes-tasks', version: 1, exportedAt: new Date().toISOString(), data };
  try {
    const res = await webdavFetch(cfg, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Overwrite: 'T' },
      body: JSON.stringify(payload, null, 2),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: '认证失败：账号或应用密码不正确' };
    if (res.status === 404) return { ok: false, error: '路径不存在（404）：地址需包含完整目录，如 https://dav.jianguanyun.com/dav/' };
    if (res.status === 409) return { ok: false, error: '目标目录不存在（409）：请先在网盘中创建该文件夹' };
    if (!res.ok) return { ok: false, error: `备份失败：HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyNetError(err) };
  }
}

ipcMain.handle('webdav:test', async (_e, cfg) => {
  try {
    const res = await webdavFetch(cfg, { method: 'GET' });
    if (res.status === 401 || res.status === 403) return { ok: false, error: '认证失败：账号或应用密码不正确' };
    if (res.status === 404) return { ok: true, message: '连接成功（云端暂无备份文件）' };
    if (!res.ok) return { ok: false, error: `连接失败：HTTP ${res.status}` };
    return { ok: true, message: '连接成功，云端已有备份' };
  } catch (err) {
    return { ok: false, error: friendlyNetError(err) };
  }
});

ipcMain.handle('webdav:backup', (_e, args) => doBackup(args, args.data));

ipcMain.handle('webdav:restore', async (_e, cfg) => {
  try {
    const res = await webdavFetch(cfg, { method: 'GET' });
    if (res.status === 404) return { ok: false, error: '云端没有找到备份文件' };
    if (res.status === 401 || res.status === 403) return { ok: false, error: '认证失败：账号或应用密码不正确' };
    if (!res.ok) return { ok: false, error: `恢复失败：HTTP ${res.status}` };
    const payload = await res.json();
    if (!payload || payload.app !== 'sticky-notes-tasks' || !payload.data) {
      return { ok: false, error: '备份文件格式不正确' };
    }
    return { ok: true, data: payload.data, exportedAt: payload.exportedAt };
  } catch (err) {
    return { ok: false, error: friendlyNetError(err) };
  }
});

// ---------- 自动备份 ----------
async function runAutoBackup() {
  const cfg = readJson(configFile(), {});
  const password = decryptSecret(readJson(secretsFile(), {}).webdavPassword);
  const data = readJson(dataFile(), null);
  if (!cfg.webdav || !cfg.webdav.server || !cfg.webdav.username || !password || !data) return;
  const result = await doBackup({ ...cfg.webdav, password }, data);
  if (result.ok) {
    cfg.lastBackupAt = new Date().toISOString();
    writeJson(configFile(), cfg);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backup:auto', { ok: result.ok, error: result.error, at: cfg.lastBackupAt });
  }
}

function restartAutoBackup() {
  if (autoBackupTimer) { clearInterval(autoBackupTimer); autoBackupTimer = null; }
  const cfg = readJson(configFile(), {});
  const hours = Number(cfg.autoBackupHours) || 0;
  if (hours > 0) autoBackupTimer = setInterval(runAutoBackup, hours * 3600 * 1000);
}

// ---------- 待办到点提醒（主进程调度，窗口关闭驻留托盘时也能提醒） ----------
const remindedTasks = new Map(); // key = 任务id:截止值，值 = 提醒时间戳

function dueMs(due) {
  if (!due) return null;
  let s = String(due);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T09:00:00'; // 旧数据只有日期，按当天 09:00
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

function showTaskNotification(task) {
  const locked = !isUnlocked(); // 锁定时不泄露任务内容
  const title = locked ? '⏰ 待办任务到点' : '⏰ 到点提醒';
  const body = locked ? '应用已锁定，点击解锁后查看详情' : task.title || '（无标题任务）';
  if (Notification.isSupported()) {
    const n = new Notification({ icon: nativeImage.createFromPath(ICON), title, body });
    n.on('click', () => {
      showMainWindow();
      if (!locked && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:locate', task.id);
    });
    n.show();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('task:reminded', { id: task.id, title: body, locked });
  }
}

// 循环任务是否适用今天
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
function pad2(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function checkReminders() {
  const data = readJson(dataFile(), null);
  if (!data || !Array.isArray(data.tasks)) return;
  const now = Date.now();
  const d = new Date();
  const fired = [];
  for (const t of data.tasks) {
    if (!t.id || t.remind === false) continue;
    if (t.type && t.type !== 'once') {
      // 循环任务
      if (!recurApplies(t, d)) continue;
      const key = t.id + ':' + dateKey(d) + ':' + (t.time || '09:00');
      if (remindedTasks.has(key)) continue;
      const [hh, mm] = String(t.time || '09:00').split(':').map(Number);
      const x = new Date(d); x.setHours(hh || 0, mm || 0, 0, 0);
      const ms = x.getTime();
      if (now >= ms) {
        remindedTasks.set(key, now);
        if (now - ms <= 30 * 60 * 1000) fired.push({ id: t.id, title: t.title });
      }
    } else {
      // 一次性任务（含旧数据）
      if (t.done || !t.due) continue;
      const key = t.id + ':' + t.due;
      if (remindedTasks.has(key)) continue;
      const ms = dueMs(t.due);
      if (ms == null) continue;
      if (now >= ms) {
        remindedTasks.set(key, now);
        if (now - ms <= 30 * 60 * 1000) fired.push({ id: t.id, title: t.title });
      }
    }
  }
  fired.forEach(showTaskNotification);
}

function primeReminders() {
  // 启动时把“启动前就已过期”的待办直接标记为已提醒，避免开机后弹一堆旧通知
  const data = readJson(dataFile(), null);
  if (!data || !Array.isArray(data.tasks)) return;
  const now = Date.now();
  const d = new Date();
  for (const t of data.tasks) {
    if (!t.id || t.remind === false) continue;
    if (t.type && t.type !== 'once') {
      if (!recurApplies(t, d)) continue;
      const key = t.id + ':' + dateKey(d) + ':' + (t.time || '09:00');
      const [hh, mm] = String(t.time || '09:00').split(':').map(Number);
      const x = new Date(d); x.setHours(hh || 0, mm || 0, 0, 0);
      if (now >= x.getTime()) remindedTasks.set(key, now);
    } else {
      if (t.done || !t.due) continue;
      const ms = dueMs(t.due);
      if (ms != null && now >= ms) remindedTasks.set(t.id + ':' + t.due, now);
    }
  }
}

function restartReminders() {
  if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
  reminderTimer = setInterval(checkReminders, 30 * 1000);
}

// ---------- 开机启动 ----------
function launchArgs() { return app.isPackaged ? ['--hidden'] : [path.resolve(__dirname), '--hidden']; }
ipcMain.handle('app:get-launch', () => {
  try { return { ok: true, enabled: !!app.getLoginItemSettings({ args: launchArgs() }).openAtLogin }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('app:set-launch', (_e, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath, args: launchArgs() });
    return { ok: true, enabled: !!app.getLoginItemSettings({ args: launchArgs() }).openAtLogin };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------- 应用生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    createWindow();
    createTray();
    restartAutoBackup();
    primeReminders();
    restartReminders();
  });

  // 关闭窗口后驻留托盘，从托盘菜单退出
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { if (tray) tray.destroy(); });
}
