// preload.js — 通过 contextBridge 安全暴露 API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 本地数据与配置
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  // 剪贴板（一键复制）
  copyText: (text) => ipcRenderer.invoke('clip:copy', text),
  // 加密存储的密钥（WebDAV 密码）
  getSecret: (key) => ipcRenderer.invoke('secret:get', key),
  setSecret: (key, value) => ipcRenderer.invoke('secret:set', key, value),
  // 手动导出 / 导入
  exportFile: (filename, content) => ipcRenderer.invoke('export:file', { filename, content }),
  importFile: () => ipcRenderer.invoke('import:file'),
  // WebDAV 云备份
  webdavTest: (cfg) => ipcRenderer.invoke('webdav:test', cfg),
  webdavBackup: (args) => ipcRenderer.invoke('webdav:backup', args),
  webdavRestore: (cfg) => ipcRenderer.invoke('webdav:restore', cfg),
  // 主进程事件
  onTrayNewNote: (cb) => ipcRenderer.on('tray:new-note', () => cb()),
  onTrayNewTask: (cb) => ipcRenderer.on('tray:new-task', () => cb()),
  onAutoBackup: (cb) => ipcRenderer.on('backup:auto', (_e, r) => cb(r)),
  // 密码门禁（封面登录）
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authVerify: (pw) => ipcRenderer.invoke('auth:verify', pw),
  authSet: (args) => ipcRenderer.invoke('auth:set', args),
  authLock: () => ipcRenderer.invoke('auth:lock'),
  // 开机启动
  getLaunch: () => ipcRenderer.invoke('app:get-launch'),
  setLaunch: (enabled) => ipcRenderer.invoke('app:set-launch', enabled),
  // 待办到点提醒（由主进程推送）
  onTaskReminded: (cb) => ipcRenderer.on('task:reminded', (_e, r) => cb(r)),
  onTaskLocate: (cb) => ipcRenderer.on('task:locate', (_e, id) => cb(id)),
});
