const SESSION_KEY = 'moho-admin-session';
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const loginView = document.querySelector('#login-view');
const consoleView = document.querySelector('#console-view');
const loginForm = document.querySelector('#login-form');
const loginError = document.querySelector('#login-error');
const app = document.querySelector('#app');
const title = document.querySelector('#title');
const status = document.querySelector('#status');
const dialog = document.querySelector('#confirmation-dialog');
let token = sessionStorage.getItem(SESSION_KEY) || '';
let identity;
let legacyMode = false;

class ApiError extends Error {
  constructor(message, statusCode, body) { super(message); this.statusCode = statusCode; this.body = body; }
}

function clearSession(showLogin = true) {
  token = '';
  identity = undefined;
  sessionStorage.removeItem(SESSION_KEY);
  consoleView.hidden = true;
  if (showLogin) loginView.hidden = false;
}

async function request(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`/api${path}`, { ...options, headers });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (response.status === 401) {
    clearSession();
    loginError.textContent = '会话已失效，请重新登录。';
    loginError.hidden = false;
    throw new ApiError('会话已失效', 401, payload);
  }
  if (!response.ok) throw new ApiError(String(payload.error || payload.message || response.statusText), response.status, payload);
  return payload;
}

function body(value) { return JSON.stringify(value); }
function has(permission) { return Boolean(identity?.permissions?.includes(permission)); }
function valueOf(object, keys, fallback = '') {
  for (const key of keys) if (object?.[key] !== undefined) return object[key];
  return fallback;
}
function emptyState(titleText, detail) { return `<div class="empty"><strong>${esc(titleText)}</strong><span>${esc(detail)}</span></div>`; }
function unavailable(error) {
  if (error?.statusCode === 404) return emptyState('API 尚未启用', '前端已按计划契约接入，等待服务端启用此端点。');
  if (error?.statusCode === 403) return emptyState('权限不足', '当前账号没有读取此区域的权限。');
  throw error;
}

function askConfirmation(description) {
  document.querySelector('#confirmation-description').textContent = description;
  const input = document.querySelector('#confirmation-text');
  const submit = document.querySelector('#confirmation-submit');
  input.value = '';
  submit.disabled = true;
  input.oninput = () => { submit.disabled = input.value !== 'CONFIRM'; };
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' && input.value === 'CONFIRM'), { once: true }));
}

async function confirmedRequest(path, options, confirmation) {
  if (!await askConfirmation(confirmation.description)) throw new ApiError('操作已取消', 0, {});
  const issued = await request('/confirmations', { method: 'POST', body: body({ method: options.method || 'POST', path, body: confirmation.payload }) });
  const nonce = valueOf(issued.confirmation, ['nonce'], issued.nonce);
  if (!nonce) throw new ApiError('确认服务没有返回 nonce', 500, issued);
  return request(path, { ...options, headers: { ...(options.headers || {}), 'X-Admin-Confirmation': nonce } });
}

function setConnected(connected) {
  status.textContent = connected ? '已连接' : '连接异常';
  status.className = `pill ${connected ? 'success' : 'error'}`;
}

function showConsole(me) {
  identity = {
    principal: me.auth?.principal || me.principal || me.auth?.user || me.user || me.session?.principal || {},
    permissions: Array.isArray(me.permissions) ? me.permissions : [],
  };
  loginView.hidden = true;
  consoleView.hidden = false;
  document.querySelector('#account-name').textContent = identity.principal.username || identity.principal.id || '管理员';
  document.querySelector('#account-role').textContent = identity.principal.role || 'unknown';
  document.querySelectorAll('#navigation [data-permission]').forEach((button) => { button.hidden = !has(button.dataset.permission); });
  const first = [...document.querySelectorAll('#navigation button:not([hidden])')][0];
  if (first) activate(first);
}

async function authenticate() {
  if (!token) return clearSession();
  try { showConsole(await request('/auth/me')); setConnected(true); } catch (error) { if (error.statusCode !== 401) { clearSession(); loginError.textContent = error.message; loginError.hidden = false; } }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  const submit = loginForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    let result;
    if (legacyMode) {
      result = await fetch('/api/auth/session', { method: 'POST', headers: { 'x-admin-token': document.querySelector('#bootstrap-token').value, accept: 'application/json' } });
    } else {
      result = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body({ username: document.querySelector('#username').value, password: document.querySelector('#password').value }) });
    }
    const payload = await result.json().catch(() => ({}));
    if (!result.ok) throw new ApiError(String(payload.error || '登录失败'), result.status, payload);
    token = valueOf(payload, ['token', 'sessionToken', 'accessToken']);
    if (!token) throw new ApiError('登录响应没有 Session Token', 500, payload);
    sessionStorage.setItem(SESSION_KEY, token);
    loginForm.reset();
    await authenticate();
  } catch (error) {
    clearSession();
    loginError.textContent = error.message;
    loginError.hidden = false;
  } finally { submit.disabled = false; }
});

document.querySelector('#login-mode').addEventListener('click', () => {
  legacyMode = !legacyMode;
  document.querySelector('#account-fields').hidden = legacyMode;
  document.querySelector('#legacy-fields').hidden = !legacyMode;
  document.querySelector('#username').required = !legacyMode;
  document.querySelector('#password').required = !legacyMode;
  document.querySelector('#bootstrap-token').required = legacyMode;
  document.querySelector('#login-mode').textContent = legacyMode ? '返回账号密码登录' : '使用 Legacy Bootstrap';
  loginError.hidden = true;
});

document.querySelector('#logout').addEventListener('click', async () => {
  try { await request('/auth/logout', { method: 'POST' }); } catch (error) { if (error.statusCode !== 401) console.warn('logout failed', error); }
  clearSession();
});

async function overview() {
  const data = await request('/status');
  const bots = Array.isArray(data.bots) ? data.bots : [];
  app.innerHTML = `<div class="summary-grid">${bots.map((bot) => `<article class="card"><div class="card-heading"><h3>${esc(bot.name || bot.id || 'Bot')}</h3><span class="state ${bot.running ? 'online' : 'offline'}">${bot.running ? 'ONLINE' : 'OFFLINE'}</span></div><div class="metric">${esc(bot.sessions ?? 0)}</div><div class="muted">活跃会话 · ${esc(bot.adapter || '—')} · ${esc(bot.provider || '—')}</div></article>`).join('') || emptyState('暂无 Runtime', '没有可用的 Bot 快照。')}</div>`;
}

function userRows(users) {
  return users.map((user) => `<tr><td><strong>${esc(user.username || user.id)}</strong><small>${esc(user.id)}</small></td><td><select data-user-role="${esc(user.id)}"><option value="viewer" ${user.role === 'viewer' ? 'selected' : ''}>viewer</option><option value="operator" ${user.role === 'operator' ? 'selected' : ''}>operator</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>admin</option><option value="developer" ${user.role === 'developer' ? 'selected' : ''}>developer</option></select></td><td><label class="toggle"><input type="checkbox" data-user-enabled="${esc(user.id)}" ${user.enabled ? 'checked' : ''}><span>${user.enabled ? '启用' : '停用'}</span></label></td><td class="actions"><button data-save-user="${esc(user.id)}">保存</button><button data-password-user="${esc(user.id)}">改密码</button></td></tr>`).join('');
}

async function users() {
  try {
    const data = await request('/admin/users');
    const rows = Array.isArray(data.users) ? data.users : [];
    app.innerHTML = `<div class="section-bar"><div><h2>用户管理</h2><p class="muted">角色、状态和凭据变更需要二次确认。</p></div>${has('users.create') ? '<button class="primary" id="new-user">新建用户</button>' : ''}</div><div id="new-user-panel"></div><div class="table-wrap"><table><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${userRows(rows)}</tbody></table></div>`;
    document.querySelector('#new-user')?.addEventListener('click', () => {
      document.querySelector('#new-user-panel').innerHTML = `<form id="create-user" class="inline-form card"><div><label>用户名</label><input name="username" required autocomplete="off"></div><div><label>初始密码</label><input name="password" type="password" required autocomplete="new-password"></div><div><label>角色</label><select name="role"><option>viewer</option><option>operator</option><option>admin</option><option>developer</option></select></div><button class="primary" type="submit">创建</button></form>`;
      document.querySelector('#create-user').addEventListener('submit', async (event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget); const payload = { username: form.get('username'), password: form.get('password'), role: form.get('role'), enabled: true };
        await confirmedRequest('/admin/users', { method: 'POST', body: body(payload) }, { permission: 'users.create', action: 'users.create', payload, description: `创建用户 ${payload.username}` }); await users();
      });
    });
    document.querySelectorAll('[data-save-user]').forEach((button) => button.addEventListener('click', async () => {
      const id = button.dataset.saveUser; const role = document.querySelector(`[data-user-role="${CSS.escape(id)}"]`).value; const enabled = document.querySelector(`[data-user-enabled="${CSS.escape(id)}"]`).checked; const payload = { role, enabled };
      await confirmedRequest(`/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: body(payload) }, { permission: 'users.update', action: 'users.update', payload, description: `更新用户 ${id} 的角色或状态` }); await users();
    }));
    document.querySelectorAll('[data-password-user]').forEach((button) => button.addEventListener('click', async () => {
      const id = button.dataset.passwordUser; const password = prompt(`输入 ${id} 的新密码`); if (!password) return; const payload = { password };
      await confirmedRequest(`/admin/users/${encodeURIComponent(id)}/password`, { method: 'POST', body: body(payload) }, { permission: 'users.credentials.rotate', action: 'users.password.rotate', payload, description: `重置用户 ${id} 的密码` });
    }));
  } catch (error) { app.innerHTML = unavailable(error); }
}

function healthBlock(name, value) {
  const item = value && typeof value === 'object' ? value : {};
  const ok = item.ok === true || item.status === 'healthy';
  return `<article class="health-row"><span class="health-dot ${ok ? 'ok' : 'bad'}"></span><div><strong>${esc(name)}</strong><small>${esc(item.detail || item.message || item.status || (ok ? 'healthy' : 'unavailable'))}</small></div><span class="state ${ok ? 'online' : 'offline'}">${ok ? 'HEALTHY' : 'DEGRADED'}</span></article>`;
}

async function health() {
  const results = await Promise.allSettled([request('/admin/health'), request('/remote/health'), request('/models/health')]);
  const runtime = results[0].status === 'fulfilled' ? results[0].value.health : {};
  const remoteHealth = results[1].status === 'fulfilled' ? results[1].value.health || {} : {};
  const remote = remoteHealth.remote || remoteHealth.services || remoteHealth;
  const modelHealth = results[2].status === 'fulfilled' ? results[2].value.health || {} : {};
  const model = modelHealth.models || modelHealth;
  const blocks = [
    ['Runtime', runtime],
    ...Object.entries(remote || {}).map(([name, value]) => [`Remote · ${name}`, value]),
    ...Object.entries(model || {}).map(([name, value]) => [`Model · ${name}`, value]),
  ];
  app.innerHTML = `<div class="section-bar"><div><h2>服务健康</h2><p class="muted">Runtime、远程适配器和模型探测的最后结果。</p></div><button id="refresh-health">刷新</button></div><div class="health-list">${blocks.map(([name, value]) => healthBlock(name, value)).join('') || emptyState('暂无健康数据', '服务端健康端点尚未返回数据。')}</div>${results.some((result) => result.status === 'rejected' && result.reason?.statusCode === 404) ? '<div class="notice">部分计划 API 尚未启用，已展示当前可用数据。</div>' : ''}`;
  document.querySelector('#refresh-health').addEventListener('click', health);
}

async function models() {
  const data = await request('/models'); const catalog = data.catalog || {}; const models = Array.isArray(catalog.models) ? catalog.models : [];
  let modelHealth = {};
  try { const result = await request('/models/health'); modelHealth = valueOf(result, ['health', 'models'], {}); } catch (error) { if (error.statusCode !== 404) throw error; }
  app.innerHTML = `<div class="summary-grid"><article class="card"><h3>目录模型</h3><div class="metric">${esc(models.length)}</div><div class="muted">最后刷新 ${esc(catalog.fetchedAt || '—')}</div></article><article class="card"><h3>Free Endpoint</h3><div class="metric">${esc(catalog.freeEndpointCount ?? '—')}</div></article></div><div class="table-wrap"><table><thead><tr><th>模型</th><th>能力</th><th>健康</th></tr></thead><tbody>${models.map((model) => { const probe = modelHealth[model.id] || {}; const ok = probe.ok === true; return `<tr><td><strong>${esc(model.id)}</strong><small>${esc(model.description)}</small></td><td>${(model.capabilities || []).map((capability) => `<span class="tag">${esc(capability)}</span>`).join('')}</td><td><span class="state ${ok ? 'online' : 'offline'}">${esc(probe.status || (ok ? 'HEALTHY' : 'UNKNOWN'))}</span></td></tr>`; }).join('')}</tbody></table></div>`;
}

async function providers(){const rows=(await request('/providers')).providers||[];app.innerHTML=`<div class="section-head"><div><h2>供应商与任务路由</h2><p class="muted">密钥与 Base URL 永不回显。配置变更请走版本化配置发布。</p></div></div><div class="table-wrap"><table><thead><tr><th>Bot</th><th>Provider</th><th>模型</th><th>密钥</th><th>Task Routes</th><th>操作</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.botId)}</td><td>${esc(x.provider)}</td><td>${esc(x.model)}</td><td>${x.apiKeyConfigured?'已配置':'未配置'}</td><td><code>${esc(JSON.stringify(x.taskRoutes||{}))}</code></td><td><button data-probe-provider="${esc(x.botId)}" ${has('providers.probe')?'':'disabled'}>连接探测</button></td></tr>`).join('')}</tbody></table></div><section id="provider-result"></section>`;app.querySelectorAll('[data-probe-provider]').forEach(b=>b.onclick=async()=>{const probe=await request(`/providers/${encodeURIComponent(b.dataset.probeProvider)}/probe`,{method:'POST',body:body({})});document.querySelector('#provider-result').innerHTML=`<div class="notice ${probe.probe.ok?'success':'error'}">${esc(probe.probe.botId)}：${probe.probe.ok?'连接正常':probe.probe.detail||'不可用'}</div>`;});}

async function config() {
  try {
    const data = await request('/config/publication');
    const publication = data.publication || {};
    const snapshot = publication.snapshot || publication;
    const active = snapshot.active || publication.active || {};
    const state = snapshot.state || {};
    const revision = state.desiredRevision || active.revision || 0;
    app.innerHTML = `<div class="summary-grid"><article class="card"><h3>Active Revision</h3><div class="metric">${esc(state.activeRevision ?? active.revision ?? 0)}</div><div class="muted">${esc(state.phase || 'empty')} · state ${esc(state.stateVersion ?? 0)}</div></article><article class="card"><h3>发布者</h3><div class="metric compact">${esc(active.publishedBy || '—')}</div></article></div><form id="publish-config" class="card config-form"><h3>发布配置</h3><p class="muted">默认即时激活；多节点 rollout 可由 API 指定 quorum/targets。</p><label>Expected Revision</label><input name="expectedRevision" type="number" min="0" step="1" value="${esc(revision)}" required><label>配置 JSON</label><textarea name="config" rows="14" spellcheck="false" required>${esc(JSON.stringify(active.payload || {}, null, 2))}</textarea><button class="danger" type="submit">发布配置</button>${state.previousActiveRevision ? '<button id="rollback-config" type="button">回滚上一 Active</button>' : ''}</form>`;
    document.querySelector('#publish-config').addEventListener('submit', async (event) => {event.preventDefault();const form=new FormData(event.currentTarget);let value;try{value=JSON.parse(String(form.get('config')))}catch{throw new ApiError('配置必须是有效 JSON',0,{})}const payload={expectedRevision:Number(form.get('expectedRevision')),expectedStateVersion:state.stateVersion,payload:value,payloadSchemaVersion:1};await confirmedRequest('/config/publish',{method:'POST',body:body(payload)},{payload,description:`发布配置 revision ${payload.expectedRevision}`});await config();});
    document.querySelector('#rollback-config')?.addEventListener('click',async()=>{const payload={expectedStateVersion:state.stateVersion};await confirmedRequest('/config/rollback',{method:'POST',body:body(payload)},{payload,description:'回滚到上一 Active 配置'});await config();});
  } catch (error) { app.innerHTML = unavailable(error); }
}

async function characters() {
  const data = await request('/characters'); const rows = Array.isArray(data.characters) ? data.characters : [];
  app.innerHTML = `<div class="summary-grid">${rows.map((character) => `<article class="card"><h3>${esc(character.name)}</h3><div class="muted">${esc(character.id)} · ${esc(character.promptLength)} chars</div></article>`).join('') || emptyState('暂无角色', '角色目录为空。')}</div>`;
}

async function world() {
  const [state, dayPlan] = await Promise.all([request('/world'), request('/world/day-plan')]); const worldState = state.world || {}; const plan = dayPlan.plan || {};
  app.innerHTML = `<div class="summary-grid"><article class="card"><h3>位置</h3><div class="metric compact">${esc(worldState.location || '—')}</div></article><article class="card"><h3>活动</h3><div class="metric compact">${esc(worldState.activity || '—')}</div></article><article class="card"><h3>天气</h3><div class="metric compact">${esc(worldState.weather || '—')}</div></article></div><div class="timeline">${(plan.items || []).map((item) => `<div class="timeline-item"><time>${esc(item.at)}</time><div><strong>${esc(item.activity)}</strong><span>${esc(item.location)} · ${esc(item.reason)}</span></div></div>`).join('') || emptyState('暂无计划', '今日计划为空。')}</div>`;
}

async function metrics() {
  const data = await request('/metrics'); const metricsData = data.metrics || {};
  app.innerHTML = `<div class="summary-grid">${['ai', 'embedding', 'rerank', 'outbox'].map((key) => { const metric = metricsData[key] || {}; return `<article class="card"><h3>${esc(key.toUpperCase())}</h3><div class="metric">${esc(metric.p95Ms ?? 0)}ms</div><div class="muted">P50 ${esc(metric.p50Ms ?? 0)}ms · 请求 ${esc(metric.count ?? 0)} · 失败 ${esc(metric.failures ?? 0)}</div></article>`; }).join('')}</div>`;
}

async function bots(){const data=await request('/bots');const rows=data.bots||[];app.innerHTML=`<div class="section-head"><div><h2>Bot 与平台</h2><p class="muted">Gateway 状态、会话与受控重启。</p></div></div><div class="table-wrap"><table><thead><tr><th>Bot</th><th>Adapter</th><th>Gateway</th><th>延迟</th><th>重连</th><th>操作</th></tr></thead><tbody>${rows.map(b=>`<tr><td><strong>${esc(b.name||b.id)}</strong><br><span class="muted">${esc(b.id)}</span></td><td>${esc(b.adapter)}</td><td>${b.gateway?.connected?'已连接':'离线'}</td><td>${esc(b.gateway?.ping??'-')} ms</td><td>${esc(b.gateway?.reconnects??0)}</td><td><button data-restart="${esc(b.id)}" ${has('runtime.restart')?'':'disabled'}>重启</button></td></tr>`).join('')}</tbody></table></div>`;app.querySelectorAll('[data-restart]').forEach(btn=>btn.onclick=async()=>{const id=btn.dataset.restart,payload={};await confirmedRequest(`/bots/${encodeURIComponent(id)}/restart`,{method:'POST',body:body(payload)},{payload,description:`重启 Bot ${id}`});await bots();});}
async function plugins(){const botsData=(await request('/bots')).bots||[];const groups=await Promise.all(botsData.map(async b=>({bot:b,plugins:(await request(`/bots/${encodeURIComponent(b.id)}/plugins`)).plugins||[]})));app.innerHTML=`<div class="section-head"><div><h2>已安装插件</h2><p class="muted">失败重载不会替换当前健康实例。</p></div></div>${groups.map(g=>`<section class="tool-section"><h3>${esc(g.bot.name||g.bot.id)}</h3><div class="table-wrap"><table><thead><tr><th>插件</th><th>状态</th><th>错误</th><th>操作</th></tr></thead><tbody>${g.plugins.map(p=>`<tr><td>${esc(p.id)}</td><td>${esc(p.state)}</td><td>${esc(p.errors)}</td><td><button data-reload="${esc(g.bot.id)}:${esc(p.id)}" ${has('plugin.reload')?'':'disabled'}>重载</button></td></tr>`).join('')||'<tr><td colspan="4">暂无插件</td></tr>'}</tbody></table></div></section>`).join('')}`;app.querySelectorAll('[data-reload]').forEach(btn=>btn.onclick=async()=>{const[botId,pluginId]=btn.dataset.reload.split(':');const payload={};await confirmedRequest(`/bots/${encodeURIComponent(botId)}/plugins/${encodeURIComponent(pluginId)}/reload`,{method:'POST',body:body(payload)},{payload,description:`重载插件 ${pluginId}`});await plugins();});}
async function operations(){const[sessions,outbox,tasks,audit]=await Promise.all([request('/ops/sessions?limit=30'),request('/ops/outbox?limit=30'),request('/tasks?limit=30'),has('audit.read')?request('/admin/audit?limit=30'):Promise.resolve({audit:{items:[]}})]);const ss=sessions.sessions?.items||[],oo=outbox.outbox?.items||[],tt=tasks.tasks?.items||[],aa=audit.audit?.items||[];app.innerHTML=`<div class="tabs-strip"><button data-view="sessions">会话 ${ss.length}</button><button data-view="outbox">Outbox ${oo.length}</button><button data-view="tasks">任务 ${tt.length}</button><button data-view="audit">审计 ${aa.length}</button></div><section id="ops-view"></section>`;const views={sessions:`<div class="table-wrap"><table><thead><tr><th>Bot/频道</th><th>消息</th><th>长度</th><th>更新时间</th></tr></thead><tbody>${ss.map(x=>`<tr><td>${esc(x.botId)} / ${esc(x.channelId)}</td><td>${esc(x.messageCount)}</td><td>${esc(x.contentLength)}</td><td>${esc(new Date(x.updatedAt).toLocaleString())}</td></tr>`).join('')}</tbody></table></div>`,outbox:`<div class="table-wrap"><table><thead><tr><th>ID</th><th>类型</th><th>状态</th><th>尝试</th><th>Payload</th></tr></thead><tbody>${oo.map(x=>`<tr><td>${esc(x.eventId)}</td><td>${esc(x.type)}</td><td>${esc(x.status)}</td><td>${esc(x.attempts)}</td><td>${esc(x.payloadBytes)} B</td></tr>`).join('')}</tbody></table></div>`,tasks:`<div class="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>错误</th></tr></thead><tbody>${tt.map(x=>`<tr><td>${esc(x.name||x.id)}</td><td>${esc(x.status)}</td><td>${esc(x.errorCount??0)}</td></tr>`).join('')}</tbody></table></div>`,audit:`<div class="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>结果</th></tr></thead><tbody>${aa.map(x=>`<tr><td>${esc(x.at)}</td><td>${esc(x.actor)}</td><td>${esc(x.action)}</td><td>${esc(x.outcome)}</td></tr>`).join('')}</tbody></table></div>`};const render=v=>document.querySelector('#ops-view').innerHTML=views[v];app.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>render(b.dataset.view));render('sessions');}
async function logs(){const data=await request('/logs?limit=200');const rows=data.logs?.items||data.items||[];app.innerHTML=`<div class="section-head"><div><h2>结构化日志</h2><p class="muted">有界脱敏缓冲；不包含消息正文、Prompt 或凭据。</p></div><button id="refresh-logs">刷新</button></div>${data.gap?'<div class="notice warn">较早日志已被环形缓冲覆盖。</div>':''}<div class="log-view">${rows.map(x=>`<div class="log-line level-${esc(x.level)}"><time>${esc(new Date(x.time).toLocaleTimeString())}</time><span>${esc(x.level)}</span><strong>${esc(x.component||'runtime')}</strong><code>${esc(x.message)}</code></div>`).join('')||emptyState('暂无日志','Runtime 尚未产生可展示的结构化日志。')}</div>`;document.querySelector('#refresh-logs').onclick=logs;}
async function memory(){const rows=(await request('/memory?limit=100')).memories||[];app.innerHTML=`<div class="section-head"><div><h2>长期记忆</h2><p class="muted">默认仅展示元数据和摘要，正文按权限单独读取。</p></div></div><div class="table-wrap"><table><thead><tr><th>Bot/用户</th><th>Scope</th><th>频道</th><th>长度</th><th>摘要</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.botId)} / ${esc(x.userId)}</td><td>${esc(x.scope)}</td><td>${esc(x.channelId)}</td><td>${esc(x.textLength)}</td><td><code>${esc(String(x.sha256||'').slice(0,12))}</code></td></tr>`).join('')}</tbody></table></div>`;}
async function behavior(){app.innerHTML=`<form id="behavior-form" class="tool-section"><h2>行为 Dry Run</h2><p class="muted">只执行本地规则，不调用模型、不写状态。</p><div class="form-grid"><label>Bot ID<input name="botId" value="main" required></label><label>User ID<input name="userId" value="debug-user" required></label><label>Channel ID<input name="channelId" value="dm:debug-user" required></label><label><input name="dm" type="checkbox" checked> 私聊</label></div><label>消息<textarea name="content" rows="4" required>你好</textarea></label><button type="submit">评估</button></form><section id="behavior-result"></section>`;app.querySelector('#behavior-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),payload={botId:String(f.get('botId')),userId:String(f.get('userId')),channelId:String(f.get('channelId')),dm:f.get('dm')==='on',content:String(f.get('content')),mentionsBot:false,recentReplies:0};const result=await request('/behavior/dry-run',{method:'POST',body:body(payload)});document.querySelector('#behavior-result').innerHTML=`<pre>${esc(JSON.stringify(result.result,null,2))}</pre>`;};}
const tabs = { overview,bots,plugins,operations,logs,memory,behavior, users, health, models,providers, config, characters, world, metrics };
async function activate(button) {
  if (!button || button.hidden) return;
  document.querySelectorAll('#navigation button').forEach((item) => item.classList.toggle('active', item === button));
  title.textContent = button.textContent;
  app.innerHTML = '<div class="loading">正在加载…</div>';
  try { await tabs[button.dataset.tab](); setConnected(true); } catch (error) { if (error.statusCode !== 401) { setConnected(false); app.innerHTML = `<div class="notice error">${esc(error.message)}</div>`; } }
}
document.querySelectorAll('#navigation button').forEach((button) => button.addEventListener('click', () => activate(button)));

await authenticate();
