// sync.js — GitHub 云同步（PC 端与手机网页版同一账户自动同步）
// 数据存于用户私有仓库 sticky-notes-sync 的 data.json；令牌仅存本机。
(function () {
  const REPO = 'sticky-notes-sync';
  const FILE = 'data.json';
  const API = 'https://api.github.com';
  const LS_USER = 'snt.gh.user';
  const LS_ON = 'snt.gh.on';
  const LS_LOCAL_TS = 'snt.gh.localTs';

  const $ = (s) => document.querySelector(s);
  const b64encode = (str) => btoa(unescape(encodeURIComponent(str)));
  const b64decode = (b64) => decodeURIComponent(escape(atob(String(b64 || '').replace(/\s/g, ''))));

  let user = localStorage.getItem(LS_USER) || '';
  let on = localStorage.getItem(LS_ON) === '1';
  let localTs = Number(localStorage.getItem(LS_LOCAL_TS) || 0);
  let pushTimer = null;
  let busy = false;

  const getToken = () => window.api.getSecret('gh_token');

  function setStatus(msg) {
    const el = $('#gh-status');
    if (el) el.textContent = msg;
  }
  function persistLocalTs() { localStorage.setItem(LS_LOCAL_TS, String(localTs)); }

  async function ghApi(path, opts = {}) {
    const token = await getToken();
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        Authorization: 'Bearer ' + (token || ''),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.headers || {}),
      },
    });
    return res;
  }

  async function ensureRepo() {
    let res = await ghApi(`/repos/${user}/${REPO}`);
    if (res.ok) return true;
    if (res.status === 404) {
      res = await ghApi('/user/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: REPO, private: true, auto_init: false, description: '便签与任务 云同步数据（私有）' }),
      });
      if (res.ok || res.status === 422) return true; // 422=已存在
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message || `创建仓库失败：HTTP ${res.status}`);
    }
    if (res.status === 401) throw new Error('令牌无效或已过期（401）');
    if (res.status === 403) throw new Error('令牌权限不足（403）：需勾选 repo 权限');
    throw new Error(`访问仓库失败：HTTP ${res.status}`);
  }

  async function remoteGet() {
    const res = await ghApi(`/repos/${user}/${REPO}/contents/${FILE}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`读取云端失败：HTTP ${res.status}`);
    const j = await res.json();
    try { return JSON.parse(b64decode(j.content)); } catch { return null; }
  }

  async function remotePut(payload) {
    const cur = await ghApi(`/repos/${user}/${REPO}/contents/${FILE}`);
    let sha;
    let curText = null;
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
      try { curText = b64decode(j.content); } catch { /* ignore */ }
    } else if (cur.status !== 404) {
      throw new Error(`读取云端失败：HTTP ${cur.status}`);
    }
    if (curText === payload) return false; // 内容相同，跳过提交
    const res = await ghApi(`/repos/${user}/${REPO}/contents/${FILE}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'sync ' + new Date().toISOString(), content: b64encode(payload), ...(sha ? { sha } : {}) }),
    });
    if (!res.ok) throw new Error(`上传失败：HTTP ${res.status}`);
    return true;
  }

  async function push(silent) {
    if (busy) return;
    busy = true;
    try {
      const state = window.appBridge.getState();
      const payload = JSON.stringify({ app: 'sticky-notes-tasks', savedAt: localTs, data: state }, null, 2);
      const changed = await remotePut(payload);
      setStatus(`已绑定 @${user} · 上次同步：${new Date().toLocaleString()}${changed ? '' : '（无变化）'}`);
      if (!silent) window.appBridge.toast('☁ 已推送到 GitHub 云同步');
    } catch (err) {
      setStatus('同步失败：' + (err.message || err));
      if (!silent) window.appBridge.toast('同步失败：' + (err.message || err), 'err');
    } finally { busy = false; }
  }

  async function pull(force) {
    if (busy) return;
    busy = true;
    try {
      const remote = await remoteGet();
      if (!remote || !remote.data) {
        if (force) window.appBridge.toast('云端暂无数据', 'err');
        return;
      }
      if (force || remote.savedAt > localTs) {
        window.appBridge.applyState(remote.data);
        localTs = Number(remote.savedAt || 0);
        persistLocalTs();
        setStatus(`已绑定 @${user} · 上次同步：${new Date().toLocaleString()}`);
        window.appBridge.toast('⬇ 已从 GitHub 云端恢复数据');
      } else if (remote.savedAt < localTs) {
        await push(true); // 本地更新，反向推送
      }
    } catch (err) {
      setStatus('同步失败：' + (err.message || err));
      if (force) window.appBridge.toast('同步失败：' + (err.message || err), 'err');
    } finally { busy = false; }
  }

  function markLocalChange() {
    localTs = Date.now();
    persistLocalTs();
    if (!on) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push(true), 3000); // 改动后 3 秒自动推送
  }

  // ---------- 设置面板交互 ----------
  function wireUI() {
    const elUser = $('#gh-user');
    const elToken = $('#gh-token');
    const elOn = $('#gh-sync-on');
    if (!elUser) return;
    elUser.value = user;
    elOn.checked = on;
    setStatus(on && user ? `已绑定 @${user} · 自动同步开启` : '未绑定');

    $('#gh-btn-bind').addEventListener('click', async () => {
      const u = elUser.value.trim();
      const t = elToken.value.trim();
      if (!u || !t) { window.appBridge.toast('请填写 GitHub 用户名与令牌', 'err'); return; }
      setStatus('绑定中…');
      try {
        await window.api.setSecret('gh_token', t);
        // 校验令牌并确认用户名
        const res = await fetch(API + '/user', { headers: { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json' } });
        if (res.status === 401) throw new Error('令牌无效（401），请检查是否复制完整');
        if (!res.ok) throw new Error('校验失败：HTTP ' + res.status);
        const me = await res.json();
        if (me.login.toLowerCase() !== u.toLowerCase()) throw new Error(`用户名不匹配：令牌属于 @${me.login}`);
        user = me.login;
        localStorage.setItem(LS_USER, user);
        await ensureRepo();
        on = true;
        localStorage.setItem(LS_ON, '1');
        elOn.checked = true;
        elUser.value = user;
        setStatus(`已绑定 @${user} · 自动同步开启`);
        window.appBridge.toast('🔗 绑定成功，私有仓库已就绪');
        pull(false); // 绑定后立即尝试拉取（云端更新则覆盖，否则推送本地）
      } catch (err) {
        setStatus('绑定失败：' + (err.message || err));
        window.appBridge.toast('绑定失败：' + (err.message || err), 'err');
      }
    });

    elOn.addEventListener('change', () => {
      on = elOn.checked;
      localStorage.setItem(LS_ON, on ? '1' : '0');
      setStatus(on && user ? `已绑定 @${user} · 自动同步开启` : '自动同步已关闭');
    });

    $('#gh-btn-push').addEventListener('click', () => { if (user) push(false); else window.appBridge.toast('请先绑定', 'err'); });
    $('#gh-btn-pull').addEventListener('click', () => { if (user) pull(true); else window.appBridge.toast('请先绑定', 'err'); });
  }

  window.ghSync = {
    onEnter: () => { if (on && user) pull(false); },
    onSave: markLocalChange,
    onLock: () => clearTimeout(pushTimer),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireUI);
  else wireUI();
})();
