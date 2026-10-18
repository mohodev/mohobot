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
  input.oninput = () => { submit.disabled = input.value !== '确认'; };
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' && input.value === '确认'), { once: true }));
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
  document.querySelector('#account-role').textContent = identity.principal.role || '未知';
  document.querySelectorAll('#navigation [data-permission]').forEach((button) => { button.hidden = !has(button.dataset.permission); });
  const requested=location.hash.replace(/^#\/?/,'');
  const first=[...document.querySelectorAll('#navigation button:not([hidden])')].find(button=>button.dataset.tab===requested)||[...document.querySelectorAll('#navigation button:not([hidden])')][0];
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
  document.querySelector('#login-mode').textContent = legacyMode ? '返回账号密码登录' : '使用本地初始化令牌';
  loginError.hidden = true;
});

document.querySelector('#logout').addEventListener('click', async () => {
  try { await request('/auth/logout', { method: 'POST' }); } catch (error) { if (error.statusCode !== 401) console.warn('logout failed', error); }
  clearSession();
});

async function overview() {
  const data = await request('/status');
  const bots = Array.isArray(data.bots) ? data.bots : [];
  app.innerHTML = `<div class="summary-grid">${bots.map((bot) => `<article class="card"><div class="card-heading"><h3>${esc(bot.name || bot.id || '机器人')}</h3><span class="state ${bot.running ? 'online' : 'offline'}">${bot.running ? '运行中' : '已停止'}</span></div><div class="metric">${esc(bot.sessions ?? 0)}</div><div class="muted">活跃会话 · ${esc(bot.adapter || '—')} · ${esc(bot.provider || '—')}</div></article>`).join('') || emptyState('暂无运行时', '没有可用的机器人快照。')}</div>`;
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

async function tokens(){const data=await request('/auth/temporary-tokens'),rows=data.tokens||[];const rank={viewer:0,operator:1,admin:2,developer:3},current=identity.principal.role||'viewer',roles=['viewer','operator','admin','developer'].filter(role=>(rank[role]??0)<=(rank[current]??0));app.innerHTML=`<div class="section-bar"><div><h2>临时访问令牌</h2><p class="muted">仅创建时显示一次；可直接作为 Bearer 凭据使用，过期或撤销后立即失效。</p></div>${has('tokens.create')?'<button class="primary" id="create-token">创建临时令牌</button>':''}</div><section id="token-create"></section><div class="table-wrap"><table><thead><tr><th>标签</th><th>角色</th><th>创建者</th><th>有效期至</th><th>最近使用</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.label)}</td><td>${esc(x.role)}</td><td>${esc(x.createdBy)}</td><td>${esc(new Date(x.expiresAt).toLocaleString())}</td><td>${x.lastUsedAt?esc(new Date(x.lastUsedAt).toLocaleString()):'从未使用'}</td><td>${x.revokedAt?'已撤销':'有效'}</td><td>${!x.revokedAt&&has('tokens.revoke')?`<button data-revoke-token="${esc(x.id)}">撤销</button>`:'—'}</td></tr>`).join('')||'<tr><td colspan="7">暂无临时令牌</td></tr>'}</tbody></table></div>`;document.querySelector('#create-token')?.addEventListener('click',()=>{document.querySelector('#token-create').innerHTML=`<form id="temp-token-form" class="tool-section"><h3>创建临时令牌</h3><div class="form-grid"><label>标签<input name="label" maxlength="128" required placeholder="例如：部署验收"></label><label>角色<select name="role">${roles.map(role=>`<option value="${role}">${role}</option>`).join('')}</select></label><label>有效分钟数<input name="ttlMinutes" type="number" min="1" max="10080" value="60" required></label></div><button class="danger">创建并显示一次</button></form>`;document.querySelector('#temp-token-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),payload={label:String(f.get('label')),role:String(f.get('role')),ttlMinutes:Number(f.get('ttlMinutes'))};const result=await confirmedRequest('/auth/temporary-tokens',{method:'POST',body:body(payload)},{payload,description:`创建 ${payload.ttlMinutes} 分钟的临时令牌`});document.querySelector('#token-create').innerHTML=`<section class="notice success"><strong>请立即复制令牌；关闭或刷新后无法再次查看。</strong><textarea readonly rows="3" aria-label="临时令牌">${esc(result.token)}</textarea><button id="copy-token">复制令牌</button></section>`;document.querySelector('#copy-token').onclick=async()=>{await navigator.clipboard?.writeText(result.token);document.querySelector('#copy-token').textContent='已复制';};};});app.querySelectorAll('[data-revoke-token]').forEach(b=>b.onclick=async()=>{const id=b.dataset.revokeToken,payload={};await confirmedRequest(`/auth/temporary-tokens/${encodeURIComponent(id)}`,{method:'DELETE',body:body(payload)},{payload,description:'撤销此临时令牌'});await tokens();});}

function healthBlock(name, value) {
  const item = value && typeof value === 'object' ? value : {};
  const ok = item.ok === true || item.status === 'healthy';
  return `<article class="health-row"><span class="health-dot ${ok ? 'ok' : 'bad'}"></span><div><strong>${esc(name)}</strong><small>${esc(item.detail || item.message || item.status || (ok ? '正常' : '不可用'))}</small></div><span class="state ${ok ? 'online' : 'offline'}">${ok ? '正常' : '降级'}</span></article>`;
}

async function health() {
  const results = await Promise.allSettled([request('/admin/health'), request('/models/health')]);
  const runtime = results[0].status === 'fulfilled' ? results[0].value.health : {};
  const modelHealth = results[1].status === 'fulfilled' ? results[1].value.health || {} : {};
  const model = modelHealth.models || modelHealth;
  const blocks = [
    ['运行时', runtime],
    ...Object.entries(model || {}).map(([name, value]) => [`模型 · ${name}`, value]),
  ];
  app.innerHTML = `<div class="section-bar"><div><h2>服务健康</h2><p class="muted">运行时和模型探测的最近结果。</p></div><button id="refresh-health">刷新</button></div><div class="health-list">${blocks.map(([name, value]) => healthBlock(name, value)).join('') || emptyState('暂无健康数据', '服务端健康端点尚未返回数据。')}</div>${results.some((result) => result.status === 'rejected' && result.reason?.statusCode === 404) ? '<div class="notice">部分计划 API 尚未启用，已展示当前可用数据。</div>' : ''}`;
  document.querySelector('#refresh-health').addEventListener('click', health);
}

async function models() {
  const data = await request('/models'); const catalog = data.catalog || {}; const models = Array.isArray(catalog.models) ? catalog.models : [];
  let modelHealth = {};
  try { const result = await request('/models/health'); modelHealth = valueOf(result, ['health', 'models'], {}); } catch (error) { if (error.statusCode !== 404) throw error; }
  app.innerHTML = `<div class="summary-grid"><article class="card"><h3>目录模型</h3><div class="metric">${esc(models.length)}</div><div class="muted">最后刷新 ${esc(catalog.fetchedAt || '—')}</div></article><article class="card"><h3>免费端点</h3><div class="metric">${esc(catalog.freeEndpointCount ?? '—')}</div></article></div><div class="table-wrap"><table><thead><tr><th>模型</th><th>能力</th><th>健康</th></tr></thead><tbody>${models.map((model) => { const probe = modelHealth[model.id] || {}; const ok = probe.ok === true; return `<tr><td><strong>${esc(model.id)}</strong><small>${esc(model.description)}</small></td><td>${(model.capabilities || []).map((capability) => `<span class="tag">${esc(capability)}</span>`).join('')}</td><td><span class="state ${ok ? 'online' : 'offline'}">${esc(probe.status || (ok ? '正常' : '未知'))}</span></td></tr>`; }).join('')}</tbody></table></div>`;
}

async function modelops() {
  try {
    const result = await request('/models/dashboard');
    const dashboard = result.dashboard || {};
    const bots = Array.isArray(dashboard.bots) ? dashboard.bots : [];
    const providers = Array.isArray(dashboard.providers) ? dashboard.providers : [];
    const events = Array.isArray(dashboard.events) ? dashboard.events : [];
    app.innerHTML = `<div class="summary-grid"><article class="card"><h3>运行机器人</h3><div class="metric">${esc(dashboard.totals?.running ?? 0)} <small>/ ${esc(dashboard.totals?.bots ?? 0)}</small></div></article><article class="card"><h3>可用模型</h3><div class="metric">${esc(dashboard.totals?.availableModels ?? 0)} <small>/ ${esc(dashboard.totals?.models ?? 0)}</small></div></article></div><div class="section-head"><div><h2>Bot 模型状态</h2><p class="muted">健康、会话与当前 provider 的只读汇总。</p></div><button id="refresh-modelops">刷新</button></div><div class="table-wrap"><table><thead><tr><th>Bot</th><th>Provider / 模型</th><th>会话</th><th>状态</th></tr></thead><tbody>${bots.map((bot) => `<tr><td><strong>${esc(bot.botName || bot.botId)}</strong><small>${esc(bot.botId)}</small></td><td>${esc(bot.provider)} / ${esc(bot.model)}</td><td>${esc(bot.sessions ?? 0)}</td><td><span class="state ${bot.running ? 'online' : 'offline'}">${bot.running ? '运行中' : '已停止'}</span></td></tr>`).join('') || '<tr><td colspan="4">暂无 Bot 数据</td></tr>'}</tbody></table></div><div class="section-head"><div><h2>Provider 健康</h2></div></div><div class="table-wrap"><table><thead><tr><th>Provider</th><th>模型数</th><th>可用</th><th>平均延迟</th></tr></thead><tbody>${providers.map((provider) => `<tr><td><strong>${esc(provider.provider)}</strong></td><td>${esc(provider.modelCount)}</td><td>${esc(provider.availableCount)}</td><td>${esc(provider.avgLatencyMs == null ? '—' : `${provider.avgLatencyMs} ms`)}</td></tr>`).join('') || '<tr><td colspan="4">暂无 Provider 数据</td></tr>'}</tbody></table></div><div class="section-head"><div><h2>最近路由事件</h2></div></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>模型</th><th>详情</th></tr></thead><tbody>${events.map((event) => `<tr><td>${esc(event.at ? new Date(event.at).toLocaleString() : '—')}</td><td>${esc(event.kind)}</td><td>${esc(event.model || '—')}</td><td>${esc(event.detail)}</td></tr>`).join('') || '<tr><td colspan="4">暂无 fallback 或熔断事件</td></tr>'}</tbody></table></div>`;
    document.querySelector('#refresh-modelops').addEventListener('click', modelops);
  } catch (error) { app.innerHTML = unavailable(error); }
}

async function providers(){const rows=(await request('/providers')).providers||[];app.innerHTML=`<div class="section-head"><div><h2>供应商与任务路由</h2><p class="muted">密钥与服务地址永不回显。配置变更请走版本化配置发布。</p></div></div><div class="table-wrap"><table><thead><tr><th>机器人</th><th>供应商</th><th>模型</th><th>密钥</th><th>任务路由</th><th>操作</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.botId)}</td><td>${esc(x.provider)}</td><td>${esc(x.model)}</td><td>${x.apiKeyConfigured?'已配置':'未配置'}</td><td><code>${esc(JSON.stringify(x.taskRoutes||{}))}</code></td><td><button data-probe-provider="${esc(x.botId)}" ${has('providers.probe')?'':'disabled'}>连接探测</button></td></tr>`).join('')}</tbody></table></div><section id="provider-result"></section>`;app.querySelectorAll('[data-probe-provider]').forEach(b=>b.onclick=async()=>{const probe=await request(`/providers/${encodeURIComponent(b.dataset.probeProvider)}/probe`,{method:'POST',body:body({})});document.querySelector('#provider-result').innerHTML=`<div class="notice ${probe.probe.ok?'success':'error'}">${esc(probe.probe.botId)}：${probe.probe.ok?'连接正常':probe.probe.detail||'不可用'}</div>`;});}

async function config() {
  try {
    const data = await request('/config/publication');
    const publication = data.publication || {};
    const snapshot = publication.snapshot || publication;
    const active = snapshot.active || publication.active || {};
    const state = snapshot.state || {};
    const revision = state.desiredRevision || active.revision || 0;
    app.innerHTML = `<div class="summary-grid"><article class="card"><h3>当前版本</h3><div class="metric">${esc(state.activeRevision ?? active.revision ?? 0)}</div><div class="muted">${esc(state.phase || '空')} · 状态版本 ${esc(state.stateVersion ?? 0)}</div></article><article class="card"><h3>发布者</h3><div class="metric compact">${esc(active.publishedBy || '—')}</div></article></div><form id="publish-config" class="card config-form"><h3>发布配置</h3><p class="muted">默认即时激活；多节点分批发布可由接口指定确认数量和目标节点。</p><label>预期版本</label><input name="expectedRevision" type="number" min="0" step="1" value="${esc(revision)}" required><label>配置 JSON</label><textarea name="config" rows="14" spellcheck="false" required>${esc(JSON.stringify(active.payload || {}, null, 2))}</textarea><button class="danger" type="submit">发布配置</button>${state.previousActiveRevision ? '<button id="rollback-config" type="button">回滚上一 Active</button>' : ''}</form>`;
    document.querySelector('#publish-config').addEventListener('submit', async (event) => {event.preventDefault();const form=new FormData(event.currentTarget);let value;try{value=JSON.parse(String(form.get('config')))}catch{throw new ApiError('配置必须是有效 JSON',0,{})}const payload={expectedRevision:Number(form.get('expectedRevision')),expectedStateVersion:state.stateVersion,payload:value,payloadSchemaVersion:1};await confirmedRequest('/config/publish',{method:'POST',body:body(payload)},{payload,description:`发布配置 版本 ${payload.expectedRevision}`});await config();});
    document.querySelector('#rollback-config')?.addEventListener('click',async()=>{const payload={expectedStateVersion:state.stateVersion};await confirmedRequest('/config/rollback',{method:'POST',body:body(payload)},{payload,description:'回滚到上一生效配置'});await config();});
  } catch (error) { app.innerHTML = unavailable(error); }
}

function crossChatStopReason(reason) {
  return { max_turns: '达到最大轮数', repetition: '检测到重复', error: '出错中断', completed: '正常结束' }[reason] || reason || '未知';
}

function characterImportReport(report) {
  const imported = Array.isArray(report.imported) ? report.imported : [];
  const skipped = Array.isArray(report.skipped) ? report.skipped : [];
  const failed = Array.isArray(report.failed) ? report.failed : [];
  const rows = [
    ...imported.map((item) => `<tr><td>${esc(item.id)}</td><td>${esc(item.name)}</td><td>${item.revision ? '已写入' : '预演通过'}</td></tr>`),
    ...skipped.map((item) => `<tr><td>#${esc(item.index)}</td><td>${esc(item.name || '—')}</td><td>跳过：${esc(item.reason)}</td></tr>`),
    ...failed.map((item) => `<tr><td>#${esc(item.index)}</td><td>${esc(item.name || '—')}</td><td>失败：${esc(item.error)}</td></tr>`),
  ];
  return `<section class="tool-section"><h3>导入结果</h3><div class="summary-grid"><article class="card"><h3>总计</h3><div class="metric">${esc(report.total ?? rows.length)}</div></article><article class="card"><h3>成功</h3><div class="metric">${esc(imported.length)}</div></article><article class="card"><h3>跳过</h3><div class="metric">${esc(skipped.length)}</div></article><article class="card"><h3>失败</h3><div class="metric">${esc(failed.length)}</div></article></div><div class="table-wrap"><table><thead><tr><th>条目</th><th>名称</th><th>结果</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="3">没有条目</td></tr>'}</tbody></table></div></section>`;
}

async function characters() {
  const data = await request('/characters'), rows = Array.isArray(data.characters) ? data.characters : [];
  app.innerHTML = `<div class="section-head"><div><h2>角色目录</h2><p class="muted">提示词更新使用版本号防止并发覆盖。</p></div><div class="tabs-strip">${has('characters.write') ? '<button id="character-create">新建角色</button>' : ''}${has('characters.import') ? '<button id="character-import">批量导入</button>' : ''}${has('characters.crosschat') ? '<button id="character-crosschat">角色互聊</button>' : ''}</div></div><section id="character-panel"></section><div class="summary-grid">${rows.map((c) => `<article class="card"><h3>${esc(c.name)}</h3><div class="muted">${esc(c.id)} · ${esc(c.promptLength)} 字符</div><button data-character="${esc(c.id)}">查看 / 编辑</button></article>`).join('') || emptyState('暂无角色', '角色目录为空。')}</div><section id="character-editor"></section>`;
  app.querySelectorAll('[data-character]').forEach((b) => b.onclick = async () => {
    const c = (await request(`/characters/${encodeURIComponent(b.dataset.character)}`)).character;
    document.querySelector('#character-editor').innerHTML = `<form id="character-form" class="tool-section"><h3>${esc(c.name)}</h3><label>名称<input name="name" value="${esc(c.name)}"></label><label>提示词<textarea name="prompt" rows="14">${esc(c.prompt)}</textarea></label><button type="submit" ${has('characters.write') ? '' : 'disabled'}>保存新版本</button></form>`;
    document.querySelector('#character-form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget), payload = { name: String(f.get('name')), prompt: String(f.get('prompt')), expectedRevision: c.revision }; await confirmedRequest(`/characters/${encodeURIComponent(c.id)}`, { method: 'PUT', body: body(payload) }, { payload, description: `更新角色 ${c.name}` }); await characters(); };
  });
  document.querySelector('#character-create')?.addEventListener('click', () => {
    document.querySelector('#character-panel').innerHTML = `<form id="character-create-form" class="tool-section"><h3>新建角色</h3><label>名称<input name="name" required maxlength="100"></label><label>提示词<textarea name="prompt" rows="14" required></textarea></label><button type="submit">创建角色</button></form>`;
    document.querySelector('#character-create-form').onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const payload = { name: String(form.get('name')).trim(), prompt: String(form.get('prompt')) };
      await confirmedRequest('/characters', { method: 'POST', body: body(payload) }, { permission: 'characters.write', action: 'characters.create', payload, description: `创建角色 ${payload.name}` });
      await characters();
    };
  });
  document.querySelector('#character-import')?.addEventListener('click', () => {
    document.querySelector('#character-panel').innerHTML = `<form id="character-import-form" class="tool-section"><h3>批量导入角色</h3><p class="muted">粘贴 JSON 数组，每项形如 { "name", "prompt", "id?", "source?" }。预演只做校验，不写入磁盘。</p><label>角色 JSON<textarea name="items" rows="12" spellcheck="false" placeholder='[{"name":"新角色","prompt":"一段不少于 20 字的提示词"}]'></textarea></label><div class="form-grid"><label><input name="dryRun" type="checkbox" checked> 预演 (dryRun)</label><label>冲突处理<select name="onConflict"><option value="skip">跳过已有（skip）</option><option value="overwrite">覆盖已有（overwrite）</option></select></label></div><div id="character-import-error" class="notice error" hidden></div><button type="submit">导入</button></form><section id="character-import-result"></section>`;
    document.querySelector('#character-import-form').onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const errorBox = document.querySelector('#character-import-error');
      let items;
      try { items = JSON.parse(String(form.get('items') || '')); } catch { errorBox.textContent = 'JSON 解析失败：请检查括号、引号与逗号。'; errorBox.hidden = false; return; }
      if (!Array.isArray(items)) { errorBox.textContent = '内容必须是 JSON 数组（以 [ 开头、以 ] 结尾）。'; errorBox.hidden = false; return; }
      errorBox.hidden = true;
      const payload = { items, dryRun: form.get('dryRun') === 'on', onConflict: String(form.get('onConflict')) };
      const response = await confirmedRequest('/characters/import', { method: 'POST', body: body(payload) }, { permission: 'characters.import', action: 'characters.import', payload, description: `批量导入角色（${items.length} 项 · ${payload.dryRun ? '预演' : '写入'}）` });
      document.querySelector('#character-import-result').innerHTML = characterImportReport(response.report || {});
    };
  });
  document.querySelector('#character-crosschat')?.addEventListener('click', () => {
    document.querySelector('#character-panel').innerHTML = `<form id="character-cross-chat-form" class="tool-section"><h3>角色互聊</h3><p class="muted">至少选择 2 个角色。对话在离线沙箱中生成，不会访问 Discord 或真实会话。</p><label>参与角色</label><div class="form-grid">${rows.map((c) => `<label><input type="checkbox" name="characterIds" value="${esc(c.id)}"> ${esc(c.name)}</label>`).join('') || '<span class="muted">没有可选角色</span>'}</div><label>话题<input name="topic" maxlength="500" required placeholder="例如：雨天的街角咖啡店"></label><label>起始角色<select name="startWith"><option value="">自动（按选择顺序）</option>${rows.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><div id="character-cross-chat-error" class="notice error" hidden></div><button type="submit">开始互聊</button></form><section id="character-cross-chat-result"></section>`;
    document.querySelector('#character-cross-chat-form').onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const errorBox = document.querySelector('#character-cross-chat-error');
      const characterIds = form.getAll('characterIds').map(String);
      if (characterIds.length < 2) { errorBox.textContent = '请至少选择 2 个角色。'; errorBox.hidden = false; return; }
      const topic = String(form.get('topic') || '').trim();
      if (!topic) { errorBox.textContent = '请填写话题。'; errorBox.hidden = false; return; }
      errorBox.hidden = true;
      const startWith = String(form.get('startWith') || '');
      const payload = { characterIds, topic, ...(startWith ? { startWith } : {}) };
      try {
        // cross-chat is a reversible, non-confirmable route (route-policy: confirmation:false), so call it directly.
        const response = await request('/characters/cross-chat', { method: 'POST', body: body(payload) });
        const transcript = response.result || {};
        const turns = Array.isArray(transcript.turns) ? transcript.turns : [];
        document.querySelector('#character-cross-chat-result').innerHTML = `<section class="tool-section"><h3>对话记录</h3>${transcript.error ? `<div class="notice error">${esc(transcript.error)}</div>` : ''}<div class="timeline">${turns.map((turn) => `<div class="timeline-item"><time>${esc(turn.speakerName || turn.speakerId || '角色')}</time><div><span>${esc(turn.content)}</span></div></div>`).join('') || emptyState('没有对话内容', '模型没有返回任何回合。')}</div><p class="muted">停止原因：${esc(crossChatStopReason(transcript.stopReason))} · 用时 ${esc(transcript.totalMs ?? 0)} ms</p></section>`;
      } catch (error) {
        errorBox.textContent = error.statusCode === 409 ? '角色互聊服务未启用（缺少模型配置）。' : error.message;
        errorBox.hidden = false;
      }
    };
  });
}

async function device(){const [deviceData,affinityData]=await Promise.all([request('/device'),request('/affinity')]);const deviceState=deviceData.device||{},rows=affinityData.affinity||[];app.innerHTML=`<div class="summary-grid"><article class="card"><h3>电量</h3><div class="metric">${esc(deviceState.battery??'-')}%</div><div class="muted">${deviceState.charging?'充电中':'未充电'} · ${esc(deviceState.network||'-')}</div></article><article class="card"><h3>状态</h3><div class="metric compact">${esc(deviceState.activity||'-')}</div><div class="muted">${deviceState.doNotDisturb?'勿扰':'可用'} · 通知 ${esc(deviceState.notificationCount??0)}</div></article></div>${has('device.write')?`<form id="device-form" class="tool-section"><h3>更新设备状态</h3><div class="form-grid"><label>电量<input name="battery" type="number" min="0" max="100" value="${esc(deviceState.battery??50)}"></label><label>网络<select name="network"><option value="wifi" ${deviceState.network==='wifi'?'selected':''}>Wi‑Fi</option><option value="cellular" ${deviceState.network==='cellular'?'selected':''}>蜂窝网络</option><option value="weak" ${deviceState.network==='weak'?'selected':''}>信号较弱</option><option value="offline" ${deviceState.network==='offline'?'selected':''}>离线</option></select></label><label>活动<input name="activity" value="${esc(deviceState.activity||'')}"></label><label><input name="charging" type="checkbox" ${deviceState.charging?'checked':''}> 充电中</label><label><input name="doNotDisturb" type="checkbox" ${deviceState.doNotDisturb?'checked':''}> 勿扰</label></div><button>保存设备状态</button></form>`:''}<section class="tool-section"><h3>关系与好感</h3><div class="table-wrap"><table><thead><tr><th>机器人</th><th>用户</th><th>分数</th><th>说明</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.botId)}</td><td>${esc(x.userId)}</td><td>${esc(x.value)}</td><td>${esc(x.reason||'')}</td></tr>`).join('')||'<tr><td colspan="4">暂无关系记录</td></tr>'}</tbody></table></div></section>${has('memory.write')?`<form id="affinity-form" class="tool-section"><h3>调整好感</h3><div class="form-grid"><label>机器人 ID<input name="botId" value="main" required></label><label>用户 ID<input name="userId" required></label><label>变化（-10..10）<input name="delta" type="number" min="-10" max="10" required></label></div><p class="muted">此操作会记录为手动调整。</p><label>备注<input name="note"></label><button>提交调整</button></form>`:''}`;app.querySelector('#device-form')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget),payload={battery:Number(f.get('battery')),network:String(f.get('network')),activity:String(f.get('activity')),charging:f.get('charging')==='on',doNotDisturb:f.get('doNotDisturb')==='on'};await request('/device/transition',{method:'POST',body:body(payload)});await device();});app.querySelector('#affinity-form')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget),payload={botId:String(f.get('botId')),userId:String(f.get('userId')),delta:Number(f.get('delta')),note:String(f.get('note'))};await confirmedRequest('/affinity/adjust',{method:'POST',body:body(payload)},{payload,description:'调整用户关系好感度'});await device();});}

async function world() {
  const [state, dayPlan] = await Promise.all([request('/world'), request('/world/day-plan')]); const worldState = state.world || {}; const plan = dayPlan.plan || {};
  app.innerHTML = `<div class="summary-grid"><article class="card"><h3>位置</h3><div class="metric compact">${esc(worldState.location || '—')}</div></article><article class="card"><h3>活动</h3><div class="metric compact">${esc(worldState.activity || '—')}</div></article><article class="card"><h3>天气</h3><div class="metric compact">${esc(worldState.weather || '—')}</div></article></div><div class="timeline">${(plan.items || []).map((item) => `<div class="timeline-item"><time>${esc(item.at)}</time><div><strong>${esc(item.activity)}</strong><span>${esc(item.location)} · ${esc(item.reason)}</span></div></div>`).join('') || emptyState('暂无计划', '今日计划为空。')}</div>`;
}

async function metrics() {
  const data = await request('/metrics'); const metricsData = data.metrics || {};
  app.innerHTML = `<div class="summary-grid">${['ai', 'embedding', 'rerank'].map((key) => { const metric = metricsData[key] || {}; return `<article class="card"><h3>${esc(key.toUpperCase())}</h3><div class="metric">${esc(metric.p95Ms ?? 0)}ms</div><div class="muted">P50 ${esc(metric.p50Ms ?? 0)}ms · 请求 ${esc(metric.count ?? 0)} · 失败 ${esc(metric.failures ?? 0)}</div></article>`; }).join('')}</div>`;
}

async function bots(){const data=await request('/bots');const rows=data.bots||[];app.innerHTML=`<div class="section-head"><div><h2>机器人与平台</h2><p class="muted">网关状态、会话与受控重启。</p></div></div><div class="table-wrap"><table><thead><tr><th>机器人</th><th>适配器</th><th>网关</th><th>延迟</th><th>重连</th><th>操作</th></tr></thead><tbody>${rows.map(b=>`<tr><td><strong>${esc(b.name||b.id)}</strong><br><span class="muted">${esc(b.id)}</span></td><td>${esc(b.adapter)}</td><td>${b.gateway?.connected?'已连接':'离线'}</td><td>${esc(b.gateway?.ping??'-')} ms</td><td>${esc(b.gateway?.reconnects??0)}</td><td><button data-restart="${esc(b.id)}" ${has('runtime.restart')?'':'disabled'}>重启</button></td></tr>`).join('')}</tbody></table></div>`;app.querySelectorAll('[data-restart]').forEach(btn=>btn.onclick=async()=>{const id=btn.dataset.restart,payload={};await confirmedRequest(`/bots/${encodeURIComponent(id)}/restart`,{method:'POST',body:body(payload)},{payload,description:`重启机器人 ${id}`});await bots();});}
async function extensions(){const data=await request('/extensions'),groups=data.extensions||{};app.innerHTML=`<div class="section-head"><div><h2>扩展与工具</h2><p class="muted">运行时注册表清单。仅显示名称、来源和凭据需求，不暴露工厂函数、路径或配置。</p></div></div>${Object.entries(groups).map(([kind,items])=>`<section class="tool-section"><h3>${esc(kind)}</h3><div class="table-wrap"><table><thead><tr><th>名称</th><th>来源</th><th>说明</th><th>凭据</th></tr></thead><tbody>${(items||[]).map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.source)}</td><td>${esc(x.description||'')}</td><td>${x.needsKey?'需要':'不需要'}</td></tr>`).join('')||'<tr><td colspan="4">暂无注册项</td></tr>'}</tbody></table></div></section>`).join('')}`;}
async function plugins(){const botsData=(await request('/bots')).bots||[];const groups=await Promise.all(botsData.map(async b=>({bot:b,plugins:(await request(`/bots/${encodeURIComponent(b.id)}/plugins`)).plugins||[]})));app.innerHTML=`<div class="section-head"><div><h2>已安装插件</h2><p class="muted">失败重载不会替换当前健康实例。</p></div></div>${groups.map(g=>`<section class="tool-section"><h3>${esc(g.bot.name||g.bot.id)}</h3><div class="table-wrap"><table><thead><tr><th>插件</th><th>状态</th><th>错误</th><th>操作</th></tr></thead><tbody>${g.plugins.map(p=>`<tr><td>${esc(p.id)}</td><td>${esc(p.state)}</td><td>${esc(p.errors)}</td><td><button data-reload="${esc(g.bot.id)}:${esc(p.id)}" ${has('plugin.reload')?'':'disabled'}>重载</button></td></tr>`).join('')||'<tr><td colspan="4">暂无插件</td></tr>'}</tbody></table></div></section>`).join('')}`;app.querySelectorAll('[data-reload]').forEach(btn=>btn.onclick=async()=>{const[botId,pluginId]=btn.dataset.reload.split(':');const payload={};await confirmedRequest(`/bots/${encodeURIComponent(botId)}/plugins/${encodeURIComponent(pluginId)}/reload`,{method:'POST',body:body(payload)},{payload,description:`重载插件 ${pluginId}`});await plugins();});}
async function operations(){const[sessions,tasks,audit]=await Promise.all([request('/ops/sessions?limit=30'),request('/tasks?limit=30'),has('audit.read')?request('/admin/audit?limit=30'):Promise.resolve({audit:{items:[]}})]);const ss=sessions.sessions?.items||[],tt=tasks.tasks?.items||[],aa=audit.audit?.items||[];app.innerHTML=`<div class="tabs-strip"><button data-view="sessions">会话 ${ss.length}</button><button data-view="chatlog">聊天记录</button><button data-view="tasks">任务 ${tt.length}</button><button data-view="audit">审计 ${aa.length}</button></div><section id="ops-view"></section>`;const views={sessions:`<div class="table-wrap"><table><thead><tr><th>机器人/频道</th><th>消息</th><th>长度</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${ss.map(x=>`<tr><td>${esc(x.botId)} / ${esc(x.channelId)}</td><td>${esc(x.messageCount)}</td><td>${esc(x.contentLength)}</td><td>${esc(new Date(x.updatedAt).toLocaleString())}</td><td><button data-clear-session="${esc(x.id)}" ${has('sessions.chat.delete')?'':'disabled'}>清理</button></td></tr>`).join('')}</tbody></table></div>`,chatlog:`<section class="card"><h3>Discord 聊天记录</h3><p class="muted">仅有会话聊天读取权限的管理员可查看。输入频道 ID 后读取最近 50 条收发记录。</p><form id="chat-log-form"><input id="chat-log-channel" placeholder="Discord 频道 ID" required><input id="chat-log-bot" placeholder="机器人 ID（可选）"><button type="submit">加载记录</button></form><div id="chat-log-results"></div></section>`,tasks:`<div class="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>运行</th><th>错误</th><th>操作</th></tr></thead><tbody>${tt.map(x=>`<tr><td>${esc(x.name||x.id)}<br><small>${esc(x.controlName||'只读')}</small></td><td>${esc(x.state)}${x.paused?'（暂停）':''}</td><td>${esc(x.runs??0)}</td><td>${esc(x.errors??x.errorCount??0)}</td><td>${x.controlName&&has('tasks.control')?`<button data-task-action="${esc(x.id)}:pause">暂停</button><button data-task-action="${esc(x.id)}:resume">恢复</button><button data-task-action="${esc(x.id)}:run">立即运行</button>`:'—'}</td></tr>`).join('')}</tbody></table></div>`,audit:`<div class="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>结果</th></tr></thead><tbody>${aa.map(x=>`<tr><td>${esc(x.at)}</td><td>${esc(x.actor)}</td><td>${esc(x.action)}</td><td>${esc(x.outcome)}</td></tr>`).join('')}</tbody></table></div>`};const render=v=>document.querySelector('#ops-view').innerHTML=views[v];app.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>render(b.dataset.view));render('sessions');app.querySelectorAll('[data-task-action]').forEach(b=>b.onclick=async()=>{const[id,action]=b.dataset.taskAction.split(':');const payload={};await confirmedRequest(`/tasks/${encodeURIComponent(id)}/${action}`,{method:'POST',body:body(payload)},{payload,description:`${action==='pause'?'暂停':action==='resume'?'恢复':'立即运行'}安全任务`});await operations();});app.querySelectorAll('[data-clear-session]').forEach(b=>b.onclick=async()=>{const id=b.dataset.clearSession,payload={};await confirmedRequest(`/ops/sessions/${encodeURIComponent(id)}`,{method:'DELETE',body:body(payload)},{payload,description:'清理此聊天会话'});await operations();});const chatForm=document.querySelector('#chat-log-form');if(chatForm)chatForm.onsubmit=async event=>{event.preventDefault();const channel=document.querySelector('#chat-log-channel').value.trim(),bot=document.querySelector('#chat-log-bot').value.trim(),target=document.querySelector('#chat-log-results');if(!channel)return;target.textContent='加载中...';try{const result=await request(`/ops/chat-log?channelId=${encodeURIComponent(channel)}${bot?`&botId=${encodeURIComponent(bot)}`:''}`);target.innerHTML=`<div class="table-wrap"><table><thead><tr><th>时间</th><th>发送者</th><th>内容</th></tr></thead><tbody>${(result.messages||[]).map(m=>`<tr><td>${esc(new Date(m.created_at).toLocaleString())}</td><td>${esc(m.username)}</td><td>${esc(m.content)}</td></tr>`).join('')||'<tr><td colspan="3">没有记录</td></tr>'}</tbody></table></div>`;}catch(error){target.textContent=error.message||'加载失败';}};}
async function logs(){const data=await request('/logs?limit=200');const rows=data.logs?.items||data.items||[];const gap=data.logs?.gap??data.gap;app.innerHTML=`<div class="section-head"><div><h2>结构化日志</h2><p class="muted">有界脱敏缓冲；不包含消息正文、提示词或凭据。</p></div><button id="refresh-logs">刷新</button></div>${gap?'<div class="notice warn">较早日志已被环形缓冲覆盖。</div>':''}<div class="log-view">${rows.map(x=>`<div class="log-line level-${esc(x.level)}"><time>${esc(new Date(x.time).toLocaleTimeString())}</time><span>${esc(x.level)}</span><strong>${esc(x.component||'运行时')}</strong><code>${esc(x.message)}</code></div>`).join('')||emptyState('暂无日志','运行时尚未产生可展示的结构化日志。')}</div>`;document.querySelector('#refresh-logs').onclick=logs;}
async function memory(){const rows=(await request('/memory?limit=100')).memories||[];app.innerHTML=`<div class="section-head"><div><h2>长期记忆</h2><p class="muted">默认仅展示元数据和摘要，正文按权限单独读取。</p></div></div><div class="table-wrap"><table><thead><tr><th>机器人/用户</th><th>范围</th><th>频道</th><th>长度</th><th>摘要</th><th>操作</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.botId)} / ${esc(x.userId)}</td><td>${esc(x.scope)}</td><td>${esc(x.channelId)}</td><td>${esc(x.textLength)}</td><td><code>${esc(String(x.sha256||'').slice(0,12))}</code></td><td><button data-memory-detail="${esc(x.key)}" ${has('memory.read')?'':'disabled'}>查看</button><button data-memory-delete="${esc(x.key)}" ${has('memory.delete')?'':'disabled'}>删除</button></td></tr>`).join('')}</tbody></table></div><section id="memory-detail"></section>`;app.querySelectorAll('[data-memory-detail]').forEach(b=>b.onclick=async()=>{const m=(await request(`/memory/${encodeURIComponent(b.dataset.memoryDetail)}`)).memory;document.querySelector('#memory-detail').innerHTML=`<pre>${esc(JSON.stringify(m,null,2))}</pre>`;});app.querySelectorAll('[data-memory-delete]').forEach(b=>b.onclick=async()=>{const key=b.dataset.memoryDelete,payload={};await confirmedRequest(`/memory/${encodeURIComponent(key)}`,{method:'DELETE',body:body(payload)},{payload,description:'永久删除此长期记忆'});await memory();});}
async function debugchat() {
  const caps = await request('/debug/chat/capabilities');
  const bots = caps.capabilities?.bots || caps.bots || [];
  app.innerHTML = `<form id="debug-chat-form" class="tool-section"><h2>隔离调试聊天</h2><p class="muted">不访问 Discord、真实会话、世界、设备、记忆、插件或角色提示词。</p><label>机器人<select name="botId">${bots.map((bot) => `<option value="${esc(bot.id)}">${esc(bot.name || bot.id)} · ${esc(bot.model || '')}</option>`).join('')}</select></label><label>测试输入<textarea name="content" rows="6" maxlength="4000" required placeholder="输入模型测试内容"></textarea></label><button>发送隔离请求</button></form><section id="debug-chat-output"></section>`;
  document.querySelector('#debug-chat-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await request('/debug/chat', { method: 'POST', body: body({ botId: String(form.get('botId')), content: String(form.get('content')) }) });
    const reply = typeof result.reply === 'string' ? { content: result.reply, trace: result.trace } : (result.reply || {});
    document.querySelector('#debug-chat-output').innerHTML = `<section class="tool-section"><h3>模型回复</h3><pre>${esc(reply.content || '')}</pre><div class="muted">${esc(reply.trace?.model || '')} · ${esc(reply.trace?.latencyMs || 0)} ms · ${esc(reply.trace?.outcome || '')}</div></section>`;
  };
}
async function knowledge(){const data=await request('/knowledge-bases?limit=100'),bases=Array.isArray(data.bases)?data.bases:(data.bases?.items||[]);app.innerHTML=`<div class="section-head"><div><h2>本地知识库</h2><p class="muted">纯文本、确定性分块、关键词检索。文档正文不会作为 HTML 渲染。</p></div>${has('knowledge.write')?'<button id="new-kb">新建知识库</button>':''}</div><section id="knowledge-create"></section><div class="table-wrap"><table><thead><tr><th>名称</th><th>描述</th><th>文档</th><th>操作</th></tr></thead><tbody>${bases.map(b=>`<tr><td>${esc(b.name)}</td><td>${esc(b.description||'')}</td><td>${esc(b.documentCount??0)}</td><td><button data-kb="${esc(b.id)}">管理</button></td></tr>`).join('')}</tbody></table></div><section id="knowledge-detail"></section>`;document.querySelector('#new-kb')?.addEventListener('click',()=>{document.querySelector('#knowledge-create').innerHTML=`<form id="kb-form" class="tool-section"><label>名称<input name="name" required maxlength="120"></label><label>描述<textarea name="description" rows="3" maxlength="2000"></textarea></label><button>创建</button></form>`;document.querySelector('#kb-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),payload={name:String(f.get('name')),description:String(f.get('description'))};await confirmedRequest('/knowledge-bases',{method:'POST',body:body(payload)},{payload,description:'创建本地知识库'});await knowledge();};});app.querySelectorAll('[data-kb]').forEach(b=>b.onclick=async()=>{const id=b.dataset.kb,[baseResult,documentsResult]=await Promise.all([request(`/knowledge-bases/${encodeURIComponent(id)}`),request(`/knowledge-bases/${encodeURIComponent(id)}/documents?limit=100`)]),base=baseResult.base,documentValue=documentsResult.documents,docs=Array.isArray(documentValue)?documentValue:(documentValue?.items||[]);document.querySelector('#knowledge-detail').innerHTML=`<section class="tool-section"><h3>${esc(base.name)}</h3><form id="kb-doc"><label>文档标题<input name="title" required></label><label>纯文本正文<textarea name="content" rows="9" maxlength="524288" required></textarea></label><button ${has('knowledge.write')?'':'disabled'}>写入文档</button></form><div class="table-wrap"><table><thead><tr><th>标题</th><th>长度</th><th>分块</th></tr></thead><tbody>${docs.map(d=>`<tr><td>${esc(d.name || d.title || '')}</td><td>${esc(d.textLength ?? d.contentLength ?? 0)}</td><td>${esc(d.chunkCount)}</td></tr>`).join('')}</tbody></table></div></section>`;document.querySelector('#kb-doc').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),payload={name:String(f.get('title')),text:String(f.get('content'))};await confirmedRequest(`/knowledge-bases/${encodeURIComponent(id)}/documents`,{method:'POST',body:body(payload)},{payload,description:'写入知识库文档'});await knowledge();};});}
async function behavior(){app.innerHTML=`<form id="behavior-form" class="tool-section"><h2>行为模拟运行</h2><p class="muted">只执行本地规则，不调用模型、不写状态。</p><div class="form-grid"><label>机器人 ID<input name="botId" value="main" required></label><label>用户 ID<input name="userId" value="debug-user" required></label><label>频道 ID<input name="channelId" value="dm:debug-user" required></label><label><input name="dm" type="checkbox" checked> 私聊</label></div><label>消息<textarea name="content" rows="4" required>你好</textarea></label><button type="submit">评估</button></form><section id="behavior-result"></section>`;app.querySelector('#behavior-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),payload={botId:String(f.get('botId')),userId:String(f.get('userId')),channelId:String(f.get('channelId')),dm:f.get('dm')==='on',content:String(f.get('content')),mentionsBot:false,recentReplies:0};const result=await request('/behavior/dry-run',{method:'POST',body:body(payload)});document.querySelector('#behavior-result').innerHTML=`<pre>${esc(JSON.stringify(result.result,null,2))}</pre>`;};}
async function opaudit(){const[toolsResult,auditResult]=await Promise.all([request('/ops/operator-tools').catch(()=>({tools:[]})),request('/ops/operator-audit?limit=100')]);const tools=toolsResult.tools||[],entries=auditResult.entries||[];const riskLabel={read:'只读',write:'需确认',danger:'拒绝'};app.innerHTML=`<div class="section-head"><div><h2>运维审计</h2><p class="muted">Operator 工具清单与调用记录（已脱敏）。写入类操作只能在聊天通道用 ?op confirm 二次确认。</p></div><button id="refresh-opaudit">刷新</button></div><section class="tool-section"><h3>可用工具 ${tools.length}</h3><div class="table-wrap"><table><thead><tr><th>工具</th><th>风险</th><th>用法</th><th>说明</th></tr></thead><tbody>${tools.map(t=>`<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(riskLabel[t.risk]||t.risk)}${t.confirm?'（确认）':''}</td><td><code>${esc(t.usage)}</code></td><td>${esc(t.description)}</td></tr>`).join('')||'<tr><td colspan="4">暂无工具（operator 插件未启用或 API 未就绪）</td></tr>'}</tbody></table></div></section><section class="tool-section"><h3>调用记录 ${entries.length}</h3><div class="table-wrap"><table><thead><tr><th>时间</th><th>工具</th><th>参数</th><th>调用者</th><th>结果</th><th>详情</th></tr></thead><tbody>${entries.map(e=>`<tr><td>${esc(new Date(e.ts).toLocaleString())}</td><td>${esc(e.tool)}</td><td><code>${esc(e.args||'')}</code></td><td>${esc(e.caller)}</td><td>${esc(e.outcome)}</td><td>${esc(e.detail||'')}</td></tr>`).join('')||'<tr><td colspan="6">暂无调用记录</td></tr>'}</tbody></table></div></section>`;document.querySelector('#refresh-opaudit').onclick=opaudit;}
function mcpNotice(label, reason) {
  const code = reason?.statusCode;
  if (code === 404) return `<div class="notice">${esc(label)}：API 尚未启用，等待服务端接入。</div>`;
  if (code === 409) return `<div class="notice warn">${esc(label)}：MCP 未配置或未启用。</div>`;
  if (code === 403) return `<div class="notice warn">${esc(label)}：当前账号权限不足。</div>`;
  return `<div class="notice error">${esc(label)} 加载失败：${esc(reason?.message || '未知错误')}</div>`;
}

function mcpText(part) {
  if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
  try { return JSON.stringify(part); } catch { return String(part); }
}

async function mcp() {
  const results = await Promise.allSettled([request('/mcp/policy'), request('/mcp/tools'), request('/mcp/audit')]);
  const policy = results[0].status === 'fulfilled' ? results[0].value : {};
  const catalog = results[1].status === 'fulfilled' ? results[1].value : {};
  const audit = results[2].status === 'fulfilled' ? results[2].value : {};
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const servers = Array.isArray(catalog.servers) ? catalog.servers : [];
  const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
  const entries = Array.isArray(audit.entries) ? audit.entries : [];
  const labels = ['工具策略', '工具清单', '调用审计'];
  const notice = results.map((result, index) => result.status === 'rejected' ? mcpNotice(labels[index], result.reason) : '').join('');
  const outcomeLabel = { allowed: '允许', denied: '拒绝', error: '错误' };
  app.innerHTML = `<div class="section-head"><div><h2>MCP 工具</h2><p class="muted">工具级权限策略、服务器状态与调用审计。审计中的参数均已脱敏。</p></div><button id="refresh-mcp">刷新</button></div>${notice}<section class="tool-section"><h3>工具策略 ${rules.length}</h3><div class="table-wrap"><table><thead><tr><th>匹配模式</th><th>最低角色</th></tr></thead><tbody>${rules.map((rule) => `<tr><td><code>${esc(rule.pattern)}</code></td><td>${esc(rule.minRole)}</td></tr>`).join('') || '<tr><td colspan="2">暂无策略规则（默认拒绝所有工具）</td></tr>'}</tbody></table></div></section><section class="tool-section"><h3>服务器状态 ${servers.length}</h3><div class="table-wrap"><table><thead><tr><th>服务器</th><th>传输</th><th>初始化</th><th>工具数</th><th>错误</th></tr></thead><tbody>${servers.map((server) => `<tr><td><strong>${esc(server.id)}</strong></td><td>${esc(server.transport)}</td><td>${server.initialized ? '已就绪' : '未就绪'}</td><td>${esc(server.toolCount ?? 0)}</td><td>${esc(server.error || '')}</td></tr>`).join('') || '<tr><td colspan="5">暂无已配置的 MCP 服务器</td></tr>'}</tbody></table></div></section><section class="tool-section"><h3>可用工具 ${tools.length}</h3><div class="table-wrap"><table><thead><tr><th>服务器</th><th>工具</th><th>说明</th></tr></thead><tbody>${tools.map((tool) => `<tr><td>${esc(tool.server)}</td><td><strong>${esc(tool.name)}</strong></td><td>${esc(tool.description || '')}</td></tr>`).join('') || '<tr><td colspan="3">暂无可用工具</td></tr>'}</tbody></table></div></section>${has('mcp.call') ? `<form id="mcp-call-form" class="tool-section"><h3>调用工具</h3><div class="form-grid"><label>服务器<input name="server" list="mcp-servers" required placeholder="server id"></label><label>工具<input name="tool" list="mcp-tools" required placeholder="tool name"></label></div><datalist id="mcp-servers">${servers.map((server) => `<option value="${esc(server.id)}"></option>`).join('')}</datalist><datalist id="mcp-tools">${tools.map((tool) => `<option value="${esc(tool.name)}"></option>`).join('')}</datalist><label>参数 (JSON 对象)<textarea name="arguments" rows="6" spellcheck="false">{}</textarea></label><div id="mcp-call-error" class="notice error" hidden></div><button class="danger" type="submit">调用（需二次确认）</button></form><section id="mcp-call-result"></section>` : ''}<section class="tool-section"><h3>调用审计 ${entries.length}</h3><div class="table-wrap"><table><thead><tr><th>时间</th><th>工具</th><th>调用者</th><th>结果</th><th>参数</th><th>详情</th></tr></thead><tbody>${entries.map((entry) => `<tr><td>${esc(entry.at ? new Date(entry.at).toLocaleString() : '')}</td><td>${esc(entry.tool)}</td><td>${esc(entry.caller)}</td><td>${esc(outcomeLabel[entry.outcome] || entry.outcome)}</td><td><code>${esc(entry.argsRedacted || '')}</code></td><td>${esc(entry.detail || '')}</td></tr>`).join('') || '<tr><td colspan="6">暂无调用记录</td></tr>'}</tbody></table></div></section>`;
  document.querySelector('#refresh-mcp').onclick = mcp;
  document.querySelector('#mcp-call-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const errorBox = document.querySelector('#mcp-call-error');
    let args;
    try { args = JSON.parse(String(form.get('arguments') || '{}') || '{}'); } catch { errorBox.textContent = '参数必须是有效 JSON。'; errorBox.hidden = false; return; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) { errorBox.textContent = '参数必须是 JSON 对象（{ ... }）。'; errorBox.hidden = false; return; }
    const server = String(form.get('server') || '').trim();
    const tool = String(form.get('tool') || '').trim();
    if (!server || !tool) { errorBox.textContent = '请填写服务器与工具名称。'; errorBox.hidden = false; return; }
    errorBox.hidden = true;
    const payload = { server, tool, arguments: args };
    const response = await confirmedRequest('/mcp/call', { method: 'POST', body: body(payload) }, { permission: 'mcp.call', action: 'mcp.call', payload, description: `调用 MCP 工具 ${server}/${tool}` });
    const result = response.result ?? response;
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.map((part) => mcpText(part)).join('\n');
    document.querySelector('#mcp-call-result').innerHTML = `<section class="tool-section"><h3>调用结果</h3>${result.isError ? '<div class="notice error">工具返回错误（isError）。</div>' : ''}<pre>${esc(text || JSON.stringify(result, null, 2))}</pre></section>`;
  });
}

const tabs = { overview,bots,plugins,extensions,mcp,operations,opaudit,logs,memory,behavior,debugchat,knowledge, users,tokens, health, models,modelops,providers, config, characters, world,device, metrics };
async function activate(button) {
  if (!button || button.hidden) return;
  document.querySelectorAll('#navigation button').forEach((item) => item.classList.toggle('active', item === button));
  title.textContent = button.textContent;
  if(location.hash!==`#/${button.dataset.tab}`)history.replaceState(null,'',`#/${button.dataset.tab}`);
  app.innerHTML = '<div class="loading">正在加载…</div>';
  try { await tabs[button.dataset.tab](); setConnected(true); } catch (error) { if (error.statusCode !== 401) { setConnected(false); app.innerHTML = `<div class="notice error">${esc(error.message)}</div>`; } }
}
document.querySelectorAll('#navigation button').forEach((button) => button.addEventListener('click', () => activate(button)));
window.addEventListener('hashchange',()=>{const tab=location.hash.replace(/^#\/?/,'');const button=[...document.querySelectorAll('#navigation button')].find(x=>x.dataset.tab===tab&&!x.hidden);if(button)activate(button);});

await authenticate();
