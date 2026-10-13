(() => {
  const authView = document.getElementById('auth-view');
  const appView = document.getElementById('app');
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const authUsername = document.getElementById('auth-username');
  const authPassword = document.getElementById('auth-password');
  const authSubmit = document.getElementById('auth-submit');
  const authError = document.getElementById('auth-error');
  const logoutBtn = document.getElementById('logout-btn');

  const channelListEl = document.getElementById('channel-list');
  const newChInput = document.getElementById('new-ch-input');
  const newChBtn = document.getElementById('new-ch-btn');
  const channelsView = document.getElementById('channels-view');
  const chatView = document.getElementById('chat-view');
  const backBtn = document.getElementById('back-btn');
  const chatTitle = document.getElementById('chat-title');
  const messagesEl = document.getElementById('messages');
  const msgInput = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');

  let mode = 'login';
  let token = localStorage.getItem('token') || null;
  let me = null;
  let ws = null;
  let currentChannelId = null;
  let channels = [];

  tabLogin.addEventListener('click', () => setMode('login'));
  tabRegister.addEventListener('click', () => setMode('register'));
  function setMode(m) {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabRegister.classList.toggle('active', m === 'register');
    authSubmit.textContent = m === 'login' ? 'Войти' : 'Зарегистрироваться';
    authError.textContent = '';
  }

  authSubmit.addEventListener('click', async () => {
    const username = authUsername.value.trim();
    const password = authPassword.value;
    if (!username || !password) {
      authError.textContent = 'Заполни оба поля.';
      return;
    }
    authSubmit.disabled = true;
    authError.textContent = '';
    try {
      const res = await fetch(`/api/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) {
        authError.textContent = humanError(data.error);
        authSubmit.disabled = false;
        return;
      }
      token = data.token;
      me = data.user;
      localStorage.setItem('token', token);
      enterApp();
    } catch (e) {
      authError.textContent = 'Нет связи с сервером.';
    }
    authSubmit.disabled = false;
  });

  function humanError(code) {
    return {
      invalid_input: 'Имя — от 3 символов, пароль — от 4.',
      username_taken: 'Это имя уже занято.',
      bad_credentials: 'Неверное имя или пароль.'
    }[code] || 'Что-то пошло не так.';
  }

  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('token');
    token = null; me = null;
    if (ws) ws.close();
    appView.style.display = 'none';
    authView.style.display = 'flex';
  });

  async function tryAutoLogin() {
    if (!token) return;
    try {
      const res = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) { localStorage.removeItem('token'); token = null; return; }
      const data = await res.json();
      me = data.user;
      enterApp();
    } catch (e) { /* stay on auth screen */ }
  }

  function enterApp() {
    authView.style.display = 'none';
    appView.style.display = 'flex';
    connectWS();
    loadChannels();
  }

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      if (currentChannelId) ws.send(JSON.stringify({ type: 'subscribe', channelId: currentChannelId }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'message' && msg.message.channel_id === currentChannelId) {
        appendMessage(msg.message);
      }
      if (msg.type === 'channel_created') {
        if (!channels.find(c => c.id === msg.channel.id)) {
          channels.push(msg.channel);
          renderChannels();
        }
      }
    });
    ws.addEventListener('close', () => { setTimeout(connectWS, 2000); });
  }

  async function loadChannels() {
    const res = await fetch('/api/channels', { headers: { Authorization: 'Bearer ' + token } });
    const data = await res.json();
    channels = data.channels || [];
    renderChannels();
  }

  function initial(name) { return (name || '#').trim().charAt(0).toUpperCase() || '#'; }

  function renderChannels() {
    channelListEl.innerHTML = '';
    if (!channels.length) {
      channelListEl.innerHTML = '<div class="empty-hint">Пока нет каналов — создай первый ниже.</div>';
      return;
    }
    channels.forEach(c => {
      const row = document.createElement('div');
      row.className = 'channel-row';
      row.innerHTML = `
        <div class="ch-avatar">${initial(c.name)}</div>
        <div class="ch-info">
          <div class="ch-name"></div>
          <div class="ch-last">Нажми, чтобы открыть</div>
        </div>`;
      row.querySelector('.ch-name').textContent = c.name;
      row.addEventListener('click', () => openChannel(c.id, c.name));
      channelListEl.appendChild(row);
    });
  }

  newChBtn.addEventListener('click', async () => {
    const name = newChInput.value.trim();
    if (!name) return;
    newChBtn.disabled = true;
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (res.ok) {
        newChInput.value = '';
        if (!channels.find(c => c.id === data.channel.id)) {
          channels.push(data.channel);
          renderChannels();
        }
      }
    } catch (e) { /* ignore */ }
    newChBtn.disabled = false;
  });
  newChInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') newChBtn.click(); });

  async function openChannel(id, name) {
    currentChannelId = id;
    chatTitle.textContent = name;
    channelsView.style.display = 'none';
    chatView.classList.add('active');
    messagesEl.innerHTML = '<div class="empty-hint">Загрузка…</div>';
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', channelId: id }));

    const res = await fetch(`/api/channels/${id}/messages?limit=100`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    const data = await res.json();
    messagesEl.innerHTML = '';
    if (!data.messages || !data.messages.length) {
      messagesEl.innerHTML = '<div class="empty-hint">Пока тихо. Напиши первым.</div>';
    } else {
      data.messages.forEach(appendMessage);
    }
  }

  backBtn.addEventListener('click', () => {
    chatView.classList.remove('active');
    channelsView.style.display = 'flex';
    currentChannelId = null;
  });

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function appendMessage(m) {
    if (messagesEl.querySelector('.empty-hint')) messagesEl.innerHTML = '';
    const isMe = me && m.author_id === me.id;
    const row = document.createElement('div');
    row.className = 'msg-row ' + (isMe ? 'me' : 'other');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (!isMe) {
      const nameEl = document.createElement('div');
      nameEl.className = 'msg-sender';
      nameEl.style.color = m.color || '#4f9dff';
      nameEl.textContent = m.username || 'Собеседник';
      bubble.appendChild(nameEl);
    }
    const textEl = document.createElement('div');
    textEl.textContent = m.text || '';
    bubble.appendChild(textEl);
    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    timeEl.textContent = fmtTime(m.ts);
    bubble.appendChild(timeEl);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !currentChannelId || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'send', channelId: currentChannelId, text }));
    msgInput.value = '';
    msgInput.style.height = 'auto';
  }
  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(100, msgInput.scrollHeight) + 'px';
  });

  setMode('login');
  tryAutoLogin();
})();
