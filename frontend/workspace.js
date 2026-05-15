/* ── FYNZA Workspace JS ── */
const API = 'http://127.0.0.1:8000';
const hashParams = new URLSearchParams(window.location.hash.substring(1));
const tokenFromHash = hashParams.get("token");
if (tokenFromHash && tokenFromHash.trim()) {
  localStorage.setItem("token", tokenFromHash);
  window.history.replaceState(null, null, 'workspace.html');
}
const token = localStorage.getItem('token');
if (!token) location.href = 'home.html';


const hdr = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
let currentWS = null, currentCH = null, ws = null;
let replyDraft = null, selectedFile = null, isSelfDestruct = false;
let wsContextTarget = null;
let checkmarkSyncInterval = null;
const QUICK_REACTIONS = ['❤️','👍','😂','🔥','👏'];
const EMOJI_GRID = ['😀','😂','🥰','😍','😎','🤔','👍','👎','🙏','🔥','✨','💯','❤️','💙','🎉','🚀','⭐','📌','✅','⚠️','😢','😮','🤝','👋'];
function fmt(s){if(!s||!isFinite(s))return'0:00';return Math.floor(s/60)+':'+(Math.floor(s%60)).toString().padStart(2,'0');}

/* ── API helpers ── */
async function api(path, opts = {}) {
  const r = await fetch(API + path, { headers: hdr, ...opts });
  if (r.status === 401) { localStorage.clear(); location.href = 'home.html'; }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || r.statusText); }
  return r.json();
}

/* ── Load workspaces ── */
async function loadWorkspaces() {
  const list = await api('/workspaces/mine');
  const el = document.getElementById('wsList');
  if (!list.length) {
    el.innerHTML = '<div class="ws-empty">No workspaces yet.<br>Create one to get started!</div>';
    return;
  }
  el.innerHTML = list.map(w => {
    let iconHtml = `<div class="ws-item-icon">${w.name[0].toUpperCase()}</div>`;
    if (w.image) {
      iconHtml = `<div class="ws-item-icon" style="background:transparent;"><img src="${w.image}" style="width:100%;height:100%;border-radius:12px;object-fit:cover;"></div>`;
    }
    return `
    <div class="ws-item ${currentWS && currentWS.id === w.id ? 'active' : ''}" onclick="selectWorkspace(${w.id})" title="${w.name}">
      ${iconHtml}
      <div class="ws-item-name">${w.name}</div>
    </div>
  `}).join('');
}

/* ── Select workspace ── */
async function selectWorkspace(id) {
  const list = await api('/workspaces/mine');
  currentWS = list.find(w => w.id === id);
  if (!currentWS) return;
  localStorage.setItem('ws_id', id);
  localStorage.removeItem('ch_id');
  document.getElementById('wsName').textContent = currentWS.name;
  document.getElementById('wsRole').textContent = currentWS.my_role;
  loadWorkspaces();
  loadChannels();
  document.getElementById('channelPanel').classList.remove('d-none');
  document.getElementById('emptyMain').classList.add('d-none');
  
  // Show/hide WS admin buttons based on role
  const wsImageBtn = document.getElementById('wsImageBtn');
  const wsEditNameBtn = document.getElementById('wsEditNameBtn');
  const isWsAdmin = currentWS.my_role === 'owner' || currentWS.my_role === 'admin';
  if (wsImageBtn) wsImageBtn.style.display = isWsAdmin ? '' : 'none';
  if (wsEditNameBtn) wsEditNameBtn.style.display = isWsAdmin ? '' : 'none';
}

/* ── Load channels ── */
async function loadChannels() {
  if (!currentWS) return;
  const list = await api('/channels/workspace/' + currentWS.id);
  const el = document.getElementById('chList');
  el.innerHTML = list.map(c => {
    // unread_count comes directly from the server (accurate per-user count)
    const unread = (currentCH && currentCH.id === c.id) ? 0 : (c.unread_count || 0);
    return `
      <div class="ch-item ${currentCH && currentCH.id === c.id ? 'active' : ''}" onclick="openChannel(${c.id})">
        <span class="ch-hash">${c.is_private ? '<i class="fa-solid fa-lock"></i>' : '#'}</span>
        <span class="ch-name">${c.name}</span>
        ${unread > 0 ? `<span class="ch-count">${unread}</span>` : ''}
      </div>
    `;
  }).join('');
}

/* ── Open channel + WebSocket ── */
async function openChannel(id) {
  if (ws) { ws.close(); ws = null; }
  if (checkmarkSyncInterval) { clearInterval(checkmarkSyncInterval); checkmarkSyncInterval = null; }
  const chans = await api('/channels/workspace/' + currentWS.id);
  currentCH = chans.find(c => c.id === id);
  if (!currentCH) return;

  localStorage.setItem('ch_id', id);
  document.getElementById('chTitle').textContent = '#' + currentCH.name;
  document.getElementById('chDesc').textContent = currentCH.description || '';

  // Load channel avatar
  try {
    const chInfo = await api('/channels/' + id + '/info');
    const avatarEl = document.getElementById('chAvatar');
    if (chInfo.image) {
      avatarEl.innerHTML = `<img src="${chInfo.image}" alt="">`;
    } else {
      avatarEl.innerHTML = `<span id="chAvatarLetter">${currentCH.name[0].toUpperCase()}</span>`;
    }
  } catch(e) { console.error('Channel info error', e); }

  const area = document.getElementById('msgArea');
  area.innerHTML = '';
  document.getElementById('chatPanel').classList.remove('d-none');
  document.getElementById('emptyMain').classList.add('d-none');

  // Load message history
  const msgs = await api('/channels/' + id + '/messages?limit=80');
  msgs.forEach(m => appendWSMessage(m));
  area.scrollTop = area.scrollHeight;
  updateScrollFab();

  // Mark channel as read on server (clears badge)
  api('/channels/' + id + '/mark-read', { method: 'POST' }).catch(() => {});
  
  // Show/hide channel edit button
  const editCHBtn = document.getElementById('editCHBtn');
  if (editCHBtn) {
    const isWsAdmin = currentWS && (currentWS.my_role === 'owner' || currentWS.my_role === 'admin');
    const isCreator = currentCH.created_by && currentCH.created_by.toLowerCase() === currentUserEmail.toLowerCase();
    if (isWsAdmin || isCreator) {
      editCHBtn.classList.remove('d-none');
    } else {
      editCHBtn.classList.add('d-none');
    }
  }

  // Check membership to show/hide join button

  try {
    const members = await api('/channels/' + id + '/members');
    const myEmail = (currentUserEmail || "").toLowerCase();
    const isMember = members.some(m => m.email.toLowerCase() === myEmail);
    const chatForm = document.getElementById('chatForm');
    const joinPanel = document.getElementById('joinPanel');
    
    if (isMember) {
      if (chatForm) chatForm.classList.remove('d-none');
      if (joinPanel) joinPanel.classList.add('d-none');
    } else {
      if (chatForm) chatForm.classList.add('d-none');
      if (joinPanel) joinPanel.classList.remove('d-none');
    }
  } catch (e) {
    console.error("Membership check failed", e);
  }

  loadChannels();

  // WebSocket
  ws = new WebSocket('ws://127.0.0.1:8000/channels/' + id + '/ws?token=' + token);
  ws.onopen = () => {
    // Broadcast to others that we've read the history
    if (msgs.length > 0) {
      const lastMsg = msgs[msgs.length - 1];
      ws.send(JSON.stringify({ type: 'read', msg_id: lastMsg.id }));
    }
  };
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'message') { 
      appendWSMessage(d); 
      area.scrollTop = area.scrollHeight; 
      updateScrollFab(); 
      // Mark read on server since we are actively viewing this channel
      api('/channels/' + id + '/mark-read', { method: 'POST' }).catch(() => {});
      
      if (d.sender !== currentUserEmail && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'read', msg_id: d.id }));
      }
    }
    else if (d.type === 'typing') showTyping(d.display_name);
    else if (d.type === 'webrtc' && d.from !== currentUserEmail) handleWSWebRTC(d.from, d.signal);
    else if (d.type === 'read_receipt' || d.type === 'delivery_receipt') syncOutgoingCheckmarks();
  };
  ws.onclose = () => { 
    ws = null; 
    if (checkmarkSyncInterval) { clearInterval(checkmarkSyncInterval); checkmarkSyncInterval = null; }
  };

  // Sync checkmarks periodically to catch delivery updates from users polling list_channels
  checkmarkSyncInterval = setInterval(syncOutgoingCheckmarks, 3000);
}


// Extract current user email from token
let currentUserEmail = "";
if (token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    currentUserEmail = payload.sub || payload.email || "";
  } catch(e) { console.error("Token parse error", e); }
}

/* ── Media Helpers ── */
window.wsDownloadFile = function(name, data) {
  if (!data) return alert("File data missing");
  const link = document.createElement('a');
  link.href = data;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

window.wsPlayAudio = function(id, duration) {
  const audio = document.getElementById('realAudio_' + id);
  const btn = document.getElementById('playBtn_' + id);
  const bar = document.getElementById('progBar_' + id);
  const time = document.getElementById('time_' + id);
  if (!audio || !btn) return;

  if (audio.paused) {
    audio.play();
    btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    
    const update = () => {
      if (audio.paused || audio.ended) return;
      const p = (audio.currentTime / audio.duration) * 100;
      if (bar) bar.style.width = p + '%';
      if (time) time.textContent = fmt(Math.floor(audio.currentTime));
      requestAnimationFrame(update);
    };
    requestAnimationFrame(update);

    audio.onended = () => {
      btn.innerHTML = '<i class="fa-solid fa-play"></i>';
      if (bar) bar.style.width = '0%';
      if (time) time.textContent = fmt(duration);
    };
  } else {
    audio.pause();
    btn.innerHTML = '<i class="fa-solid fa-play"></i>';
  }
};

window.wsSeekAudio = function(e, id, duration) {
  const audio = document.getElementById('realAudio_' + id);
  if (!audio) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const p = x / rect.width;
  audio.currentTime = p * audio.duration;
};

function syncOutgoingCheckmarks() {
  if (!currentCH) return;
  api('/channels/' + currentCH.id + '/messages?limit=50').then(msgs => {
      msgs.forEach(m => {
          const row = document.getElementById('msg-' + m.id);
          if (row && row.classList.contains('chat-bubble-row--me')) {
              const totalOthers = (m.member_count || 1) - 1;
              const allRead = totalOthers > 0 && m.read_by_count >= totalOthers;
              const anyDelivered = m.delivered_by_count > 0 || allRead;
              const debugInfo = `totalOthers:${totalOthers}, read:${m.read_by_count}, del:${m.delivered_by_count}, mem:${m.member_count}`;
              
              const meta = row.querySelector('.chat-bubble-meta');
              if (meta) {
                  const tick = meta.querySelector('i.bi');
                  if (tick) {
                      tick.className = "bi " + (allRead ? "bi-check-all chat-tick--read" : (anyDelivered ? "bi-check-all chat-tick" : "bi-check chat-tick"));
                      tick.style.color = allRead ? "#34B7F1" : "#aaa";
                      tick.title = debugInfo;
                  }
              }
              const imgMeta = row.querySelector('.chat-bubble-body > div > div > i.bi');
              if (imgMeta) {
                  imgMeta.className = "bi " + (allRead ? "bi-check-all chat-tick--read" : (anyDelivered ? "bi-check-all chat-tick" : "bi-check chat-tick"));
                  imgMeta.style.color = allRead ? "#34B7F1" : "#aaa";
                  imgMeta.title = debugInfo;
              }
          }
      });
  }).catch(() => {});
}

/* ── Append Message (DOM-based, full features) ── */
function appendWSMessage(m) {
  const area = document.getElementById('msgArea');
  const senderEmail = m.sender;
  const isMe = senderEmail === currentUserEmail;
  const name = m.display_name || senderEmail;
  const rawTime = m.created_at || new Date().toISOString();
  
  let text = m.content || '';
  let reply = m.thread_id ? { preview: "Thread reply", authorName: "Channel" } : null; // simplified thread reply visual
  
  const row = document.createElement("div");
  row.className = "chat-bubble-row " + (isMe ? "chat-bubble-row--me" : "chat-bubble-row--them");
  row.dataset.sender = senderEmail;
  row.id = 'msg-' + m.id;
  row.dataset.msgId = m.id;

  // We can inject a small avatar for them in channels just before the bubble if not me
  if (!isMe) {
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.style.width = '28px'; av.style.height = '28px'; av.style.fontSize = '12px'; av.style.marginRight = '8px'; av.style.alignSelf = 'flex-end';
    if (m.avatar) { av.style.background='transparent'; av.innerHTML=`<img src="${m.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`; av.onclick=()=>viewProfile(m.sender,name); }
    else { av.textContent=name[0].toUpperCase(); av.onclick=()=>viewProfile(m.sender,name); }
    row.appendChild(av);
  }

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.style.wordBreak = "break-word";

  if (reply) {
    const q = document.createElement("div");
    q.className = "chat-reply-quote";
    q.innerHTML =
        '<div class="chat-reply-quote__bar"></div><div class="chat-reply-quote__body">' +
        '<span class="chat-reply-quote__who">' + escHTML(name) + "</span>" +
        '<span class="chat-reply-quote__txt">Replied to thread</span></div>';
    bubble.appendChild(q);
    bubble.classList.add('has-reply');
  }

  const body = document.createElement("div");
  body.className = "chat-bubble-body";
  
  let processedText = text;
  let isSelfDestructing = false;
  
  if (processedText.includes("⏳ [Self-Destructing]")) {
      isSelfDestructing = true;
      processedText = processedText.replace("⏳ [Self-Destructing]\n", "").replace("⏳ [Self-Destructing]", "");
      bubble.style.border = "1px solid #ff3333";
      bubble.style.boxShadow = "0 0 10px rgba(255,51,51,0.2)";
  }
  
  if (processedText.startsWith("🎤 [Voice Note")) {
      const parts = processedText.split('\n');
      const match = parts[0].match(/Voice Note (\d+)s/);
      const duration = match ? parseInt(match[1]) : 0;
      const base64Audio = parts[1] ? parts[1].trim() : null;
      const audioId = 'audio_' + Math.random().toString(36).substr(2, 9);
      let audioTag = '';
      if (base64Audio && base64Audio.startsWith('data:audio')) {
          audioTag = `<audio id="realAudio_${audioId}" src="${base64Audio}" preload="metadata"></audio>`;
      }
      body.innerHTML = `
          ${audioTag}
          <div style="display:flex; align-items:center; gap:10px; background:rgba(0,0,0,0.2); padding:8px 12px; border-radius:20px; min-width:200px;">
              <button id="playBtn_${audioId}" onclick="window.wsPlayAudio('${audioId}', ${duration})" style="background:var(--accent-color); color:#000; border:none; width:35px; height:35px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                  <i class="fa-solid fa-play"></i>
              </button>
              <div onclick="window.wsSeekAudio(event, '${audioId}', ${duration})" style="flex:1; height:4px; background:rgba(255,255,255,0.2); border-radius:2px; position:relative; cursor:pointer;">
                  <div id="progBar_${audioId}" style="position:absolute; left:0; top:0; height:100%; width:0%; background:var(--accent-color); border-radius:2px;"></div>
              </div>
              <span id="time_${audioId}" style="font-size:0.8rem; min-width:32px; text-align:right;">${fmt(duration)}</span>
          </div>
      `;
  } else if (processedText.trim().includes("📎 [Attached:")) {
      const filenameMatch = processedText.match(/📎 \[Attached: (.*?)\]/);
      const filename = filenameMatch ? filenameMatch[1] : "Unknown File";
      let remainingText = processedText.replace(`📎 [Attached: ${filename}]`, "").trim();
      let fileData = "";
      const dataMatch = remainingText.match(/^(data:.*?base64,[^\s]+)/);
      if (dataMatch) {
          fileData = dataMatch[1];
          remainingText = remainingText.replace(fileData, "").trim();
      }
      const isImage = filename.match(/\.(jpeg|jpg|gif|png|webp)$/i);
      
      if (isImage) {
          const imgSrc = fileData || `https://via.placeholder.com/400?text=${encodeURIComponent(filename)}`;
          bubble.style.padding = '0';
          bubble.style.background = 'transparent';
          bubble.style.border = 'none';
          bubble.style.overflow = 'hidden';
          
          const dateObj = new Date(rawTime);
          const timeStr = dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const totalOthers = (m.member_count || 1) - 1;
          const allRead = totalOthers > 0 && m.read_by_count >= totalOthers;
          const anyDelivered = m.delivered_by_count > 0 || allRead;
          const debugInfo = `totalOthers:${totalOthers}, read:${m.read_by_count}, del:${m.delivered_by_count}, mem:${m.member_count}`;
          let tickIcon = '';
          if (isMe) {
              if (allRead) tickIcon = `<i class="bi bi-check-all" style="color:#34B7F1" title="${debugInfo}"></i>`;
              else if (anyDelivered) tickIcon = `<i class="bi bi-check-all" style="color:#aaa" title="${debugInfo}"></i>`;
              else tickIcon = `<i class="bi bi-check" style="color:#aaa" title="${debugInfo}"></i>`;
          }
          const tickMark = tickIcon;
          
          body.innerHTML = `
              <div onclick="window.wsDownloadFile('${filename}', '${fileData}')" style="position: relative; cursor:pointer; width: 100%;">
                  <img src="${imgSrc}" style="width: 100%; max-height: 300px; object-fit: cover; display: block; border-radius: 12px;" />
                  <div style="position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.5); color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 0.7rem; display: flex; align-items: center; gap: 4px; backdrop-filter: blur(4px);">${timeStr}${tickMark}</div>
              </div>
          ` + (remainingText ? `<div style="padding: 10px; color: var(--text-main);">${escHTML(remainingText)}</div>` : '');
      } else {
          body.innerHTML = `
              <div onclick="window.wsDownloadFile('${filename}', '${fileData}')" style="display:flex; align-items:center; gap:10px; background:rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); padding:10px; border-radius:8px; cursor:pointer;">
                  <i class="fa-solid fa-file-lines" style="font-size:1.5rem;"></i>
                  <div style="flex:1; overflow:hidden; font-size:0.9rem; font-weight:bold; white-space:nowrap; text-overflow:ellipsis;">${escHTML(filename)}</div>
                  <i class="fa-solid fa-download"></i>
              </div>
          ` + (remainingText ? escHTML(remainingText) : '');
      }
  } else {
      body.textContent = processedText;
  }

  // Define meta and time
  const meta = document.createElement("div");
  meta.className = "chat-bubble-meta";
  const dateObj = new Date(rawTime);
  const displayTime = dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tick = document.createElement("i");
  const totalOthers = (m.member_count || 1) - 1;
  const allRead = totalOthers > 0 && m.read_by_count >= totalOthers;
  const anyDelivered = m.delivered_by_count > 0 || allRead;
  const debugInfo = `totalOthers:${totalOthers}, read:${m.read_by_count}, del:${m.delivered_by_count}, mem:${m.member_count}`;
  if (isMe) {
      if (allRead) { tick.className = "bi bi-check-all chat-tick--read"; tick.style.color = "#34B7F1"; }
      else if (anyDelivered) { tick.className = "bi bi-check-all chat-tick"; tick.style.color = "#aaa"; }
      else { tick.className = "bi bi-check chat-tick"; tick.style.color = "#aaa"; }
      tick.title = debugInfo;
  }
  meta.appendChild(document.createElement("span")).textContent = displayTime;
  if (isMe) meta.appendChild(tick);

  // Name at top for others
  if (!isMe) {
    const authNode = document.createElement("div");
    authNode.style.cssText = "font-size:0.8rem; color:var(--accent-color); margin-bottom:4px; font-weight:bold; cursor:pointer; padding: 2px 12px; display:flex; align-items:center; gap:5px;";
    authNode.innerHTML = `<span>${escHTML(name)}</span><span class="status-dot pulse-green"></span>`;
    authNode.onclick = () => viewProfile(m.sender, name);
    bubble.appendChild(authNode);
    bubble.style.flexDirection = "column";
    bubble.style.alignItems = "stretch";
    bubble.style.padding = "8px 0";
  }

  const contentRow = document.createElement("div");
  contentRow.style.display = "flex";
  contentRow.style.flexDirection = isMe ? "row-reverse" : "row";
  contentRow.style.alignItems = "flex-end";
  contentRow.style.gap = "8px";
  contentRow.style.padding = isMe ? "0 4px 4px 10px" : "0 10px 4px 12px";
  
  contentRow.appendChild(body);
  const hasOverlay = body.innerHTML.includes('position:relative') || body.innerHTML.includes('position: relative');
  if (!hasOverlay) contentRow.appendChild(meta);

  bubble.appendChild(contentRow);
  row.appendChild(bubble);
  const reactRow = document.createElement("div");
  reactRow.className = "chat-reactions";
  const chips = document.createElement("div");
  chips.className = "chat-reaction-chips";
  reactRow.appendChild(chips);
  
  const toolbar = document.createElement("div");
  toolbar.className = "chat-reactions__toolbar";
  
  bubble.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".chat-reactions__toolbar.show").forEach(t => t.classList.remove("show"));
      toolbar.classList.add("show");
  });
  QUICK_REACTIONS.forEach((emo) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chat-reaction-pill";
      b.textContent = emo;
      b.title = "React";
      b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          addWSReaction(chips, emo);
          toolbar.classList.remove("show");
      });
      toolbar.appendChild(b);
  });
  reactRow.appendChild(toolbar);
  row.appendChild(reactRow);

  row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openWSContextMenu(e.clientX, e.clientY, text, m.id);
  });

  area.appendChild(row);
  scrollToBottom();
}

function addWSReaction(chips,emo) {
  let ex=chips.querySelector(`[data-emo="${emo}"]`);
  if(ex){let c=parseInt(ex.dataset.count||'1')+1;ex.dataset.count=c;ex.textContent=emo+' '+c;}
  else{const ch=document.createElement('span');ch.className='msg-reaction-chip';ch.dataset.emo=emo;ch.dataset.count='1';ch.textContent=emo+' 1';ch.onclick=()=>addWSReaction(chips,emo);chips.appendChild(ch);}
}

/* ── Context Menu ── */
function openWSContextMenu(x,y,text,msgId) {
  wsContextTarget={text,msgId};
  const menu=document.getElementById('wsContextMenu');
  menu.classList.remove('d-none');
  menu.style.left=Math.min(x,window.innerWidth-180)+'px';
  menu.style.top=Math.min(y,window.innerHeight-160)+'px';
}
function closeWSContextMenu(){document.getElementById('wsContextMenu')?.classList.add('d-none');wsContextTarget=null;}
document.getElementById('wsCtxReply')?.addEventListener('click',()=>{if(!wsContextTarget)return;setReply({preview:wsContextTarget.text.slice(0,80),authorName:'Channel'});closeWSContextMenu();});
document.getElementById('wsCtxCopy')?.addEventListener('click',()=>{if(!wsContextTarget)return;navigator.clipboard.writeText(wsContextTarget.text).catch(()=>{});closeWSContextMenu();});
document.getElementById('wsCtxPin')?.addEventListener('click',async()=>{if(!wsContextTarget||!currentCH)return;try{await api(`/channels/${currentCH.id}/pin/${wsContextTarget.msgId}`,{method:'POST'});const pb=document.getElementById('wsPinnedBar');const pt=document.getElementById('wsPinnedText');if(pb&&pt){pt.textContent=wsContextTarget.text.slice(0,60);pb.classList.remove('d-none');}}catch(e){}closeWSContextMenu();});
document.getElementById('wsCtxInfo')?.addEventListener('click', async () => {
  if (!wsContextTarget) return;
  const mid = wsContextTarget.msgId;
  closeWSContextMenu();
  const list = document.getElementById('msgReadByList');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;">Loading...</div>';
  toggleModal('messageInfoModal');
  try {
    const data = await api('/messages/' + mid + '/read_receipts');
    if (!data || data.length === 0) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;">No other members.</div>';
    } else {
      let html = '<div style="font-size:0.85rem; font-weight:bold; color:#34B7F1; margin-bottom:5px;">Read by</div>';
      const readers = data.filter(r => r.is_read);
      if (readers.length === 0) html += '<div style="color:var(--text-muted);font-size:0.8rem;margin-bottom:10px;">Nobody</div>';
      readers.forEach(r => {
        html += `
        <div style="display:flex;align-items:center;gap:10px;padding:6px;background:rgba(255,255,255,0.05);border-radius:6px;margin-bottom:4px;">
          <div style="width:28px;height:28px;background:var(--accent-color);color:#000;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:0.75rem;">
            ${(r.display_name || r.user_email || 'U')[0].toUpperCase()}
          </div>
          <div style="font-size:0.85rem;font-weight:600;">${r.display_name || r.user_email}</div>
        </div>`;
      });
      html += '<div style="font-size:0.85rem; font-weight:bold; color:#aaa; margin-top:10px; margin-bottom:5px;">Delivered to</div>';
      const deliverers = data.filter(r => r.is_delivered && !r.is_read);
      if (deliverers.length === 0) html += '<div style="color:var(--text-muted);font-size:0.8rem;">Nobody</div>';
      deliverers.forEach(r => {
        html += `
        <div style="display:flex;align-items:center;gap:10px;padding:6px;background:rgba(255,255,255,0.05);border-radius:6px;margin-bottom:4px;">
          <div style="width:28px;height:28px;background:#555;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:0.75rem;">
            ${(r.display_name || r.user_email || 'U')[0].toUpperCase()}
          </div>
          <div style="font-size:0.85rem;font-weight:600;">${r.display_name || r.user_email}</div>
        </div>`;
      });
      list.innerHTML = html;
    }
  } catch(e) {
    list.innerHTML = '<div style="color:#ff3333;font-size:0.85rem;">Failed to load read receipts.</div>';
  }
});
function clearWSPinned(){document.getElementById('wsPinnedBar')?.classList.add('d-none');}

/* ── Reply Draft ── */
function setReply(r){replyDraft=r;const bar=document.getElementById('replyDraftBar');const prev=document.getElementById('replyDraftPreview');if(bar&&prev){prev.textContent=r.preview||'';bar.classList.remove('d-none');}document.getElementById('msgInput')?.focus();}
function cancelReply(){replyDraft=null;document.getElementById('replyDraftBar')?.classList.add('d-none');}

/* ── Self-Destruct ── */
function toggleSelfDestruct(){isSelfDestruct=!isSelfDestruct;const btn=document.getElementById('selfDestructBtn');if(btn){btn.style.color=isSelfDestruct?'#ff3333':'';btn.title=isSelfDestruct?'Self-Destruct ON':'Self-Destruct Message';}}

/* ── File Attachment ── */
window.handleFileSelection = function(e){
  const f=e.target.files&&e.target.files[0];
  if(!f)return;
  selectedFile=f;
  const bar=document.getElementById('attachmentPreviewBar');
  const fn=document.getElementById('attachmentFileName');
  if(bar&&fn){
    fn.textContent=f.name;
    bar.classList.remove('d-none');
  }
  autoResize(); // Trigger send button visibility
}
function cancelAttachment(){selectedFile=null;document.getElementById('attachmentPreviewBar')?.classList.add('d-none');const inp=document.getElementById('fileAttachment');if(inp)inp.value='';}
window.wsDownloadFile=function(filename,fileData){if(!fileData)return;const a=document.createElement('a');a.href=fileData;a.download=filename;a.click();};

/* ── Voice Recording ── */
let wsMediaRecorder=null,wsAudioChunks=[];
async function startRecording(){
  if(isRecording)return;
  try {
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    wsMediaRecorder=new MediaRecorder(stream);
    wsAudioChunks=[];
    wsMediaRecorder.ondataavailable=e=>wsAudioChunks.push(e.data);
    wsMediaRecorder.start();
    isRecording=true;
    recordingTime=0;
    
    // Update UI
    const ui = document.getElementById('recordingUI');
    const dot = document.getElementById('recordingDot');
    const timeEl = document.getElementById('recordingTime');
    if(ui) ui.classList.remove('d-none');
    if(dot) dot.classList.add('pulse-red');
    
    const btn = document.getElementById('voiceRecordBtn');
    if(btn){ btn.style.color='#ff3333'; btn.style.borderColor='#ff3333'; }
    
    recordingInterval = setInterval(()=>{
      recordingTime += 0.1;
      if(timeEl) timeEl.textContent = fmt(Math.floor(recordingTime));
    }, 100);
  } catch(e){ alert('Microphone access denied.'); }
}

function stopRecording(){
  if(!isRecording||!wsMediaRecorder)return;
  clearInterval(recordingInterval);
  isRecording=false;
  
  // Update UI
  const ui = document.getElementById('recordingUI');
  const dot = document.getElementById('recordingDot');
  if(ui) ui.classList.add('d-none');
  if(dot) dot.classList.remove('pulse-red');
  
  const btn = document.getElementById('voiceRecordBtn');
  if(btn){ btn.style.color='var(--accent-color)'; btn.style.borderColor='var(--accent-color)'; }
  
  const dur=recordingTime;
  wsMediaRecorder.onstop=()=>{
    const blob=new Blob(wsAudioChunks,{type:'audio/webm'});
    const reader=new FileReader();
    reader.onload=()=>{
      if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'message',content:`🎤 [Voice Note ${dur}s]\n${reader.result}`}));
    };
    reader.readAsDataURL(blob);
    wsMediaRecorder.stream.getTracks().forEach(t=>t.stop());
  };
  wsMediaRecorder.stop();
}
window.wsPlayAudio=function(aid,dur){const a=document.getElementById('realAudio_'+aid),btn=document.getElementById('playBtn_'+aid),prog=document.getElementById('progBar_'+aid),t=document.getElementById('time_'+aid);if(!a)return;if(!a.paused){a.pause();if(btn)btn.innerHTML='<i class="fa-solid fa-play"></i>';return;}a.play();if(btn)btn.innerHTML='<i class="fa-solid fa-pause"></i>';a.ontimeupdate=()=>{const d=isFinite(a.duration)&&a.duration>0?a.duration:dur;if(prog)prog.style.width=(a.currentTime/d*100)+'%';if(t)t.textContent=fmt(Math.round(d-a.currentTime));};a.onended=()=>{if(btn)btn.innerHTML='<i class="fa-solid fa-play"></i>';if(prog)prog.style.width='0%';if(t)t.textContent=fmt(dur);};};
window.wsSeekAudio=function(e,aid,dur){const a=document.getElementById('realAudio_'+aid);if(!a)return;const r=e.currentTarget.getBoundingClientRect();const d=isFinite(a.duration)&&a.duration>0?a.duration:dur;a.currentTime=((e.clientX-r.left)/r.width)*d;};

/* ── Emoji Popover (matches message.html: toggleEmojiPopover / emojiPopover / emojiPopoverGrid) ── */
(function initEmoji() {
  const grid = document.getElementById('emojiPopoverGrid');
  if (!grid) return;
  EMOJI_GRID.forEach(em => {
    const s = document.createElement('span');
    s.textContent = em; s.style.cursor = 'pointer'; s.title = em;
    s.onclick = () => {
      const inp = document.getElementById('chatInput');
      if (inp) { inp.value += em; autoResize(inp); onTyping(); }
      closeEmojiPopover();
    };
    grid.appendChild(s);
  });
})();
function toggleEmojiPopover(e) { e.stopPropagation(); document.getElementById('emojiPopover')?.classList.toggle('d-none'); }
function closeEmojiPopover() { document.getElementById('emojiPopover')?.classList.add('d-none'); }
/* aliases used elsewhere in workspace.js */
const toggleWSEmojiPopover = toggleEmojiPopover;
const closeWSEmojiPopover = closeEmojiPopover;

/* ── Search ── */
function toggleWSSearch(){const p=document.getElementById('wsSearchPanel');p.classList.toggle('d-none');if(!p.classList.contains('d-none'))document.getElementById('wsSearchInput')?.focus();}
function closeWSSearch(){document.getElementById('wsSearchPanel')?.classList.add('d-none');}
function doWSSearch(q){const rows=document.querySelectorAll('#msgArea .msg-row');rows.forEach(r=>{const txt=r.querySelector('.msg-text')?.textContent||'';r.style.opacity=(!q||txt.toLowerCase().includes(q.toLowerCase()))?'1':'0.15';});}

/* ── Scroll FAB ── */
function updateScrollFab(){const area=document.getElementById('msgArea'),fab=document.getElementById('wsScrollFab');if(!area||!fab)return;const atBottom=area.scrollHeight-area.scrollTop-area.clientHeight<100;fab.classList.toggle('d-none',atBottom);}
function scrollToBottom(){const area=document.getElementById('msgArea');if(area){area.scrollTop=area.scrollHeight;updateScrollFab();}}

/* ── Auto-resize textarea ── */
function autoResize(el) {
  if (!el) el = document.getElementById('chatInput');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  const sendBtn = document.getElementById('sendMsgBtn');
  const voiceBtn = document.getElementById('voiceRecordBtn');
  // Show send button if there's text OR a selected file
  if (el.value.trim() || selectedFile) { 
    sendBtn?.classList.remove('d-none'); 
    voiceBtn?.classList.add('d-none'); 
  } else { 
    sendBtn?.classList.add('d-none'); 
    voiceBtn?.classList.remove('d-none'); 
  }
}

function toggleWSSidebars() {
  const ws = document.querySelector('.ws-sidebar');
  const ch = document.querySelector('.ch-sidebar');
  const isHidden = ws.classList.contains('d-none');
  if (isHidden) {
    ws.classList.remove('d-none');
    ch.classList.remove('d-none');
  } else {
    ws.classList.add('d-none');
    ch.classList.add('d-none');
  }
}

/* ── legacy stub (not used anymore) ── */
function msgHTML(m) {
  const name = m.display_name || m.sender;
  const initials = name[0].toUpperCase();
  const time = m.created_at ? m.created_at.substring(11, 16) : '';
  const replies = m.reply_count ? `<span class="msg-replies" onclick="openThread(${m.id})"><i class="fa-solid fa-message"></i> ${m.reply_count} replies</span>` : '';
  
  const avatarInner = m.avatar 
    ? `<img src="${m.avatar}" onclick="viewProfile('${m.sender}', '${name}')">` 
    : `<span onclick="viewProfile('${m.sender}', '${name}')">${initials}</span>`;

  return `<div class="msg-row" id="msg-${m.id}">
    <div class="msg-avatar" style="${m.avatar ? 'background:transparent' : ''}">${avatarInner}</div>
    <div class="msg-body">
      <div class="msg-head">
        <span class="msg-author" onclick="viewProfile('${m.sender}', '${name}')">${name}</span>
        ${m.user_id ? `<span class="msg-uid" style="font-size:0.7rem; color:var(--accent-color); opacity:0.7; margin-left:5px;">ID: ${m.user_id}</span>` : ''}
        <span class="msg-time">${time}</span>
      </div>
      <div class="msg-text">${escHTML(m.content)}</div>
      ${replies}
    </div>
  </div>`;
}

function viewProfile(email, name) {
  fetch(API + "/get-profile?email=" + encodeURIComponent(email), { headers: hdr })
    .then(r => r.json())
    .then(p => {
      const avatarEl = document.getElementById('simpleProfileAvatar');
      if (p.avatar) {
        avatarEl.style.background = 'transparent';
        avatarEl.innerHTML = `<img src="${p.avatar}" style="width:100%; height:100%; object-fit:cover;">`;
      } else {
        avatarEl.style.background = 'var(--accent-color)';
        avatarEl.textContent = (p.display_name || name || '?').charAt(0).toUpperCase();
        avatarEl.innerHTML = (p.display_name || name || '?').charAt(0).toUpperCase();
      }
      document.getElementById('simpleProfileName').textContent = p.display_name || name || 'Unknown';
      const rawIdVal = p.user_id ? String(p.user_id) : (p.id ? String(p.id) : '');
      document.getElementById('simpleProfileId').textContent = (rawIdVal && rawIdVal !== '1') ? ('ID: ' + rawIdVal) : '';
      document.getElementById('simpleProfileBio').textContent = p.bio || 'No bio';
      document.getElementById('simplePanelEmail').value = email;
      
      document.getElementById('simpleProfilePanel').classList.remove('d-none');
      document.getElementById('modalBackdrop').classList.remove('d-none');
    })
    .catch(err => {
      console.error('Failed to load profile', err);
    });
}

window.hideViewProfileModal = function() {
  document.getElementById('simpleProfilePanel').classList.add('d-none');
  document.getElementById('modalBackdrop').classList.add('d-none');
};

document.getElementById('modalBackdrop')?.addEventListener('click', hideViewProfileModal);

function escHTML(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

/* ── Send message ── */
function sendMsg() {
  const inp = document.getElementById('chatInput');
  let txt = (inp.value || '').trim();
  if (!txt && !selectedFile) return;
  if (!ws || ws.readyState !== 1) return;

  // Handle file
  if (selectedFile) {
    const reader = new FileReader();
    const fileName = selectedFile.name; // Capture name
    reader.onload = () => {
      let content = `📎 [Attached: ${fileName}]\n${reader.result}`;
      if (txt) content = content + '\n' + txt;
      if (isSelfDestruct) content = '⏳ [Self-Destructing]\n' + content;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'message', content }));
      }
    };
    reader.readAsDataURL(selectedFile);
    cancelAttachment();
    inp.value = ''; autoResize(inp);
    cancelReply(); return;
  }

  if (isSelfDestruct) txt = '⏳ [Self-Destructing]\n' + txt;
  ws.send(JSON.stringify({ type: 'message', content: txt }));
  inp.value = ''; autoResize(inp);
  cancelReply();
  if (isSelfDestruct) toggleSelfDestruct();
}

/* ── Typing indicator ── */
let typingTimer;
function onTyping() {
  const inp = document.getElementById('chatInput');
  if (inp) autoResize(inp);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'typing' }));
}
function showTyping(name) {
  const el = document.getElementById('typingBar');
  if (!el) return;
  el.innerHTML = '<span class="tg-typing__dots" aria-hidden="true"><span></span><span></span><span></span></span> <span>' + name + ' is typing...</span>';
  el.classList.remove('d-none');
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => el.classList.add('d-none'), 2500);
}

/* wire chatInput oninput since it's plain textarea (no oninput attr in exact copy) */
document.addEventListener('DOMContentLoaded', () => {
  const ci = document.getElementById('chatInput');
  if (ci) ci.addEventListener('input', () => { onTyping(); autoResize(ci); });
  const cf = document.getElementById('chatForm');
  if (cf) cf.addEventListener('submit', (e) => { e.preventDefault(); sendMsg(); });
});

/* ── Threads ── */
async function openThread(msgId) {
  if (!currentCH) return;
  const data = await api('/channels/' + currentCH.id + '/thread/' + msgId);
  const modal = document.getElementById('threadModal');
  const body = document.getElementById('threadBody');
  body.innerHTML = '';
  // Parent message
  const parentWrap = document.createElement('div');
  parentWrap.className = 'thread-parent';
  const tempArea = { appendChild: (el) => parentWrap.appendChild(el) };
  appendWSMessageTo(data.parent, parentWrap);
  body.appendChild(parentWrap);
  const hr = document.createElement('hr');
  hr.style.cssText = 'border-color:var(--border-color);margin:8px 0';
  body.appendChild(hr);
  // Replies
  data.replies.forEach(r => appendWSMessageTo(r, body));
  modal.classList.remove('d-none');
  modal.dataset.threadId = msgId;
}

function appendWSMessageTo(m, container) {
  const senderEmail = m.sender;
  const isMe = senderEmail === currentUserEmail;
  const name = m.display_name || senderEmail;
  const rawTime = m.created_at || new Date().toISOString();
  let text = m.content || '';

  const row = document.createElement("div");
  row.className = "chat-bubble-row " + (isMe ? "chat-bubble-row--me" : "chat-bubble-row--them");
  
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.style.wordBreak = "break-word";

  const body = document.createElement("div");
  body.className = "chat-bubble-body";
  
  if (text.startsWith("🎤 [Voice Note")) {
      body.innerHTML = `<div style="padding:10px; background:rgba(0,0,0,0.2); border-radius:15px; font-size:0.9rem;"><i class="fa-solid fa-microphone"></i> Voice Note</div>`;
  } else if (text.includes("📎 [Attached:")) {
      body.innerHTML = `<div style="padding:10px; background:rgba(0,0,0,0.2); border-radius:8px; font-size:0.9rem;"><i class="fa-solid fa-paperclip"></i> Attachment</div>`;
  } else {
      body.textContent = text;
  }

  const meta = document.createElement("div");
  meta.className = "chat-bubble-meta";
  const dateObj = new Date(rawTime);
  const displayTime = dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.appendChild(document.createElement("span")).textContent = displayTime;

  bubble.appendChild(meta);
  bubble.appendChild(body);
  row.appendChild(bubble);
  container.appendChild(row);
}
function closeThread() { document.getElementById('threadModal').classList.add('d-none'); }
function sendThreadReply() {
  const inp = document.getElementById('threadInput');
  const txt = inp.value.trim();
  const tid = document.getElementById('threadModal').dataset.threadId;
  if (!txt || !ws || !tid) return;
  ws.send(JSON.stringify({ type: 'message', content: txt, thread_id: parseInt(tid) }));
  inp.value = '';
  setTimeout(() => openThread(parseInt(tid)), 300);
}

/* ── Create workspace ── */
async function createWS() {
  const name = document.getElementById('newWSName').value.trim();
  if (!name) return;
  await api('/workspaces/create', { method: 'POST', body: JSON.stringify({ name }) });
  document.getElementById('newWSName').value = '';
  document.getElementById('createWSModal').classList.add('d-none');
  await loadWorkspaces();
}

/* ── Create channel ── */
async function createCH() {
  const name = document.getElementById('newCHName').value.trim();
  if (!name || !currentWS) return;
  const priv = document.getElementById('newCHPrivate').checked;
  await api('/channels/create', { method: 'POST', body: JSON.stringify({ workspace_id: currentWS.id, name, is_private: priv }) });
  document.getElementById('newCHName').value = '';
  document.getElementById('createCHModal').classList.add('d-none');
  await loadChannels();
}

/* ── Invite member ── */
async function inviteMember() {
  const user_id = document.getElementById('inviteEmail').value.trim();
  if (!user_id || !currentWS) return;
  try {
    await api('/workspaces/' + currentWS.id + '/invite', { method: 'POST', body: JSON.stringify({ user_id }) });
    alert('Invited!');
    document.getElementById('inviteEmail').value = '';
    document.getElementById('inviteModal').classList.add('d-none');
  } catch (e) { alert(e.message); }
}

/* ── Members panel ── */
async function showMembers() {
  if (!currentWS) return;
  const members = await api('/workspaces/' + currentWS.id + '/members');
  const el = document.getElementById('membersBody');
  el.innerHTML = members.map(m => `
    <div class="member-row">
      <div class="member-avatar">${(m.display_name || m.email)[0].toUpperCase()}</div>
      <div class="member-info">
        <div class="member-name">${m.display_name || m.email}</div>
        <div class="member-role">${m.role}</div>
      </div>
    </div>
  `).join('');
  document.getElementById('membersModal').classList.remove('d-none');
}

/* ── Channel Members panel ── */
async function showCHMembers() {
  if (!currentCH) {
      alert("Please open a channel first");
      return;
  }
  try {
    const members = await api('/channels/' + currentCH.id + '/members');
    const el = document.getElementById('chMembersBody');
    const addForm = document.getElementById('chAddMemberForm');
    const myEmail = (currentUserEmail || "").toLowerCase();
    
    // Determine my role in this workspace/channel context
    const meInList = members.find(m => m.email.toLowerCase() === myEmail);
    const isAdmin = meInList && (meInList.role === 'admin' || meInList.role === 'owner');

    // Show/Hide Add form based on role
    if (isAdmin) {
        if (addForm) addForm.classList.remove('d-none');
    } else {
        if (addForm) addForm.classList.add('d-none');
    }

    if (!members || !Array.isArray(members)) {
        el.innerHTML = '<div style="padding:10px;color:var(--text-muted);">No members found.</div>';
    } else {
        el.innerHTML = members.map(m => {
          const isMe = m.email.toLowerCase() === myEmail;
          let actionBtn = '';
          
          if (isMe) {
              actionBtn = `<button class="btn btn-ghost" style="padding:4px 8px;font-size:0.8rem;border-color:#dc3545;color:#dc3545;" onclick="removeCHMember('${m.email}')">Leave</button>`;
          } else if (isAdmin) {
              actionBtn = `<button class="btn btn-ghost" style="padding:4px 8px;font-size:0.8rem;border-color:#dc3545;color:#dc3545;" onclick="removeCHMember('${m.email}')">Remove</button>`;
          }

          return `
            <div class="member-row">
              <div class="member-avatar">${(m.display_name || m.email || "?")[0].toUpperCase()}</div>
              <div class="member-info" style="flex:1">
                <div class="member-name">${m.display_name || m.email}</div>
                <div class="member-role">${m.role || 'member'}</div>
              </div>
              ${actionBtn}
            </div>
          `;
        }).join('');
    }
    document.getElementById('chMembersModal').classList.remove('d-none');
  } catch (e) { alert("Error loading members: " + e.message); }
}

async function addCHMember() {
  if (!currentCH) return;
  const user_id = document.getElementById('chInviteEmail').value.trim();
  if (!user_id) return;
  try {
    await api('/channels/' + currentCH.id + '/members', { method: 'POST', body: JSON.stringify({ user_id }) });
    document.getElementById('chInviteEmail').value = '';
    showCHMembers(); // refresh list
  } catch (e) { alert(e.message); }
}

async function removeCHMember(email) {
  const isSelf = email.toLowerCase() === currentUserEmail.toLowerCase();
  const msg = isSelf ? "Leave this channel?" : "Remove this member from the channel?";
  if (!currentCH || !confirm(msg)) return;
  try {
    await api('/channels/' + currentCH.id + '/members/' + encodeURIComponent(email), { method: 'DELETE' });
    if (isSelf) {
      document.getElementById('chMembersModal').classList.add('d-none');
      openChannel(currentCH.id); // Refresh view
    } else {
      showCHMembers(); // refresh list
    }
  } catch (e) { alert(e.message); }
}

async function joinCurrentChannel() {
  if (!currentCH) return;
  try {
    await api('/channels/' + currentCH.id + '/members', { method: 'POST', body: JSON.stringify({ email: currentUserEmail }) });
    openChannel(currentCH.id); // Re-open to refresh state
  } catch (e) { alert(e.message); }
}

/* ── Logout from page ── */
function logoutFromPage() {
  localStorage.clear();
  location.href = 'home.html';
}

/* ── Leave Workspace ── */
async function leaveWorkspace() {
  if (!currentWS) return;
  if (!confirm(`Are you sure you want to leave "${currentWS.name}"? You will lose access to all channels.`)) return;
  try {
    await api('/workspaces/' + currentWS.id + '/leave', { method: 'POST' });
    toggleModal('wsMenuModal');
    currentWS = null;
    currentCH = null;
    localStorage.removeItem('ws_id');
    localStorage.removeItem('ch_id');
    document.getElementById('channelPanel').classList.add('d-none');
    document.getElementById('chatPanel').classList.add('d-none');
    document.getElementById('emptyMain').classList.remove('d-none');
    loadWorkspaces();
  } catch (e) { alert(e.message); }
}

/* ── Workspace Details ── */
function editWorkspaceName() {
  if (!currentWS) return;
  document.getElementById('editWSName').value = currentWS.name;
  document.getElementById('editWSDesc').value = currentWS.description || "";
  toggleModal('editWSModal');
}

async function submitEditWS() {
  const newName = document.getElementById('editWSName').value.trim();
  const newDesc = document.getElementById('editWSDesc').value.trim();
  if (!newName) return;
  
  try {
    await api('/workspaces/' + currentWS.id, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName, description: newDesc })
    });
    // refresh list and title
    document.getElementById('wsName').textContent = newName;
    currentWS.name = newName;
    currentWS.description = newDesc;
    loadWorkspaces();
    toggleModal('editWSModal');
  } catch (e) { alert("Failed to update workspace: " + e.message); }
}

/* ── Workspace Image ── */
let pendingWsImage = null;

function openWsImageModal() {
  if (!currentWS) return;
  pendingWsImage = null;
  document.getElementById('wsImageFile').value = '';
  const preview = document.getElementById('wsImagePreview');
  if (currentWS.image) {
    preview.innerHTML = `<img src="${currentWS.image}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    preview.innerHTML = `<span id="wsImagePreviewLetter">${currentWS.name[0].toUpperCase()}</span>`;
  }
  toggleModal('wsImageModal');
}

function previewWsImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    pendingWsImage = e.target.result;
    document.getElementById('wsImagePreview').innerHTML = `<img src="${pendingWsImage}" style="width:100%;height:100%;object-fit:cover;">`;
  };
  reader.readAsDataURL(file);
}

function removeWsImage() {
  pendingWsImage = '';  
  document.getElementById('wsImagePreview').innerHTML = `<span>${currentWS ? currentWS.name[0].toUpperCase() : 'W'}</span>`;
}

async function saveWsImage() {
  if (!currentWS || pendingWsImage === null) {
    toggleModal('wsImageModal');
    return;
  }
  try {
    await api('/workspaces/' + currentWS.id + '/image', {
      method: 'PATCH',
      body: JSON.stringify({ image: pendingWsImage })
    });
    toggleModal('wsImageModal');
    currentWS.image = pendingWsImage;
    loadWorkspaces(); 
  } catch (e) { alert(e.message); }
}

/* ── Channel Details ── */
function editChannelName() {
  if (!currentCH) return;
  document.getElementById('editCHName').value = currentCH.name;
  document.getElementById('editCHDesc').value = currentCH.description || "";
  toggleModal('editCHModal');
}

async function submitEditCH() {
  const newName = document.getElementById('editCHName').value.trim();
  const newDesc = document.getElementById('editCHDesc').value.trim();
  if (!newName) return;
  
  try {
    await api('/channels/' + currentCH.id, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName, description: newDesc })
    });
    currentCH.name = newName.replace(/ /g, "-");
    currentCH.description = newDesc;
    document.getElementById('chTitle').textContent = '#' + currentCH.name;
    document.getElementById('chDesc').textContent = currentCH.description;
    loadChannels(); // refresh left sidebar
    toggleModal('editCHModal');
  } catch (e) { alert("Failed to update channel: " + e.message); }
}

/* ── Channel Image ── */
let pendingChImage = null;

function openChImageModal() {
  if (!currentCH) return;
  pendingChImage = null;
  document.getElementById('chImageFile').value = '';
  // Show current image or letter
  const preview = document.getElementById('chImagePreview');
  const avatarEl = document.getElementById('chAvatar');
  const img = avatarEl.querySelector('img');
  if (img) {
    preview.innerHTML = `<img src="${img.src}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    preview.innerHTML = `<span id="chImagePreviewLetter">${currentCH.name[0].toUpperCase()}</span>`;
  }
  toggleModal('chImageModal');
}

function previewChImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    pendingChImage = e.target.result; // base64 data URI
    document.getElementById('chImagePreview').innerHTML = `<img src="${pendingChImage}" style="width:100%;height:100%;object-fit:cover;">`;
  };
  reader.readAsDataURL(file);
}

function removeChImage() {
  pendingChImage = '';  // empty string = remove
  document.getElementById('chImagePreview').innerHTML = `<span>${currentCH ? currentCH.name[0].toUpperCase() : '#'}</span>`;
}

async function saveChImage() {
  if (!currentCH || pendingChImage === null) {
    toggleModal('chImageModal');
    return;
  }
  try {
    await api('/channels/' + currentCH.id + '/image', {
      method: 'PATCH',
      body: JSON.stringify({ image: pendingChImage })
    });
    toggleModal('chImageModal');
    openChannel(currentCH.id); // refresh header
  } catch (e) { alert(e.message); }
}

/* ── Fullscreen Remote Video (Screen Share) ── */
function toggleRemoteFullscreen() {
  const video = document.getElementById('remoteVideo');
  if (!video) return;
  if (document.fullscreenElement === video || document.webkitFullscreenElement === video) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    (video.requestFullscreen || video.webkitRequestFullscreen).call(video);
  }
}

/* ── Modal toggles ── */
function toggleModal(id) { document.getElementById(id).classList.toggle('d-none'); }

/* ══════════════════════════════════════════════
   WebRTC – Voice / Video Calls + Screen Share
   (adapted from chat-ui.js for channel context)
══════════════════════════════════════════════ */
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let peerConnection = null, localStream = null, screenStream = null;
let wsCallingPeer = null, isCurrentCallVideo = false, iceCandidateQueue = [];
// currentUserEmail already declared at top

// Load current user email on init
(async () => {
  try {
    const r = await fetch(API + '/home', { headers: hdr });
    if (r.ok) { const d = await r.json(); currentUserEmail = d.user?.sub || ''; }
  } catch(e) {}
})();

function _wsShowCallBox(mode, peer) {
  document.getElementById('callOverlay').classList.remove('d-none');
  document.getElementById('callPeer').textContent = peer || 'Channel member';
  const acceptBtn = document.getElementById('acceptCallBtn');
  const rejectBtn = document.getElementById('rejectCallBtn');
  const endBtn    = document.getElementById('endCallBtn');
  const ssBtn     = document.getElementById('screenShareBtn');
  if (mode === 'incoming') {
    document.getElementById('callStatus').textContent = (peer || 'Someone') + ' is calling…';
    acceptBtn.classList.remove('d-none'); rejectBtn.classList.remove('d-none');
    endBtn.classList.add('d-none'); ssBtn.classList.add('d-none');
  } else {
    document.getElementById('callStatus').textContent = 'Calling…';
    acceptBtn.classList.add('d-none'); rejectBtn.classList.add('d-none');
    endBtn.classList.remove('d-none'); ssBtn.classList.remove('d-none');
  }
}

function _wsHideCallBox() {
  document.getElementById('callOverlay')?.classList.add('d-none');
  document.getElementById('inCallVideos')?.classList.add('d-none');
  const lv = document.getElementById('localVideo');
  const rv = document.getElementById('remoteVideo');
  if (lv) lv.srcObject = null;
  if (rv) rv.srcObject = null;
}

async function _wsSetupLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: isCurrentCallVideo, audio: true });
  if (isCurrentCallVideo) {
    document.getElementById('localVideo').srcObject = localStream;
    document.getElementById('inCallVideos').classList.remove('d-none');
  }
}

function _wsSetupPC() {
  peerConnection = new RTCPeerConnection(rtcConfig);
  peerConnection.onicecandidate = ev => {
    if (ev.candidate && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'webrtc', from: currentUserEmail, signal: { type: 'ice', candidate: ev.candidate } }));
    }
  };
  peerConnection.ontrack = ev => {
    document.getElementById('remoteVideo').srcObject = ev.streams[0];
    document.getElementById('inCallVideos').classList.remove('d-none');
    document.getElementById('callStatus').textContent = 'In call';
  };
  peerConnection.onconnectionstatechange = () => {
    const s = peerConnection?.connectionState;
    if (s === 'disconnected' || s === 'failed' || s === 'closed') window.endWSCall();
  };
}

window.startWSCall = async function(isVideo) {
  if (!ws || ws.readyState !== 1) return alert('Open a channel first.');
  isCurrentCallVideo = !!isVideo; iceCandidateQueue = [];
  _wsShowCallBox('outgoing', '#' + (currentCH?.name || 'channel'));
  try {
    await _wsSetupLocalMedia(); _wsSetupPC();
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'webrtc', from: currentUserEmail, signal: { type: 'offer', offer, isVideo } }));
  } catch(e) { console.error(e); window.endWSCall(); }
};

window.acceptWSCall = async function() {
  document.getElementById('acceptCallBtn').classList.add('d-none');
  document.getElementById('rejectCallBtn').classList.add('d-none');
  document.getElementById('endCallBtn').classList.remove('d-none');
  document.getElementById('screenShareBtn').classList.remove('d-none');
  document.getElementById('callStatus').textContent = 'Connecting…';
  try {
    await _wsSetupLocalMedia();
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'webrtc', from: currentUserEmail, signal: { type: 'answer', answer } }));
  } catch(e) { console.error(e); window.endWSCall(); }
};

window.rejectWSCall = function() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'webrtc', from: currentUserEmail, signal: { type: 'reject' } }));
  window.endWSCall();
};

window.endWSCall = function() {
  if (peerConnection) { try { peerConnection.close(); } catch(e){} peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'webrtc', from: currentUserEmail, signal: { type: 'end' } }));
  wsCallingPeer = null; iceCandidateQueue = [];
  _wsHideCallBox();
};

/* Screen Share */
window.startScreenShare = async function() {
  if (!peerConnection) return alert('Start a call first to share your screen.');
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = screenStream.getVideoTracks()[0];
    const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
    if (sender) { await sender.replaceTrack(screenTrack); }
    else { peerConnection.addTrack(screenTrack, screenStream); }
    document.getElementById('localVideo').srcObject = screenStream;
    document.getElementById('inCallVideos').classList.remove('d-none');
    document.getElementById('callStatus').textContent = 'Sharing screen…';
    screenTrack.onended = async () => {
      // Switch back to camera when screen share ends
      if (localStream) {
        const camTrack = localStream.getVideoTracks()[0];
        const s2 = peerConnection?.getSenders().find(s => s.track?.kind === 'video');
        if (s2 && camTrack) await s2.replaceTrack(camTrack);
      }
      document.getElementById('callStatus').textContent = 'In call';
      screenStream = null;
    };
  } catch(e) { console.error('Screen share error:', e); }
};

/* Handle incoming WebRTC signals via channel WebSocket */
async function handleWSWebRTC(from, signal) {
  if (!signal) return;
  try {
    if (signal.type === 'offer') {
      wsCallingPeer = from; isCurrentCallVideo = !!signal.isVideo; iceCandidateQueue = [];
      _wsShowCallBox('incoming', from === currentUserEmail ? 'Yourself' : from.split('@')[0]);
      _wsSetupPC();
      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.offer));
      while (iceCandidateQueue.length) await peerConnection.addIceCandidate(iceCandidateQueue.shift());
    } else if (signal.type === 'answer') {
      if (peerConnection) await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.answer));
    } else if (signal.type === 'ice') {
      if (peerConnection) {
        if (peerConnection.remoteDescription) await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        else iceCandidateQueue.push(signal.candidate);
      }
    } else if (signal.type === 'reject' || signal.type === 'end') {
      window.endWSCall();
    }
  } catch(e) { console.error('handleWSWebRTC error', e); }
}

/* ── Key handlers ── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeWSContextMenu(); closeEmojiPopover(); cancelReply(); window.endWSCall(); }
  if (e.key === 'Enter' && !e.shiftKey) {
    if (document.activeElement.id === 'chatInput') { e.preventDefault(); sendMsg(); }
    if (document.activeElement.id === 'threadInput') { e.preventDefault(); sendThreadReply(); }
  }
});
document.addEventListener('click', () => { closeWSContextMenu(); closeEmojiPopover(); });

/* ── Init ── */
(async function init() {
  await loadWorkspaces();
  const savedWs = localStorage.getItem('ws_id');
  const savedCh = localStorage.getItem('ch_id');
  if (savedWs) {
    await selectWorkspace(parseInt(savedWs));
    if (savedCh) {
      await openChannel(parseInt(savedCh));
    }
  }
  
  // Auto-refresh channel list for unread badges (every 3s for near-realtime)
  setInterval(() => {
    if (currentWS) loadChannels();
  }, 3000);
})();
