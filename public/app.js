(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    csrf: null, username: '', initialized: false,
    page: 'all', mailboxes: [], platforms: [], platformId: null,
    registrations: [], detailId: null, detailFolder: 'inbox',
    messages: { inbox: [], junk: [] }, editingId: null, mailboxMode: 'single', selectedIds: new Set(),
    allSort: { key: 'lastReceivedAt', direction: 'asc' },
    platformSort: { key: 'registered', direction: 'asc' },
    deletingPlatform: false,
  };
  let toastTimer;
  let registrationsRequest = 0;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  async function api(method, url, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    let response;
    try {
      response = await fetch(url, {
        method, headers, credentials: 'same-origin', cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('无法连接服务器，请检查网络');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`服务器返回无效响应（HTTP ${response.status}）`); }
    if (!response.ok) {
      if (response.status === 401 && state.csrf) {
        state.csrf = null;
        showAuth(true);
      }
      throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
    }
    return data;
  }

  function toast(message, error = false) {
    const box = $('toast');
    box.textContent = message;
    box.classList.toggle('error', error);
    box.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.add('hidden'), 4500);
  }

  function formatDate(value, withTime = false) {
    if (!value) return '未检查';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '未知';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    }).format(date);
  }

  function receivedLabel(mailbox, withTime = false) {
    if (mailbox.lastReceivedAt) return formatDate(mailbox.lastReceivedAt, withTime);
    if (mailbox.lastError) return '检查失败';
    return mailbox.lastCheckedAt ? '暂无邮件' : '未检查';
  }

  function daysSince(value) {
    if (!value) return null;
    const received = new Date(value);
    if (Number.isNaN(received.getTime())) return null;
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const receivedDay = Date.UTC(received.getFullYear(), received.getMonth(), received.getDate());
    return Math.max(0, Math.round((today - receivedDay) / 86400000));
  }

  function showAuth(login) {
    $('loading').classList.add('hidden');
    $('app-shell').classList.add('hidden');
    $('auth-screen').classList.remove('hidden');
    $('auth-title').textContent = login ? '登录 Mailboard' : '欢迎使用 Mailboard';
    $('auth-description').textContent = login
      ? '输入管理员账号与密码，继续管理邮箱。'
      : '首次访问请设置管理员账号。';
    $('confirm-field').classList.toggle('hidden', login);
    $('auth-confirm').required = !login;
    $('auth-password').minLength = login ? 1 : 10;
    $('auth-password').autocomplete = login ? 'current-password' : 'new-password';
    $('auth-submit').textContent = login ? '登录并进入后台' : '完成设置';
    state.initialized = login;
    $('auth-password').value = '';
    $('auth-confirm').value = '';
    $('auth-username').focus();
  }

  async function boot() {
    try {
      const auth = await api('GET', '/api/auth/state');
      state.initialized = auth.initialized;
      if (!auth.authenticated) return showAuth(auth.initialized);
      state.csrf = auth.csrfToken;
      state.username = auth.username;
      $('admin-name').textContent = auth.username;
      $('loading').classList.add('hidden');
      $('auth-screen').classList.add('hidden');
      $('app-shell').classList.remove('hidden');
      await loadData();
    } catch (error) {
      $('loading').textContent = error.message;
    }
  }

  async function loadData() {
    const [mailboxes, platforms] = await Promise.all([
      api('GET', '/api/mailboxes'), api('GET', '/api/platforms'),
    ]);
    state.mailboxes = mailboxes.mailboxes;
    const currentIds = new Set(state.mailboxes.map((mailbox) => mailbox.id));
    for (const id of state.selectedIds) if (!currentIds.has(id)) state.selectedIds.delete(id);
    state.platforms = platforms.platforms;
    renderPlatformSelect();
    await loadRegistrations();
    renderAll();
  }

  function renderPlatformSelect() {
    const select = $('platform-select');
    const search = $('platform-name-search').value.trim().toLowerCase();
    const platforms = state.platforms.filter((platform) => platform.name.toLowerCase().includes(search));
    const previousId = state.platformId;
    if (!platforms.some((platform) => platform.id === state.platformId)) {
      state.platformId = platforms[0]?.id || null;
    }
    select.innerHTML = `<option value="">${search && !platforms.length ? '没有匹配的平台' : '请选择平台'}</option>` + platforms
      .map((platform) => `<option value="${platform.id}">${escapeHtml(platform.name)}</option>`).join('');
    select.value = state.platformId || '';
    select.disabled = !platforms.length;
    $('delete-platform-button').disabled = !state.platformId || state.deletingPlatform;
    return previousId !== state.platformId;
  }

  async function loadRegistrations() {
    const requestNumber = ++registrationsRequest;
    if (!state.platformId) {
      state.registrations = [];
      renderPlatform();
      return;
    }
    const platformId = state.platformId;
    const data = await api('GET', `/api/platforms/${platformId}/registrations`);
    if (requestNumber !== registrationsRequest || platformId !== state.platformId) return;
    state.registrations = data.mailboxes;
    renderPlatform();
  }

  function setPage(page) {
    state.page = page;
    $('all-page').classList.toggle('hidden', page !== 'all');
    $('platform-page').classList.toggle('hidden', page !== 'platform');
    $('nav-all').classList.toggle('active', page === 'all');
    $('nav-platform').classList.toggle('active', page === 'platform');
    $('breadcrumb-page').textContent = page === 'all' ? '全部平台' : '指定平台';
    if (page === 'all') renderAll(); else renderPlatform();
  }

  function mailboxActions(mailbox) {
    return `<div class="row-actions"><button type="button" data-action="view" data-id="${mailbox.id}">查看</button>
      <button type="button" data-action="refresh" data-id="${mailbox.id}">刷新</button>
      <button type="button" data-action="edit" data-id="${mailbox.id}">编辑</button>
      <button type="button" class="danger-link" data-action="delete" data-id="${mailbox.id}">删除</button></div>`;
  }

  function sortRows(rows, sort) {
    const direction = sort.direction === 'asc' ? 1 : -1;
    const value = (row) => {
      if (sort.key === 'daysSince') return daysSince(row.lastReceivedAt);
      if (sort.key === 'lastReceivedAt' || sort.key === 'lastCheckedAt') {
        const timestamp = row[sort.key] ? Date.parse(row[sort.key]) : NaN;
        return Number.isNaN(timestamp) ? null : timestamp;
      }
      return row[sort.key];
    };
    rows.sort((a, b) => {
      const left = value(a);
      const right = value(b);
      // Unchecked or missing values stay at the bottom in either direction.
      if (left == null && right != null) return 1;
      if (right == null && left != null) return -1;
      let comparison = 0;
      if (left != null && right != null) {
        comparison = typeof left === 'string' ? left.localeCompare(right) : Number(left) - Number(right);
      }
      return direction * comparison || a.email.localeCompare(b.email);
    });
    return rows;
  }

  function renderSortHeaders(table) {
    const sort = state[`${table}Sort`];
    document.querySelectorAll(`[data-sort-table="${table}"]`).forEach((button) => {
      const active = button.dataset.sortKey === sort.key;
      button.closest('th').setAttribute('aria-sort', active
        ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
      button.querySelector('.sort-indicator').textContent = active ? (sort.direction === 'asc' ? '↑' : '↓') : '';
      const nextDirection = active && sort.direction === 'asc' ? '降序' : '升序';
      button.title = `点击按${button.querySelector('.sort-label').textContent}${nextDirection}排序`;
    });
  }

  function renderAll() {
    const mailboxes = [...state.mailboxes];
    const search = $('all-search').value.trim().toLowerCase();
    const filtered = mailboxes.filter((mailbox) => mailbox.email.toLowerCase().includes(search));
    sortRows(filtered, state.allSort);
    renderSortHeaders('all');
    $('stat-count').textContent = String(mailboxes.length);
    const ages = mailboxes.map((mailbox) => daysSince(mailbox.lastReceivedAt)).filter((days) => days !== null);
    $('stat-oldest').textContent = ages.length ? `${Math.max(...ages)} 天` : '—';
    const checks = mailboxes.map((mailbox) => mailbox.lastCheckedAt).filter(Boolean).sort();
    $('stat-checked').textContent = checks.length ? formatDate(checks[checks.length - 1], true) : '—';
    $('all-list-count').textContent = `展示 ${filtered.length} / ${mailboxes.length} 个邮箱`;
    $('select-all').checked = filtered.length > 0 && filtered.every((mailbox) => state.selectedIds.has(mailbox.id));
    $('select-all').indeterminate = filtered.some((mailbox) => state.selectedIds.has(mailbox.id)) && !$('select-all').checked;
    $('all-rows').innerHTML = filtered.length ? filtered.map((mailbox) => {
      const days = daysSince(mailbox.lastReceivedAt);
      return `<tr><td><input type="checkbox" data-select-mailbox="${mailbox.id}" aria-label="选择 ${escapeHtml(mailbox.email)}" ${state.selectedIds.has(mailbox.id) ? 'checked' : ''}></td>
        <td>${escapeHtml(mailbox.email)}${mailbox.lastError ? `<span class="subtle">上次检查失败：${escapeHtml(mailbox.lastError)}</span>` : ''}</td>
        <td>${escapeHtml(receivedLabel(mailbox))}</td>
        <td>${days === null ? '—' : `${days} 天`}</td>
        <td>${mailbox.lastCheckedAt ? escapeHtml(formatDate(mailbox.lastCheckedAt, true)) : '—'}</td>
        <td>${mailboxActions(mailbox)}</td></tr>`;
    }).join('') : '<tr><td class="empty-row" colspan="6">暂无邮箱。点击“添加邮箱”开始。</td></tr>';
  }

  function renderPlatform() {
    const platform = state.platforms.find((item) => item.id === state.platformId);
    $('platform-list-title').textContent = platform ? `${platform.name} · 邮箱注册情况` : '邮箱注册情况';
    const rows = [...state.registrations];
    const search = $('platform-search').value.trim().toLowerCase();
    const filtered = rows.filter((row) => row.email.toLowerCase().includes(search));
    sortRows(filtered, state.platformSort);
    renderSortHeaders('platform');
    const registeredCount = rows.filter((row) => row.registered).length;
    $('platform-summary').textContent = platform
      ? `${rows.length - registeredCount} 未注册 / ${registeredCount} 已注册`
      : (state.platforms.length ? '请选择或搜索平台。' : '添加平台后，所有邮箱默认未注册。');
    $('platform-list-count').textContent = platform ? `展示 ${filtered.length} / ${rows.length} 个邮箱` : '请选择或添加平台';
    $('platform-rows').innerHTML = platform && filtered.length ? filtered.map((row) => `
      <tr><td>${escapeHtml(row.email)}</td>
      <td>${escapeHtml(receivedLabel(row))}</td>
      <td><button type="button" class="status-button ${row.registered ? 'registered' : ''}" data-action="toggle" data-id="${row.id}" aria-label="切换 ${escapeHtml(row.email)} 的注册状态">${row.registered ? '✓ 已注册' : '○ 未注册'}</button></td>
      <td>${mailboxActions(row)}</td></tr>`).join('')
      : `<tr><td class="empty-row" colspan="4">${platform ? '暂无匹配的邮箱' : '请先添加平台'}</td></tr>`;
  }

  function openDialog(id) { $(id).showModal(); }
  function closeDialog(id) { $(id).close(); }

  function setMailboxMode(mode) {
    const bulk = mode === 'bulk' && !state.editingId;
    state.mailboxMode = bulk ? 'bulk' : 'single';
    for (const name of ['single', 'bulk']) {
      const active = name === state.mailboxMode;
      $(`mailbox-${name}-tab`).classList.toggle('active', active);
      $(`mailbox-${name}-tab`).setAttribute('aria-selected', String(active));
      $(`mailbox-${name}-panel`).classList.toggle('hidden', !active);
      $(`mailbox-${name}-panel`).disabled = !active;
    }
    $('mailbox-submit').textContent = bulk ? '批量添加' : '保存邮箱';
  }

  function openMailboxForm(id = null) {
    state.editingId = id;
    const mailbox = state.mailboxes.find((item) => item.id === id);
    $('mailbox-form').reset();
    $('mailbox-mode-tabs').classList.toggle('hidden', !!mailbox);
    setMailboxMode('single');
    $('mailbox-modal-title').textContent = mailbox ? '编辑邮箱' : '添加邮箱';
    $('mailbox-email').value = mailbox?.email || '';
    $('mailbox-client').value = mailbox?.clientId || '';
    $('mailbox-token').value = '';
    $('mailbox-token').required = !mailbox;
    $('mailbox-token-help').textContent = mailbox
      ? '留空则保留已保存的刷新令牌。'
      : '令牌会在服务器端加密保存，不会在列表中显示。';
    openDialog('mailbox-dialog');
  }

  async function refreshMailbox(id) {
    const mailbox = state.mailboxes.find((item) => item.id === id);
    if (!mailbox) return;
    toast(`正在检查 ${mailbox.email}…`);
    try {
      const result = await api('POST', `/api/mailboxes/${id}/refresh`, {});
      await loadData();
      if (state.detailId === id) await loadMessages();
      toast(`已检查 ${mailbox.email}：收件箱 ${result.counts.inbox} 封，垃圾邮件 ${result.counts.junk} 封`);
    } catch (error) {
      await loadData().catch(() => {});
      toast(error.message, true);
    }
  }

  async function openDetail(id) {
    const mailbox = state.mailboxes.find((item) => item.id === id);
    if (!mailbox) return;
    state.detailId = id;
    state.detailFolder = 'inbox';
    $('detail-title').textContent = mailbox.email;
    $('detail-meta').textContent = `上次收信：${receivedLabel(mailbox, true)}\n上次检查：${formatDate(mailbox.lastCheckedAt, true)}`;
    openDialog('detail-dialog');
    await loadMessages();
  }

  async function loadMessages() {
    if (!state.detailId) return;
    const [inbox, junk] = await Promise.all([
      api('GET', `/api/mailboxes/${state.detailId}/messages?folder=inbox`),
      api('GET', `/api/mailboxes/${state.detailId}/messages?folder=junk`),
    ]);
    state.messages = { inbox: inbox.messages, junk: junk.messages };
    const mailbox = state.mailboxes.find((item) => item.id === state.detailId);
    if (mailbox) $('detail-meta').textContent = `上次收信：${receivedLabel(mailbox, true)}\n上次检查：${formatDate(mailbox.lastCheckedAt, true)}`;
    renderMessages();
  }

  function renderMessages() {
    $('tab-inbox').classList.toggle('active', state.detailFolder === 'inbox');
    $('tab-junk').classList.toggle('active', state.detailFolder === 'junk');
    const messages = state.messages[state.detailFolder];
    $('message-list').innerHTML = messages.length ? messages.map((message, index) => `
      <button type="button" class="message-item" data-message-index="${index}"><strong>${escapeHtml(message.subject || '（无主题）')}</strong><span>${escapeHtml(message.sender || '未知发件人')}</span><small>${escapeHtml(formatDate(message.receivedAt, true))}</small></button>`).join('')
      : '<div class="empty-row">暂无已保存邮件。点击“手动刷新”检查。</div>';
    $('message-subject').textContent = '选择一封邮件查看内容';
    $('message-sender').textContent = '';
    $('message-body').textContent = '';
  }

  function showMessage(index) {
    const message = state.messages[state.detailFolder][index];
    if (!message) return;
    document.querySelectorAll('.message-item').forEach((item) => item.classList.toggle('active', Number(item.dataset.messageIndex) === index));
    $('message-subject').textContent = message.subject || '（无主题）';
    $('message-sender').textContent = `${message.sender || '未知发件人'} · ${formatDate(message.receivedAt, true)}`;
    $('message-body').textContent = message.bodyText || message.preview || '（无正文）';
  }

  async function onRowAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const id = Number(button.dataset.id);
    const action = button.dataset.action;
    if (action === 'view') return openDetail(id).catch((error) => toast(error.message, true));
    if (action === 'refresh') return refreshMailbox(id);
    if (action === 'edit') return openMailboxForm(id);
    if (action === 'delete') {
      const mailbox = state.mailboxes.find((item) => item.id === id);
      if (!mailbox || !confirm(`删除 ${mailbox.email}？其平台状态和已保存邮件也会删除。`)) return;
      try {
        await api('DELETE', `/api/mailboxes/${id}`, {});
        await loadData();
        toast('邮箱已删除');
      } catch (error) { toast(error.message, true); }
    }
    if (action === 'toggle') {
      const row = state.registrations.find((item) => item.id === id);
      if (!row || !state.platformId) return;
      button.disabled = true;
      try {
        await api('PUT', `/api/platforms/${state.platformId}/registrations/${id}`, { registered: !row.registered });
        await loadRegistrations();
      } catch (error) { toast(error.message, true); button.disabled = false; }
    }
  }

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeDialog(button.dataset.close));
  });
  document.querySelectorAll('[data-page]').forEach((button) => {
    button.addEventListener('click', () => setPage(button.dataset.page));
  });
  $('all-search').addEventListener('input', renderAll);
  $('platform-search').addEventListener('input', renderPlatform);
  document.querySelectorAll('[data-sort-table]').forEach((button) => {
    button.addEventListener('click', () => {
      const table = button.dataset.sortTable;
      const sort = state[`${table}Sort`];
      const key = button.dataset.sortKey;
      sort.direction = sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc';
      sort.key = key;
      if (table === 'all') renderAll(); else renderPlatform();
    });
  });
  $('all-rows').addEventListener('click', onRowAction);
  $('all-rows').addEventListener('change', (event) => {
    const id = Number(event.target.dataset.selectMailbox);
    if (!id) return;
    if (event.target.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
    const boxes = [...document.querySelectorAll('#all-rows [data-select-mailbox]')];
    $('select-all').checked = boxes.length > 0 && boxes.every((box) => box.checked);
    $('select-all').indeterminate = boxes.some((box) => box.checked) && !$('select-all').checked;
  });
  $('select-all').addEventListener('change', (event) => {
    document.querySelectorAll('#all-rows [data-select-mailbox]').forEach((box) => {
      box.checked = event.target.checked;
      const id = Number(box.dataset.selectMailbox);
      if (box.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
    });
  });
  $('export-button').addEventListener('click', async () => {
    const ids = [...state.selectedIds];
    if (!state.mailboxes.length) return toast('没有可导出的邮箱', true);
    if (!confirm(`导出${ids.length ? `选中的 ${ids.length} 个` : '全部'}邮箱？导出文件含刷新令牌，请妥善保管。`)) return;
    try {
      const result = await api('POST', '/api/mailboxes/export', { ids });
      const content = result.mailboxes.map((mailbox) => [mailbox.email, mailbox.clientId, mailbox.refreshToken].join('----')).join('\n') + '\n';
      const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `mailboard-export-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`已导出 ${result.mailboxes.length} 个邮箱`);
    } catch (error) { toast(error.message, true); }
  });
  $('delete-selected-button').addEventListener('click', async () => {
    const ids = [...state.selectedIds];
    if (!ids.length) return toast('请先选择要删除的邮箱', true);
    if (!confirm(`删除选中的 ${ids.length} 个邮箱？其平台状态和已保存邮件也会删除。`)) return;
    try {
      const result = await api('POST', '/api/mailboxes/delete-batch', { ids });
      state.selectedIds.clear();
      await loadData();
      toast(`已删除 ${result.deleted} 个邮箱`);
    } catch (error) { toast(error.message, true); }
  });
  $('platform-rows').addEventListener('click', onRowAction);
  $('add-mailbox-button').addEventListener('click', () => openMailboxForm());
  document.querySelectorAll('[data-mailbox-mode]').forEach((button) => {
    button.addEventListener('click', () => setMailboxMode(button.dataset.mailboxMode));
  });
  $('change-password-button').addEventListener('click', () => {
    $('password-form').reset();
    openDialog('password-dialog');
  });
  $('password-dialog').addEventListener('close', () => $('password-form').reset());
  $('add-platform-button').addEventListener('click', () => openDialog('platform-dialog'));
  $('platform-name-search').addEventListener('input', async () => {
    if (!renderPlatformSelect()) return;
    state.registrations = [];
    renderPlatform();
    try { await loadRegistrations(); } catch (error) { toast(error.message, true); }
  });
  $('platform-select').addEventListener('change', async (event) => {
    state.platformId = Number(event.target.value) || null;
    $('delete-platform-button').disabled = !state.platformId || state.deletingPlatform;
    state.registrations = [];
    renderPlatform();
    try { await loadRegistrations(); } catch (error) { toast(error.message, true); }
  });
  $('delete-platform-button').addEventListener('click', async () => {
    const platform = state.platforms.find((item) => item.id === state.platformId);
    if (!platform || state.deletingPlatform) return;
    if (!confirm(`删除平台“${platform.name}”？该平台的邮箱注册状态也会删除，邮箱资料和已保存邮件会保留。`)) return;
    state.deletingPlatform = true;
    $('delete-platform-button').disabled = true;
    try {
      await api('DELETE', `/api/platforms/${platform.id}`, {});
      if (state.platformId === platform.id) {
        state.platformId = null;
        state.registrations = [];
      }
      await loadData();
      toast(`已删除平台“${platform.name}”`);
    } catch (error) { toast(error.message, true); }
    finally {
      state.deletingPlatform = false;
      $('delete-platform-button').disabled = !state.platformId;
    }
  });
  $('detail-refresh').addEventListener('click', async () => {
    const button = $('detail-refresh');
    button.disabled = true;
    try { await refreshMailbox(state.detailId); } finally { button.disabled = false; }
  });
  $('detail-clear').addEventListener('click', async () => {
    const mailbox = state.mailboxes.find((item) => item.id === state.detailId);
    if (!mailbox) return;
    const name = state.detailFolder === 'junk' ? '垃圾邮件' : '收件箱';
    if (!confirm(`确定清空 ${mailbox.email} 的${name}？这会删除微软邮箱中的邮件，无法在本应用中撤销。`)) return;
    const button = $('detail-clear');
    button.disabled = true;
    try {
      const result = await api('POST', `/api/mailboxes/${mailbox.id}/clear`, {
        folder: state.detailFolder, confirmEmail: mailbox.email,
      });
      await loadData();
      await loadMessages();
      toast(`已清空${name}，处理 ${result.deleted} 封邮件`);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  document.querySelectorAll('[data-folder]').forEach((button) => button.addEventListener('click', () => {
    state.detailFolder = button.dataset.folder;
    renderMessages();
  }));
  $('message-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-message-index]');
    if (button) showMessage(Number(button.dataset.messageIndex));
  });
  $('detail-dialog').addEventListener('close', () => { state.detailId = null; });

  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('auth-username').value.trim();
    const password = $('auth-password').value;
    if (!state.initialized && password !== $('auth-confirm').value) return toast('两次输入的密码不一致', true);
    const button = $('auth-submit');
    button.disabled = true;
    try {
      const result = await api('POST', state.initialized ? '/api/auth/login' : '/api/auth/setup', { username, password });
      state.csrf = result.csrfToken;
      state.username = result.username;
      $('admin-name').textContent = result.username;
      $('auth-screen').classList.add('hidden');
      $('app-shell').classList.remove('hidden');
      await loadData();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });

  $('logout-button').addEventListener('click', async () => {
    try { await api('POST', '/api/auth/logout', {}); }
    catch (error) { toast(error.message, true); return; }
    state.csrf = null;
    showAuth(true);
  });

  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('new-password').value !== $('confirm-new-password').value) {
      return toast('两次输入的新密码不一致', true);
    }
    const button = $('password-submit');
    button.disabled = true;
    try {
      const result = await api('POST', '/api/auth/password', {
        currentPassword: $('current-password').value, newPassword: $('new-password').value,
      });
      state.csrf = result.csrfToken;
      closeDialog('password-dialog');
      toast('密码已修改，其他登录会话已退出');
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });

  $('mailbox-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('mailbox-submit');
    button.disabled = true;
    try {
      let message;
      if (state.mailboxMode === 'bulk') {
        let text = $('import-text').value.trim();
        const file = $('import-file').files[0];
        if (!text && file) text = await file.text();
        if (!text) return toast('请先粘贴邮箱内容或选择文件', true);
        const result = await api('POST', '/api/mailboxes/import', { text });
        message = `已导入 ${result.count} 行邮箱`;
      } else {
        const body = { email: $('mailbox-email').value.trim(), clientId: $('mailbox-client').value.trim(), refreshToken: $('mailbox-token').value.trim() };
        if (state.editingId) await api('PUT', `/api/mailboxes/${state.editingId}`, body);
        else await api('POST', '/api/mailboxes', body);
        message = state.editingId ? '邮箱已更新' : '邮箱已添加';
      }
      closeDialog('mailbox-dialog');
      $('mailbox-form').reset();
      await loadData();
      toast(message);
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });

  $('platform-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api('POST', '/api/platforms', { name: $('platform-name').value.trim() });
      $('platform-name-search').value = '';
      state.platformId = result.platform.id;
      closeDialog('platform-dialog');
      $('platform-name').value = '';
      await loadData();
      setPage('platform');
      toast('平台已添加，所有邮箱默认未注册');
    } catch (error) { toast(error.message, true); }
  });

  boot();
})();
