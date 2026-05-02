// ─── K-Mart CRM Dashboard — Client Logic ───

let authToken = localStorage.getItem('kmart_admin_token');

// ─── Auth ───
async function handleLogin(event) {
    event.preventDefault();
    const username = document.getElementById('login-user').value;
    const password = document.getElementById('login-pass').value;
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Entrando...';
    errorEl.textContent = '';

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error de login');

        authToken = data.token;
        localStorage.setItem('kmart_admin_token', authToken);
        showDashboard();
    } catch (err) {
        errorEl.textContent = err.message;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>Iniciar Sesión</span><i class="fa-solid fa-arrow-right"></i>';
    }
}

function handleLogout() {
    fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
    }).catch(() => {});
    authToken = null;
    localStorage.removeItem('kmart_admin_token');
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('dashboard').classList.add('hidden');
}

function showDashboard() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    loadDashboard();
}

// Auto-login if token exists
if (authToken) {
    // Verify token is still valid
    fetch('/api/analytics/summary', {
        headers: { Authorization: `Bearer ${authToken}` },
    }).then(res => {
        if (res.ok) showDashboard();
        else handleLogout();
    }).catch(() => handleLogout());
}

// ─── API Helper ───
async function api(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
            ...options.headers,
        },
    });
    if (res.status === 401) {
        handleLogout();
        throw new Error('Sesión expirada');
    }
    return res.json();
}

// ─── Navigation ───
function showSection(sectionId, navEl) {
    // Hide all sections
    document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
    document.getElementById(`section-${sectionId}`).classList.remove('hidden');

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (navEl) navEl.classList.add('active');

    // Load section data
    if (sectionId === 'overview') loadDashboard();
    else if (sectionId === 'chats') loadChats();
    else if (sectionId === 'leads') loadLeads();
    else if (sectionId === 'analytics') loadAnalytics();

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.add('hidden');
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    sidebar.classList.toggle('open');
    overlay.classList.toggle('hidden');
}

// ─── Dashboard (Overview) ───
async function loadDashboard() {
    try {
        const [summary, products, categories, timeline] = await Promise.all([
            api('/api/analytics/summary'),
            api('/api/analytics/products?limit=5'),
            api('/api/analytics/categories?limit=5'),
            api('/api/analytics/timeline?days=7'),
        ]);

        // Stats
        animateValue('stat-total-leads', summary.totalLeads);
        animateValue('stat-leads-today', summary.leadsToday);
        animateValue('stat-total-chats', summary.totalChats);
        animateValue('stat-product-queries', summary.totalProductQueries);

        // Top Products
        renderBarChart('top-products-chart', products, 'product_name', 'count', 'orange');

        // Top Categories
        renderBarChart('top-categories-chart', categories, 'category_name', 'count', 'blue');

        // Activity Timeline
        renderActivityChart('activity-chart', timeline);
        
        // Start alert polling
        startAlertPolling();
    } catch (err) {
        console.error('Error loading dashboard:', err);
    }
}

// ─── Alerts Polling ───
let alertPollInterval = null;
function startAlertPolling() {
    if (alertPollInterval) return;
    checkAlerts();
    alertPollInterval = setInterval(checkAlerts, 5000);
}

async function checkAlerts() {
    try {
        const { count } = await api('/api/alerts/count');
        const badge = document.getElementById('nav-alert-badge');
        if (count > 0) {
            badge.textContent = count;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    } catch (e) {}
}

function animateValue(elementId, endVal) {
    const el = document.getElementById(elementId);
    const start = parseInt(el.textContent) || 0;
    const duration = 600;
    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.floor(start + (endVal - start) * eased);
        if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
}

function renderBarChart(containerId, data, nameKey, valueKey, colorClass) {
    const container = document.getElementById(containerId);
    if (!data.length) {
        container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">Sin datos aún</div>';
        return;
    }

    const maxVal = Math.max(...data.map(d => d[valueKey]));
    container.innerHTML = data.map(item => {
        const pct = maxVal > 0 ? (item[valueKey] / maxVal * 100) : 0;
        const name = item[nameKey].length > 22 ? item[nameKey].substring(0, 22) + '…' : item[nameKey];
        return `
            <div class="bar-item">
                <span class="bar-label" title="${item[nameKey]}">${name}</span>
                <div class="bar-track">
                    <div class="bar-fill ${colorClass}" style="width: ${pct}%">${item[valueKey]}</div>
                </div>
            </div>
        `;
    }).join('');
}

function renderActivityChart(containerId, data) {
    const container = document.getElementById(containerId);
    if (!data.length) {
        container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px;">Sin datos aún</div>';
        return;
    }

    const maxVal = Math.max(...data.map(d => d.chats + d.leads + d.queries), 1);
    container.innerHTML = data.map(item => {
        const total = item.chats + item.leads + item.queries;
        const pct = (total / maxVal * 100);
        const day = new Date(item.date).toLocaleDateString('es', { weekday: 'short', day: 'numeric' });
        return `
            <div class="activity-bar" title="${day}: ${total} acciones">
                <div class="activity-bar-fill" style="height: ${Math.max(pct, 3)}%"></div>
                <span class="activity-bar-label">${day}</span>
            </div>
        `;
    }).join('');
}

// ─── Leads ───
async function loadLeads() {
    try {
        const status = document.getElementById('lead-filter-status').value;
        const params = status ? `?status=${status}` : '';
        const leads = await api(`/api/leads${params}`);
        renderLeadsTable(leads);
    } catch (err) {
        console.error('Error loading leads:', err);
    }
}

function renderLeadsTable(leads) {
    const tbody = document.getElementById('leads-tbody');
    if (!leads.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fa-solid fa-inbox"></i> No hay leads aún</td></tr>';
        return;
    }

    tbody.innerHTML = leads.map(lead => {
        const date = new Date(lead.created_at).toLocaleDateString('es', {
            day: '2-digit', month: 'short', year: 'numeric'
        });
        const statusClass = `status-${lead.status}`;
        const statusLabels = { nuevo: '🟢 Nuevo', contactado: '🔵 Contactado', convertido: '🟣 Convertido', descartado: '⚫ Descartado' };
        const channelIcons = { web: '🌐', telegram: '📱', whatsapp: '💬', manual: '✍️' };

        return `
            <tr>
                <td><strong>${lead.first_name}</strong> ${lead.last_name || ''}</td>
                <td>${lead.email || '<span style="color:var(--text-muted)">—</span>'}</td>
                <td>${lead.phone || '<span style="color:var(--text-muted)">—</span>'}</td>
                <td><span class="channel-badge">${channelIcons[lead.channel] || ''} ${lead.channel}</span></td>
                <td><span class="status-badge ${statusClass}">${statusLabels[lead.status] || lead.status}</span></td>
                <td>${date}</td>
                <td>
                    <div class="table-actions">
                        <button onclick="editLead(${lead.id})" title="Editar"><i class="fa-solid fa-pen"></i></button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// ─── Lead Modal ───
function showLeadModal(leadId = null) {
    const modal = document.getElementById('lead-modal');
    const title = document.getElementById('modal-title');
    const form = document.getElementById('lead-form');

    form.reset();
    document.getElementById('lead-edit-id').value = '';

    if (leadId) {
        title.innerHTML = '<i class="fa-solid fa-pen"></i> Editar Lead';
    } else {
        title.innerHTML = '<i class="fa-solid fa-user-plus"></i> Nuevo Lead';
    }

    modal.classList.remove('hidden');
}

function closeLeadModal() {
    document.getElementById('lead-modal').classList.add('hidden');
}

async function editLead(id) {
    try {
        const lead = await api(`/api/leads/${id}`);
        document.getElementById('lead-edit-id').value = id;
        document.getElementById('lead-firstname').value = lead.first_name || '';
        document.getElementById('lead-lastname').value = lead.last_name || '';
        document.getElementById('lead-email').value = lead.email || '';
        document.getElementById('lead-phone').value = lead.phone || '';
        document.getElementById('lead-channel').value = lead.channel || 'web';
        document.getElementById('lead-status').value = lead.status || 'nuevo';
        document.getElementById('lead-notes').value = lead.notes || '';
        showLeadModal(id);
    } catch (err) {
        console.error('Error loading lead:', err);
    }
}

async function handleLeadSubmit(event) {
    event.preventDefault();
    const editId = document.getElementById('lead-edit-id').value;
    const data = {
        first_name: document.getElementById('lead-firstname').value,
        last_name: document.getElementById('lead-lastname').value,
        email: document.getElementById('lead-email').value,
        phone: document.getElementById('lead-phone').value,
        channel: document.getElementById('lead-channel').value,
        status: document.getElementById('lead-status').value,
        notes: document.getElementById('lead-notes').value,
    };

    try {
        if (editId) {
            await api(`/api/leads/${editId}`, { method: 'PUT', body: JSON.stringify(data) });
        } else {
            await api('/api/leads', { method: 'POST', body: JSON.stringify(data) });
        }
        closeLeadModal();
        loadLeads();
    } catch (err) {
        console.error('Error saving lead:', err);
    }
}

// ─── Analytics ───
async function loadAnalytics() {
    try {
        const [products, categories, timeline] = await Promise.all([
            api('/api/analytics/products?limit=15'),
            api('/api/analytics/categories?limit=10'),
            api('/api/analytics/timeline?days=30'),
        ]);

        renderRankingList('analytics-products', products, 'product_name', 'count');
        renderRankingList('analytics-categories', categories, 'category_name', 'count');
        renderActivityChart('analytics-timeline', timeline);
    } catch (err) {
        console.error('Error loading analytics:', err);
    }
}

function renderRankingList(containerId, data, nameKey, valueKey) {
    const container = document.getElementById(containerId);
    if (!data.length) {
        container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:30px;"><i class="fa-solid fa-chart-simple"></i><br>Sin datos aún</div>';
        return;
    }

    container.innerHTML = data.map((item, i) => {
        const posClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : 'default';
        return `
            <div class="ranking-item">
                <span class="ranking-pos ${posClass}">${i + 1}</span>
                <span class="ranking-name" title="${item[nameKey]}">${item[nameKey]}</span>
                <span class="ranking-count">${item[valueKey]}</span>
            </div>
        `;
    }).join('');
}

// ─── Live Chat Module ───
let currentChatSession = null;
let chatPollInterval = null;
let lastKnownMsgId = 0;
let isTakenOver = false;

async function loadChats() {
    try {
        const sessions = await api('/api/chats');
        renderSessionList(sessions);
    } catch (err) {
        console.error('Error loading chats:', err);
    }
}

function renderSessionList(sessions) {
    const container = document.getElementById('chat-sessions-list');
    if (!sessions.length) {
        container.innerHTML = '<div class="empty-state" style="padding:40px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-inbox"></i><br>No hay sesiones de chat</div>';
        return;
    }

    container.innerHTML = sessions.map(s => {
        const channelIcons = { web: 'fa-globe', telegram: 'fa-telegram', whatsapp: 'fa-whatsapp' };
        const icon = channelIcons[s.channel] || 'fa-comment';
        const iconPrefix = s.channel === 'telegram' || s.channel === 'whatsapp' ? 'fa-brands' : 'fa-solid';
        const name = s.lead_name || s.user_id.substring(0, 16);
        const preview = s.last_message ? s.last_message.substring(0, 40) + (s.last_message.length > 40 ? '...' : '') : 'Sin mensajes';
        const time = s.last_message_at ? new Date(s.last_message_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
        const activeClass = currentChatSession === s.id ? 'active' : '';
        const takenClass = s.is_taken_over ? 'taken-over' : '';

        return `
            <div class="session-item ${activeClass} ${takenClass}" onclick="openChatSession('${s.id}', '${name}', '${s.channel}', ${s.is_taken_over})">
                <div class="session-avatar ${s.channel}"><i class="${iconPrefix} ${icon}"></i></div>
                <div class="session-info">
                    <div class="session-name">${name}</div>
                    <div class="session-preview">${preview}</div>
                </div>
                <div class="session-meta">
                    <span class="session-time">${time}</span>
                    ${s.alert_count > 0 ? '<span class="session-badge alert">¡AGENTE REQUERIDO!</span>' : 
                      (s.is_taken_over ? '<span class="session-badge live">EN VIVO</span>' : `<span class="session-badge msg-count">${s.message_count} msgs</span>`)}
                </div>
            </div>
        `;
    }).join('');
}

async function openChatSession(sessionId, name, channel, takenOver) {
    currentChatSession = sessionId;
    isTakenOver = !!takenOver;

    // Show header
    document.querySelector('.admin-chat-empty').style.display = 'none';
    document.getElementById('admin-chat-header').classList.remove('hidden');
    document.getElementById('admin-chat-messages').classList.remove('hidden');
    document.getElementById('admin-chat-name').textContent = name;
    document.getElementById('admin-chat-channel').textContent = channel;

    updateTakeoverUI();

    // Mark active in list
    document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
    event?.target?.closest?.('.session-item')?.classList.add('active');

    // Dismiss alerts for this session (optimistic UI update)
    const sessionBadge = event?.target?.closest?.('.session-item')?.querySelector('.session-badge.alert');
    if (sessionBadge) {
        sessionBadge.outerHTML = '<span class="session-badge msg-count">...</span>';
        api(`/api/chats/${sessionId}/takeover`, { method: 'POST' }).then(() => checkAlerts()).catch(()=>{});
        isTakenOver = true;
        updateTakeoverUI();
    }

    // Load messages
    try {
        const messages = await api(`/api/chats/${sessionId}/messages`);
        renderChatMessages(messages);
        if (messages.length > 0) {
            lastKnownMsgId = messages[messages.length - 1].id;
        }
    } catch (err) {
        console.error('Error loading messages:', err);
    }

    // Start polling
    startChatPolling();
}

function updateTakeoverUI() {
    const btnTakeover = document.getElementById('btn-takeover');
    const btnRelease = document.getElementById('btn-release');
    const chatInput = document.getElementById('admin-chat-input');

    if (isTakenOver) {
        btnTakeover.classList.add('hidden');
        btnRelease.classList.remove('hidden');
        chatInput.classList.remove('hidden');
    } else {
        btnTakeover.classList.remove('hidden');
        btnRelease.classList.add('hidden');
        chatInput.classList.add('hidden');
    }
}

function renderChatMessages(messages) {
    const container = document.getElementById('admin-chat-messages');
    const roleLabels = { user: '👤 Usuario', assistant: '🤖 IA', admin: '🧑‍💼 Agente' };

    container.innerHTML = messages.map(msg => {
        const time = new Date(msg.created_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
        const content = msg.content.length > 500 ? msg.content.substring(0, 500) + '...' : msg.content;
        return `
            <div class="admin-msg ${msg.role}">
                <div class="msg-role">${roleLabels[msg.role] || msg.role}</div>
                <div>${content}</div>
                <div class="msg-time">${time}</div>
            </div>
        `;
    }).join('');

    container.scrollTop = container.scrollHeight;
}

function appendNewMessages(messages) {
    const container = document.getElementById('admin-chat-messages');
    const roleLabels = { user: '👤 Usuario', assistant: '🤖 IA', admin: '🧑‍💼 Agente' };

    messages.forEach(msg => {
        const time = new Date(msg.created_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
        const div = document.createElement('div');
        div.className = `admin-msg ${msg.role}`;
        div.innerHTML = `
            <div class="msg-role">${roleLabels[msg.role] || msg.role}</div>
            <div>${msg.content}</div>
            <div class="msg-time">${time}</div>
        `;
        container.appendChild(div);
        lastKnownMsgId = msg.id;
    });

    container.scrollTop = container.scrollHeight;
}

function startChatPolling() {
    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(async () => {
        if (!currentChatSession) return;
        try {
            const newMsgs = await api(`/api/chats/${currentChatSession}/poll?after=${lastKnownMsgId}`);
            if (newMsgs.length > 0) {
                appendNewMessages(newMsgs);
            }
        } catch (e) {}
    }, 2000);
}

async function handleTakeover() {
    if (!currentChatSession) return;
    try {
        await api(`/api/chats/${currentChatSession}/takeover`, { method: 'POST' });
        isTakenOver = true;
        updateTakeoverUI();
        // Reload messages to show takeover notification
        const messages = await api(`/api/chats/${currentChatSession}/messages`);
        renderChatMessages(messages);
        if (messages.length > 0) lastKnownMsgId = messages[messages.length - 1].id;
        // Reload session list
        loadChats();
    } catch (err) {
        console.error('Error taking over:', err);
    }
}

async function handleRelease() {
    if (!currentChatSession) return;
    try {
        await api(`/api/chats/${currentChatSession}/release`, { method: 'POST' });
        isTakenOver = false;
        updateTakeoverUI();
        const messages = await api(`/api/chats/${currentChatSession}/messages`);
        renderChatMessages(messages);
        if (messages.length > 0) lastKnownMsgId = messages[messages.length - 1].id;
        loadChats();
    } catch (err) {
        console.error('Error releasing:', err);
    }
}

async function sendAdminMessage() {
    const input = document.getElementById('admin-msg-input');
    const message = input.value.trim();
    if (!message || !currentChatSession) return;

    input.value = '';

    try {
        await api(`/api/chats/${currentChatSession}/send`, {
            method: 'POST',
            body: JSON.stringify({ message }),
        });
        // Message will appear via polling
    } catch (err) {
        console.error('Error sending admin message:', err);
        input.value = message;
    }
}
