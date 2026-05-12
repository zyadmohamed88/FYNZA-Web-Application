/**
 * FYNZA chat — Telegram-inspired interactions (typing, reply, reactions UI, context menu, search-in-chat, emoji strip).
 */
(function () {
    const API_BASE = "http://127.0.0.1:8000";
    const WS_BASE = "ws://127.0.0.1:8000";
    const hashParams = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
    const tokenFromHash = hashParams.get("token");
    if (tokenFromHash) {
        try {
            localStorage.setItem("token", tokenFromHash);
        } catch (_) {}
        window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
    }
    const token = (tokenFromHash && tokenFromHash.trim()) || localStorage.getItem("token");

    const statusEl = document.getElementById("statusMessage");
    let currentUserEmail = "";
    const unreadMap = new Map();
    let contactsCache = [];
    let ws;
    let activeContact = null;
    let requestsPollTimer = null;
    let peerTypingTimer = null;
    let outboundTypingTimer = null;
    let lastTypingSent = false;
    let replyDraft = null;
    let contextTarget = null;
    let emojiPopoverOpen = false;
    let selectedFile = null;
    let isSelfDestruct = false;
    let isRecording = false;
    let recordingInterval = null;
    let recordingTime = 0;

    const EMOJI_GRID = [
        "😀", "😂", "🥰", "😍", "😎", "🤔", "👍", "👎", "🙏", "🔥", "✨", "💯",
        "❤️", "💙", "🎉", "🚀", "⭐", "📌", "✅", "⚠️", "😢", "😮", "🤝", "👋",
    ];
    const QUICK_REACTIONS = ["❤️", "👍", "😂", "🔥", "👏"];

    // WebRTC call state
    let peerConnection = null;
    let localStream = null;
    let callingContact = null;
    let isCurrentCallVideo = false;
    let iceCandidateQueue = [];
    const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds) || !isFinite(seconds)) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60).toString().padStart(2, "0");
        return `${m}:${s}`;
    }

    if (!token) {
        window.location.replace("index.html?auth=missing");
        return;
    }

    statusEl.innerHTML =
        '<span class="text-info"><i class="bi bi-hourglass-split" aria-hidden="true"></i> Verifying session…</span>';

    fetch(API_BASE + "/home", { headers: { Authorization: "Bearer " + token } })
        .then(async (res) => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const d = data.detail;
                const msg =
                    typeof d === "string"
                        ? d
                        : Array.isArray(d) && d[0]?.msg
                          ? d.map((x) => x.msg).join(", ")
                          : "Session expired or invalid token";
                throw new Error(msg);
            }
            return data;
        })
        .then((data) => {
            statusEl.innerText = "";
            currentUserEmail = (data.user && data.user.sub) ? data.user.sub : "Unknown User";
            const chip = document.getElementById("headerUserChip");
            const chipEmail = document.getElementById("headerUserEmail");
            if (chip && chipEmail) {
                chipEmail.textContent = currentUserEmail;
                chip.classList.remove("d-none");
            }
        // Display current user email and ID
        const userDisplay = document.getElementById("currentUserEmailDisplay");
        if (userDisplay && currentUserEmail) {
            fetch(API_BASE + "/get-profile", { headers: { Authorization: "Bearer " + token } })
                .then((r) => r.json())
                .then((p) => {
                    const name = p.display_name || currentUserEmail.split("@")[0];
                    const avatar = p.avatar || null;
                    const initials = escapeHtml((name || "?").charAt(0).toUpperCase());
                    const avatarInner = avatar
                        ? `<img src="${avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
                        : initials;
                    const avatarBg = avatar ? "transparent" : "var(--accent-color)";
                    userDisplay.innerHTML = `
                        <div style="display:flex;gap:10px;align-items:center;width:100%;cursor:pointer;" id="sidebarProfileRow">
                            <div id="sidebarAvatar" style="width:38px;height:38px;border-radius:50%;background:${avatarBg};color:#000;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:1rem;overflow:hidden;flex-shrink:0;box-shadow:0 0 8px var(--accent-glow);">${avatarInner}</div>
                            <div style="flex:1;min-width:0;">
                                <div style="font-weight:600;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(name)}</div>
                                <div style="font-size:0.7rem;color:var(--accent-color);opacity:0.8;">${escapeHtml(currentUserEmail)}</div>
                            </div>
                            <span style="color:var(--text-muted);font-size:0.9rem;"><i class="bi bi-pencil-square"></i></span>
                        </div>
                    `;
                    // Click on own profile row → open editor directly
                    userDisplay.onclick = () => window.openProfileEditor();
                })
                .catch(() => {
                    userDisplay.textContent = currentUserEmail;
                });
        }

        // Profile editor handlers
        window.openProfileEditor = function() {
            fetch(API_BASE + "/get-profile", { headers: { Authorization: "Bearer " + token } })
                .then((r) => r.json())
                .then((p) => {
                    const rawProfileId = p.user_id ? String(p.user_id) : (p.id ? String(p.id) : '');
                    document.getElementById("profileUserId").value = (rawProfileId && rawProfileId !== '1') ? rawProfileId : '';
                    document.getElementById("profileDisplayName").value = p.display_name || "";
                    document.getElementById("profileBio").value = p.bio || "";
                    const prev = document.getElementById("profileModalAvatarPreview");
                    if (p.avatar) prev.innerHTML = `<img src="${p.avatar}" style="width:100%; height:100%; object-fit:cover;">`;
                    else prev.textContent = (p.display_name || currentUserEmail.split("@")[0] || "?").charAt(0).toUpperCase();
                    const fnEl = document.getElementById('profileAvatarFilename');
                    if (fnEl) fnEl.textContent = p.avatar ? 'Current avatar' : '';
                    window.showProfileModal();
                    setTimeout(() => document.getElementById('profileDisplayName')?.focus(), 80);
                });
        }

        window.showProfileModal = function() {
            const modal = document.getElementById('profileModal');
            const backdrop = document.getElementById('modalBackdrop');
            if (backdrop) backdrop.classList.remove('d-none');
            if (modal) modal.classList.remove('d-none');
        }

        window.hideProfileModal = function() {
            const modal = document.getElementById('profileModal');
            const backdrop = document.getElementById('modalBackdrop');
            if (modal) modal.classList.add('d-none');
            if (backdrop) backdrop.classList.add('d-none');
        }

        document.getElementById("profileCancelBtn")?.addEventListener("click", () => window.hideProfileModal());
        document.getElementById('modalBackdrop')?.addEventListener('click', () => {
            window.hideProfileModal();
            window.hideViewProfileModal();
        });

        // View profile modal functions (read-only for other users)
        window.showViewProfileModal = function() {
            const modal = document.getElementById('viewProfileModal');
            const backdrop = document.getElementById('modalBackdrop');
            if (backdrop) backdrop.classList.remove('d-none');
            if (modal) modal.classList.remove('d-none');
        }

        window.hideViewProfileModal = function() {
            const panelA = document.getElementById('simpleProfilePanel');
            const panelB = document.getElementById('viewProfileModal');
            const backdrop = document.getElementById('modalBackdrop');
            if (panelA) panelA.classList.add('d-none');
            if (panelB) panelB.classList.add('d-none');
            if (backdrop) backdrop.classList.add('d-none');
        }

        window.showViewProfile = function(email, displayName) {
            fetch(API_BASE + "/get-profile?email=" + encodeURIComponent(email), { headers: { Authorization: "Bearer " + token } })
                .then((r) => r.json())
                .then((p) => {
                    const avatarEl = document.getElementById('simpleProfileAvatar');
                    if (p.avatar) {
                        avatarEl.style.background = 'transparent';
                        avatarEl.innerHTML = `<img src="${p.avatar}" style="width:100%; height:100%; object-fit:cover;">`;
                    } else {
                        avatarEl.style.background = 'var(--accent-color)';
                        avatarEl.textContent = (p.display_name || displayName || '?').charAt(0).toUpperCase();
                    }
                    document.getElementById('simpleProfileName').textContent = p.display_name || displayName || 'Unknown';
                    const rawIdVal = p.user_id ? String(p.user_id) : (p.id ? String(p.id) : '');
                    document.getElementById('simpleProfileId').textContent = (rawIdVal && rawIdVal !== '1') ? ('ID: ' + rawIdVal) : '';
                    document.getElementById('simpleProfileBio').textContent = p.bio || 'No bio';
                    document.getElementById('simplePanelEmail').value = email;
                    const isOwn = (email === currentUserEmail);
                    const editBtn = document.getElementById('simplePanelEditBtn');
                    const chatBtn = document.getElementById('simplePanelChatBtn');
                    if (isOwn) {
                        editBtn.style.display = 'inline-block';
                        chatBtn.style.display = 'none';
                    } else {
                        editBtn.style.display = 'none';
                        chatBtn.style.display = 'inline-block';
                    }
                    document.getElementById('simpleProfilePanel').classList.remove('d-none');
                    document.getElementById('modalBackdrop').classList.remove('d-none');
                })
                .catch((err) => {
                    alert('Failed to load profile');
                });
        }

        // Image viewer (full-screen) helpers
        function showImageViewer(src) {
            const v = document.getElementById('imageViewer');
            const img = document.getElementById('imageViewerImg');
            if (img && src) {
                img.src = src;
            }
            if (v) v.classList.remove('d-none');
        }

        function hideImageViewer() {
            const v = document.getElementById('imageViewer');
            if (v) v.classList.add('d-none');
        }

        // Ensure close and image viewer handlers are attached unconditionally
        try {
            document.getElementById('viewProfileCloseBtn')?.addEventListener('click', hideViewProfileModal);
            document.getElementById('imageViewer')?.addEventListener('click', hideImageViewer);
        } catch (e) {
            // ignore if elements not yet present
        }

        document.getElementById("profileAvatarInput")?.addEventListener("change", function (e) {
            const f = this.files && this.files[0];
            if (!f) return;
            const r = new FileReader();
            r.onload = () => {
                document.getElementById("profileModalAvatarPreview").innerHTML = `<img src="${r.result}" style="width:100%; height:100%; object-fit:cover;">`;
                document.getElementById("profileModal").dataset.avatar = r.result;
                const fname = (f && f.name) ? f.name : '';
                const fnEl = document.getElementById('profileAvatarFilename');
                if (fnEl) fnEl.textContent = fname;
            };
            r.readAsDataURL(f);
        });

        document.getElementById("profileSaveBtn")?.addEventListener("click", async () => {
            const name = document.getElementById("profileDisplayName").value.trim();
            const bio = document.getElementById("profileBio").value.trim();
            const avatarData = document.getElementById("profileModal").dataset.avatar || null;
            const body = { display_name: name || null, bio: bio || null, avatar: avatarData || null };
            try {
                const res = await fetch(API_BASE + "/update-profile", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
                const j = await res.json();
                hideProfileModal();
                // Refresh sidebar
                document.getElementById("currentUserEmailDisplay").innerHTML = "";
                // re-run the same block to reload profile
                const evt = new Event('reloadProfile');
                window.dispatchEvent(evt);
            } catch (e) {
                console.error('Profile save failed', e);
            }
        });

        // allow external refresh
        window.addEventListener('reloadProfile', () => {
            const el = document.getElementById('currentUserEmailDisplay');
            if (el) el.innerHTML = '';
            // call the same logic by simulating then block
            location.reload();
        });

        initWebSocket();
        })
        .catch((err) => {
            localStorage.removeItem("token");
            statusEl.innerHTML =
                '<span class="text-danger"><i class="bi bi-exclamation-triangle-fill me-1"></i>' + err.message + "</span>";
            setTimeout(() => window.location.replace("index.html?auth=failed"), 2500);
        });

    document.getElementById("logoutBtn").addEventListener("click", function () {
        localStorage.removeItem("token");
        window.location.href = "index.html";
    });

    async function apiCall(endpoint, method = "GET", body = null) {
        const options = { method, headers: { Authorization: "Bearer " + token } };
        if (body) {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(body);
        }
        const res = await fetch(API_BASE + endpoint, options);
        let data = {};
        try {
            data = await res.json();
        } catch (_) {}
        if (!res.ok) throw new Error(data.detail || "Error");
        return data;
    }

    function parseChatContent(raw) {
        if (raw == null) return { text: "", reply: null };
        const s = typeof raw === "string" ? raw.trim() : String(raw);
        if (!s) return { text: "", reply: null };
        try {
            const o = JSON.parse(s);
            if (o && o.ciphertext) return { text: "Encrypted message", reply: null };
            if (o && o.kind === "text" && typeof o.body === "string")
                return { text: o.body, reply: o.reply && (o.reply.preview || o.reply.authorName) ? o.reply : null };
        } catch (_) {}
        return { text: s, reply: null };
    }

    function contentFromWs(data) {
        if (typeof data.message === "string") return data.message;
        if (typeof data.content === "string") return data.content;
        return "";
    }

    function sendTyping(active) {
        if (!ws || ws.readyState !== WebSocket.OPEN || !activeContact) return;
        ws.send(JSON.stringify({ type: "typing", to: activeContact, active: !!active }));
        lastTypingSent = active;
    }

    function sendReadReceipt() {
        if (!ws || ws.readyState !== WebSocket.OPEN || !activeContact) return;
        ws.send(JSON.stringify({ type: "read", to: activeContact }));
    }

    function setPeerTyping(active) {
        const bar = document.getElementById("peerTypingBar");
        if (!bar) return;
        if (active) {
            const name = activeContact ? activeContact.split("@")[0] : "Contact";
            bar.innerHTML =
                '<span class="tg-typing__dots" aria-hidden="true"><span></span><span></span><span></span></span> <span>' +
                escapeHtml(name) +
                " is typing…</span>";
            bar.classList.remove("d-none");
            clearTimeout(peerTypingTimer);
            peerTypingTimer = setTimeout(() => bar.classList.add("d-none"), 4000);
        } else {
            bar.classList.add("d-none");
        }
    }

    function escapeHtml(s) {
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    function markOutgoingRead() {
        document.querySelectorAll(".chat-bubble-row--me .chat-tick").forEach((el) => {
            el.classList.remove("bi-check2", "bi-check-all");
            el.classList.add("bi-check-all", "chat-tick--read");
        });
    }

    function markOutgoingDelivered() {
        document.querySelectorAll(".chat-bubble-row--me .bi-check2").forEach((el) => {
            el.classList.remove("bi-check2");
            el.classList.add("bi-check-all");
        });
    }

    function appendMessage(senderEmail, rawPayload, rawTime, isRead = false, isDelivered = false) {
        const messagesContainer = document.getElementById("chatMessages");
        const isMe = senderEmail === currentUserEmail;
        let text = "";
        let reply = null;
        if (rawPayload && typeof rawPayload === "object" && rawPayload.ciphertext) {
            text = "Encrypted message";
        } else {
            const rawStr = typeof rawPayload === "string" ? rawPayload : contentFromWs(rawPayload);
            const parsed = parseChatContent(rawStr);
            text = parsed.text;
            reply = parsed.reply;
        }

        const row = document.createElement("div");
        row.className = "chat-bubble-row " + (isMe ? "chat-bubble-row--me" : "chat-bubble-row--them");
        row.dataset.sender = senderEmail;

        const bubble = document.createElement("div");
        bubble.className = "chat-bubble";
        bubble.style.wordBreak = "break-word";

        if (reply) {
            const q = document.createElement("div");
            q.className = "chat-reply-quote";
            const who = reply.authorName || (reply.from || "").split("@")[0] || "User";
            q.innerHTML =
                '<div class="chat-reply-quote__bar"></div><div class="chat-reply-quote__body">' +
                '<span class="chat-reply-quote__who">' +
                escapeHtml(who) +
                "</span>" +
                '<span class="chat-reply-quote__txt">' +
                escapeHtml((reply.preview || "").slice(0, 200)) +
                "</span></div>";
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
            // Render Voice Note UI (FUNCTIONAL & REAL AUDIO)
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
                <div style="display:flex; align-items:center; gap:10px; background:rgba(0,0,0,0.2); padding:8px 12px; border-radius:20px; min-width:200px; opacity: ${base64Audio ? '1' : '0.5'};">
                    <button id="playBtn_${audioId}" 
                        ${base64Audio ? `onclick="window.playRealAudio('${audioId}', ${duration})"` : 'disabled'} 
                        style="background:var(--accent-color); color:#000; border:none; width:35px; height:35px; border-radius:50%; cursor:${base64Audio ? 'pointer' : 'not-allowed'}; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                        <i class="fa-solid ${base64Audio ? 'fa-play' : 'fa-microphone-slash'}"></i>
                    </button>
                    <div onclick="window.seekAudio(event, '${audioId}', ${duration})" style="flex:1; height:12px; display:flex; align-items:center; cursor:pointer; position:relative; min-width:120px;">
                        <div style="width:100%; height:4px; background:rgba(255,255,255,0.2); border-radius:2px; position:relative;">
                            <div id="progBar_${audioId}" style="position:absolute; left:0; top:0; height:100%; width:0%; background:var(--accent-color); border-radius:2px; transition: width 0.1s linear;"></div>
                            <div id="progDot_${audioId}" style="position:absolute; left:0; top:-4px; width:12px; height:12px; background:var(--accent-color); border-radius:50%; transition: left 0.1s linear;"></div>
                        </div>
                    </div>
                    <span id="time_${audioId}" style="font-size:0.8rem; font-family:monospace; min-width:32px; text-align:right;">${formatTime(duration)}</span>
                </div>
            `;

            // Use real audio duration from metadata (more accurate than tracked time)
            if (base64Audio) {
                // We use setTimeout or wait for the next tick to ensure innerHTML is rendered
                setTimeout(() => {
                    const audioEl = body.querySelector('#realAudio_' + audioId);
                    const timeEl = body.querySelector('#time_' + audioId);
                    
                    if (audioEl && timeEl) {
                        const updateDurationLabel = () => {
                            let realDur = Math.round(audioEl.duration);
                            // If duration is Infinity (common in WebM), fallback to the recorded duration from regex
                            if (!isFinite(realDur) || isNaN(realDur) || realDur <= 0) realDur = duration;
                            timeEl.textContent = formatTime(realDur);
                        };
                        
                        audioEl.addEventListener('loadedmetadata', updateDurationLabel);
                        audioEl.addEventListener('play', updateDurationLabel);
                        audioEl.addEventListener('timeupdate', () => {
                            if (audioEl.duration && isFinite(audioEl.duration) && audioEl.duration > 0) {
                                updateDurationLabel();
                            }
                        });
                        
                        // Force check if metadata already loaded
                        if (audioEl.readyState >= 1) updateDurationLabel();
                        audioEl.load();
                    }
                }, 0);
            }
        } else if (processedText.trim().includes("📎 [Attached:")) {
            // Render File Attachment UI
            const filenameMatch = processedText.match(/📎 \[Attached: (.*?)\]/);
            const filename = filenameMatch ? filenameMatch[1] : "Unknown File";
            let remainingText = processedText.replace(`📎 [Attached: ${filename}]`, "").trim();
            
            // Extract base64 data if present
            let fileData = "";
            const dataMatch = remainingText.match(/^(data:.*?base64,[^\s]+)/);
            if (dataMatch) {
                fileData = dataMatch[1];
                remainingText = remainingText.replace(fileData, "").trim();
            }

            const isImage = filename.match(/\.(jpeg|jpg|gif|png|webp)$/i);
            
            let attachHtml = `
                <div onclick="window.downloadMockFile('${filename}', '${fileData}')" style="display:flex; align-items:center; gap:10px; background:rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); padding:10px; border-radius:8px; margin-bottom: ${remainingText ? '8px' : '0'}; cursor:pointer; min-width: 200px; max-width: 100%; box-sizing: border-box;">
                    <div style="width:40px; height:40px; background:rgba(255,255,255,0.1); border-radius:8px; display:flex; align-items:center; justify-content:center; color:var(--text-main); font-size:1.5rem; flex-shrink: 0;">
                        <i class="fa-solid ${isImage ? 'fa-image' : 'fa-file-lines'}"></i>
                    </div>
                    <div style="flex:1; overflow:hidden;">
                        <div style="font-size:0.9rem; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(filename)}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted);">Click to open</div>
                    </div>
                    <button style="background:transparent; border:none; color:var(--text-muted); cursor:pointer;"><i class="fa-solid fa-download"></i></button>
                </div>
            `;
            if (isImage) {
                const imgSrc = fileData || `https://via.placeholder.com/400?text=${encodeURIComponent(filename)}`;
                bubble.style.padding = '0';
                bubble.style.background = 'transparent';
                bubble.style.border = 'none';
                bubble.style.overflow = 'hidden';
                
                const dateObj = rawTime ? new Date(rawTime) : new Date();
                const displayTime = dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const timeOverlay = `<div style="position: absolute; bottom: 8px; right: 8px; background: rgba(0,0,0,0.5); color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 0.7rem; display: flex; align-items: center; gap: 4px; backdrop-filter: blur(4px); z-index: 10;">${displayTime}${isMe ? (isRead ? '<i class="bi bi-check-all" style="color:#34B7F1"></i>' : (isDelivered ? '<i class="bi bi-check-all"></i>' : '<i class="bi bi-check2"></i>')) : ''}</div>`;
                
                attachHtml = `
                    <div onclick="window.downloadMockFile('${filename}', '${fileData}')" style="position: relative; cursor:pointer; width: 100%; height: 100%;">
                        <img src="${imgSrc}" style="width: 100%; max-height: 300px; object-fit: cover; display: block; border-radius: 12px;" />
                        ${timeOverlay}
                    </div>
                `;
                body.innerHTML = attachHtml + (remainingText ? `<div style="padding: 10px; color: var(--text-main);">${escapeHtml(remainingText)}</div>` : '');
                // We'll handle meta hiding later in the function
            } else {
                body.innerHTML = attachHtml + (remainingText ? escapeHtml(remainingText) : '');
            }
        } else {
            // Standard text message
            body.textContent = processedText;
        }
        
        // If we detect an encrypted payload placeholder, attempt to reload decrypted history
        if (text === "Encrypted message") {
            console.warn("Detected encrypted message placeholder for", senderEmail);
            // If this message belongs to the open chat, try to reload from server (which performs server-side decryption)
            if (activeContact && activeContact === senderEmail) {
                (async () => {
                    try {
                        const data = await apiCall("/get-messages?contact_email=" + encodeURIComponent(activeContact));
                        const list = document.getElementById("chatMessages");
                        list.innerHTML = "";
                        data.messages.forEach((msg) => appendMessage(msg.sender, msg.content, msg.timestamp, msg.is_read, msg.is_delivered));
                        list.scrollTop = list.scrollHeight;
                    } catch (e) {
                        console.error("Failed to refresh messages for decryption:", e);
                    }
                })();
            }
        }
        
        if (isSelfDestructing) {
            const sdTag = document.createElement("div");
            sdTag.innerHTML = '<i class="fa-solid fa-stopwatch"></i> Self-Destructing Message';
            sdTag.style.fontSize = "0.7rem";
            sdTag.style.color = "#ff3333";
            sdTag.style.marginBottom = "4px";
            sdTag.style.fontWeight = "bold";
            body.prepend(sdTag);
        }
        
        const meta = document.createElement("div");
        meta.className = "chat-bubble-meta";
        const dateObj = rawTime ? new Date(rawTime) : new Date();
        const displayTime = dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        
        const tick = document.createElement("i");
        let tickClass = "bi-check2 chat-tick";
        if (isRead) tickClass = "bi-check-all chat-tick--read";
        else if (isDelivered) tickClass = "bi-check-all chat-tick";
        tick.className = "bi " + (isMe ? tickClass : "");
        meta.appendChild(document.createElement("span")).textContent = displayTime;
        if (isMe) meta.appendChild(tick);

        if (!body.innerHTML.includes('position: absolute')) {
            bubble.appendChild(meta);
        }
        bubble.appendChild(body);
        row.appendChild(bubble);

        const reactRow = document.createElement("div");
        reactRow.className = "chat-reactions";
        const chips = document.createElement("div");
        chips.className = "chat-reaction-chips";
        reactRow.appendChild(chips);
        const toolbar = document.createElement("div");
        toolbar.className = "chat-reactions__toolbar";
        
        // Emojis on click instead of hover
        bubble.addEventListener("click", (e) => {
            e.stopPropagation();
            // Close any other open toolbars
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
                addReactionChip(chips, emo);
            });
            toolbar.appendChild(b);
        });
        reactRow.appendChild(toolbar);
        row.appendChild(reactRow);

        row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, row, text);
        });

        messagesContainer.appendChild(row);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        updateScrollFab();
    }

    function addReactionChip(chipsEl, emo) {
        const span = document.createElement("span");
        span.className = "chat-reaction-chip";
        span.textContent = emo + " ·1";
        chipsEl.appendChild(span);
    }

    function openContextMenu(x, y, row, text) {
        contextTarget = { row, text };
        const menu = document.getElementById("msgContextMenu");
        menu.classList.remove("d-none");
        menu.style.left = Math.min(x, window.innerWidth - 200) + "px";
        menu.style.top = Math.min(y, window.innerHeight - 220) + "px";
    }

    function closeContextMenu() {
        const menu = document.getElementById("msgContextMenu");
        menu.classList.add("d-none");
        contextTarget = null;
    }

    document.addEventListener("click", () => {
        closeContextMenu();
        closeEmojiPopover();
        document.getElementById("chatHeaderMenu")?.classList.add("d-none");
        document.querySelectorAll(".chat-reactions__toolbar.show").forEach(t => t.classList.remove("show"));
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closeContextMenu();
            closeEmojiPopover();
            closeInChatSearch();
            cancelReply();
            document.querySelectorAll(".chat-reactions__toolbar.show").forEach(t => t.classList.remove("show"));
        }
    });

    window.toggleSearchModal = function () {
        const modal = document.getElementById("searchModal");
        modal.classList.toggle("d-none");
        if (!modal.classList.contains("d-none")) document.getElementById("searchInput").focus();
    };

    document.getElementById("searchForm").addEventListener("submit", async function (e) {
        e.preventDefault();
        const q = document.getElementById("searchInput").value;
        const resultsContainer = document.getElementById("searchResults");
        resultsContainer.innerHTML =
            '<span class="text-white-50 small text-center d-block"><span class="spinner-border spinner-border-sm me-2"></span>Searching...</span>';
        try {
            const cleaned = (q || '').replace(/\D/g, '');
            // Require exactly 14 digits for search (user-id)
            if (!/^\d{14}$/.test(cleaned)) {
                resultsContainer.innerHTML = '<span class="text-white-50 small text-center d-block">Enter a 14-digit numeric ID to search.</span>';
                return;
            }
            const data = await apiCall("/search-users", "POST", { contact_email: cleaned });
            resultsContainer.innerHTML = "";
            if (data.users.length === 0) {
                resultsContainer.innerHTML = '<span class="text-white-50 small text-center d-block">No users found.</span>';
                return;
            }
            data.users.forEach((u) => {
                const div = document.createElement("div");
                div.className = "d-flex justify-content-between align-items-center p-3 rounded bg-dark border border-secondary mb-2";
                div.style.transition = "all 0.2s ease";
                div.onmouseover = () => { div.style.borderColor = "var(--accent-color)"; div.style.background = "rgba(255,255,255,0.05)"; };
                div.onmouseout = () => { div.style.borderColor = "var(--border-color)"; div.style.background = "var(--bg-dark)"; };

                const display = u.display_name ? u.display_name : 'Unknown User';
                const avatarHtml = u.avatar
                    ? (`<div style="width:42px; height:42px; border-radius:50%; overflow:hidden; margin-right:5px; cursor:pointer; box-shadow:0 0 10px rgba(0,0,0,0.5);">` +
                        `<img src="${escapeHtml(u.avatar)}" style="width:100%; height:100%; object-fit:cover;">` +
                        `</div>`)
                    : (`<div style="width:42px; height:42px; border-radius:50%; background:var(--accent-color); color:#000; display:flex; align-items:center; justify-content:center; margin-right:5px; font-size:1.1rem; font-weight:bold;">${escapeHtml(display.charAt(0).toUpperCase())}</div>`);

                div.innerHTML = `
                    <div style="display:flex; align-items:center; gap:15px; flex:1; min-width:0;">
                        ${avatarHtml}
                        <div style="display:flex; flex-direction:column; min-width:0;">
                            <span style="color:var(--text-main); font-weight:600; font-size:1rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(display)}</span>
                            <span style="color:var(--accent-color); font-size:0.75rem; opacity:0.7;">Click avatar to view profile</span>
                        </div>
                    </div>
                    <button onclick="sendChatRequest('${escapeHtml(u.contact_email)}', '${escapeHtml(display)}')" 
                            style="background:var(--accent-color); color:#000; border:none; padding: 8px 15px; border-radius:10px; display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:600; transition: transform 0.2s;" 
                            onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
                        <i class="bi bi-person-plus-fill"></i> Add
                    </button>
                `;

                // make avatar open profile view when clicked
                resultsContainer.appendChild(div);
                const avatarEl = div.querySelector('img') ? div.querySelector('img').parentElement : div.querySelector('div');
                if (avatarEl) {
                    avatarEl.addEventListener('click', () => showViewProfile(u.contact_email, display));
                }
            });
        } catch (err) {
            resultsContainer.innerHTML = '<span class="text-danger small text-center d-block">' + err.message + "</span>";
        }
    });

    window.sendChatRequest = async function (email, displayName) {
        const nameLabel = displayName || 'this user';
        if (!confirm("Send chat request to " + nameLabel + "?")) return;
        try {
            await apiCall("/send-request", "POST", { contact_email: email });
            alert("Request sent!");
            toggleSearchModal();
        } catch (err) {
            alert(err.message);
        }
    };

    window.loadRequests = async function () {
        try {
            const data = await apiCall("/get-requests");
            const area = document.getElementById("pendingRequestsArea");
            const list = document.getElementById("pendingRequestsList");
            const count = document.getElementById("pendingCount");
            list.innerHTML = "";
            if (data.requests.length === 0) {
                area.classList.add("d-none");
                return;
            }
            area.classList.remove("d-none");
            count.textContent = data.requests.length;
            data.requests.forEach((req) => {
                const div = document.createElement("div");
                div.className = "chat-request-item";
                const senderName = req.display_name || "New Contact";
                
                const avatarHtml = req.avatar
                    ? `<img src="${req.avatar}" style="width:36px; height:36px; border-radius:50%; object-fit:cover;">`
                    : `<div style="width:36px; height:36px; border-radius:50%; background:var(--accent-color); color:#000; display:flex; align-items:center; justify-content:center; font-weight:bold;">${senderName[0].toUpperCase()}</div>`;

                div.innerHTML = `
                    <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
                        ${avatarHtml}
                        <div style="display:flex; flex-direction:column; min-width:0;">
                            <div style="font-weight:600; font-size:0.95rem; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(senderName)}</div>
                            ${req.user_id ? `<div style="font-size:0.75rem; color:var(--accent-color); opacity:0.8; font-family:monospace;">ID: ${req.user_id}</div>` : ''}
                        </div>
                    </div>
                    <div class="chat-request-actions">
                        <button class="chat-btn chat-btn-accept" data-acc="${escapeHtml(req.sender)}">Accept</button>
                        <button class="chat-btn chat-btn-decline" data-rej="${escapeHtml(req.sender)}">Decline</button>
                    </div>`;
                div.querySelector("[data-acc]").onclick = () => acceptRequest(req.sender);
                div.querySelector("[data-rej]").onclick = () => rejectRequest(req.sender);
                list.appendChild(div);
                // Runtime sanitization: ensure each contact row only contains avatar and the name element
                sanitizeContactRow(div);
            });
        } catch (err) {
            console.error("Error loading requests:", err);
        }
    };

    window.acceptRequest = async function (email) {
        try {
            await apiCall("/accept-request", "POST", { contact_email: email });
            loadRequests();
            loadContacts();
        } catch (err) {
            alert(err.message);
        }
    };
    window.rejectRequest = async function (email) {
        try {
            await apiCall("/reject-request", "POST", { contact_email: email });
            loadRequests();
        } catch (err) {
            alert(err.message);
        }
    };

    window.loadContacts = async function () {
        try {
            const data = await apiCall("/get-contacts");
            contactsCache = data.contacts || [];
            
            // Sync unreadMap with server counts for offline/old messages
            contactsCache.forEach(c => {
                const email = c.contact_email;
                if (email !== activeContact) {
                    unreadMap.set(email, c.unread_count || 0);
                }
            });
            const list = document.getElementById("contactsList");
            list.innerHTML = "";
            if (contactsCache.length === 0) {
                list.innerHTML =
                    '<div class="text-center text-white-50 small mt-3">No contacts yet.<br>Click <i class="bi bi-search"></i> to find users.</div>';
                return;
            }
            const q = (document.getElementById("contactFilterInput").value || "").trim().toLowerCase();
            const visibleContacts = contactsCache.filter((contactData) => {
                if (!q) return true;
                // Only allow searching by display_name or user_id (no email local-part)
                const contact = typeof contactData === 'string' ? contactData : (contactData.contact_email || '');
                const name = (contactData.display_name || '').toLowerCase();
                const idText = contactData.id ? String(contactData.id) : (contactData.user_id || '');
                return (name && name.includes(q)) || idText.toLowerCase().includes(q);
            });
            if (visibleContacts.length === 0) {
                list.innerHTML = '<div class="text-center text-white-50 small mt-3">No matching contacts.</div>';
                return;
            }
            visibleContacts.forEach((contactData) => {
                const contact = typeof contactData === 'string' ? contactData : contactData.contact_email;
                // Show display_name if present, otherwise fall back to contact email local-part
                // show only alias (display_name). If absent, leave name empty (do not show email)
                const rawName = contactData.display_name || '';
                const bio = contactData.bio || "";
                const numericId = contactData.id || contactData.user_id || null;

                const div = document.createElement("div");
                const displayName = rawName;
                const isActive = activeContact === contact;
                const unreadCount = unreadMap.get(contact) || 0;
                div.className = "chat-contact-item" + (isActive ? " chat-contact-item--active" : "");
                div.dataset.email = contact;

                // Build contact row using pure DOM to avoid innerHTML injection issues
                // Avatar element
                const avatarEl = document.createElement('div');
                avatarEl.className = 'chat-contact-item__avatar';
                if (contactData.avatar) {
                    avatarEl.style.cursor = 'pointer';
                    const img = document.createElement('img');
                    img.src = contactData.avatar;
                    img.style.cssText = 'width:100%; height:100%; object-fit:cover; border-radius:50%;';
                    avatarEl.appendChild(img);
                } else {
                    avatarEl.textContent = ((displayName && displayName.charAt(0)) || '?').toUpperCase();
                }
                div.appendChild(avatarEl);

                // Name element (no wrapper body, just the name)
                const nameEl = document.createElement('div');
                nameEl.className = 'chat-contact-item__name';
                nameEl.style.flex = '1';
                nameEl.textContent = displayName;  // Direct text, no fallback
                div.appendChild(nameEl);

                // Unread Badge
                if (unreadCount > 0) {
                    const badge = document.createElement('div');
                    badge.style.cssText = 'background: #e25c5c; color: white; border-radius: 50%; font-size: 0.75rem; font-weight: bold; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; margin-left: 10px; box-shadow: 0 0 5px rgba(226, 92, 92, 0.5);';
                    badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
                    div.appendChild(badge);
                }

                // Delete Contact Button
                const delBtn = document.createElement('button');
                delBtn.innerHTML = '<i class="bi bi-trash"></i>';
                delBtn.style.cssText = 'border:none; background:transparent; color:rgba(255, 80, 80, 0.6); display:flex; align-items:center; justify-content:center; z-index:10; font-size:1.1rem; padding:4px; cursor:pointer; opacity:0; transition: all 0.2s ease; margin-left: 8px;';
                delBtn.title = 'Remove Contact';
                
                // Show delete button when hovering the contact row
                div.addEventListener('mouseenter', () => {
                    delBtn.style.opacity = '0.7';
                });
                div.addEventListener('mouseleave', () => {
                    delBtn.style.opacity = '0';
                });
                delBtn.onmouseover = () => {
                    delBtn.style.color = '#ff4d4d';
                    delBtn.style.opacity = '1';
                    delBtn.style.transform = 'scale(1.1)';
                };
                delBtn.onmouseout = () => {
                    delBtn.style.color = 'rgba(255, 80, 80, 0.6)';
                    delBtn.style.opacity = '0.7';
                    delBtn.style.transform = 'scale(1)';
                };

                delBtn.onclick = async (ev) => {
                    ev.stopPropagation(); // prevent opening chat
                    if (confirm(`Are you sure you want to remove ${displayName || contact} from your contacts?`)) {
                        try {
                            await apiCall('/delete-contact', 'POST', { contact_email: contact });
                            if (activeContact === contact) {
                                document.getElementById("chatMessages").innerHTML = "";
                                document.getElementById("chatHeader").innerHTML = "";
                                document.getElementById("chatInput").disabled = true;
                                activeContact = null;
                            }
                            loadContacts();
                        } catch (e) {
                            alert(e.message);
                        }
                    }
                };
                div.appendChild(delBtn);

                // Avatar click opens profile view; row click opens chat
                if (contactData.avatar) {
                    avatarEl.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        showViewProfile(contact, displayName);
                    });
                } else {
                    avatarEl.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        showViewProfile(contact, displayName);
                    });
                }
                div.onclick = () => openChat(contact);
                list.appendChild(div);
            });
        } catch (err) {
            console.error("Error loading contacts:", err);
        }
    };

    window.openChat = async function (email) {
        activeContact = email;
        unreadMap.set(email, 0);
        closeInChatSearch();
        const ins = document.getElementById("inChatSearchInput");
        if (ins) {
            ins.value = "";
            ins.dispatchEvent(new Event("input"));
        }
        document.getElementById("emptyChatState").classList.add("d-none");
        const hdr = document.getElementById("chatHeader");
        hdr.classList.remove("d-none");
        hdr.classList.add("d-flex");
        document.getElementById("chatQuickTools")?.classList.remove("d-none");
        document.getElementById("activeChatContainer").classList.remove("d-none");

        // Hide sidebar when chat is opened
        toggleSidebar(false);

        // Fetch peer profile for bio/banner and update header
        fetch(API_BASE + "/get-profile?email=" + encodeURIComponent(email), {
            headers: { "Authorization": "Bearer " + token }
        })
        .then(r => r.json())
        .then(p => {
            const name = p.display_name || email.split("@")[0];
            
            // Update name in header
            const nameEl = document.getElementById("activeContactName");
            if (nameEl) nameEl.textContent = name;
            
            // Update bio (hide if empty)
            const bioEl = document.getElementById("activeContactBio");
            if (bioEl) {
                bioEl.textContent = p.bio || "";
                bioEl.style.display = p.bio ? "block" : "none";
            }

            // Update avatar in header
            const av = document.getElementById("chatHeaderAvatar");
            if (av) {
                if (p.avatar) {
                    av.style.background = "transparent";
                    av.innerHTML = `<img src="${p.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` ;
                } else {
                    av.style.background = "linear-gradient(135deg, var(--accent-color), #00ff88)";
                    av.style.color = "#000";
                    av.innerHTML = escapeHtml(name.charAt(0).toUpperCase());
                }
            }

            // Hide ID line (keep header clean)
            const idEl = document.getElementById('activeContactId');
            if (idEl) idEl.style.display = 'none';

            // Banner
            const banner = document.getElementById("peerBanner");
            if (banner) banner.style.display = "none"; // hidden for cleaner look
        });

        loadContacts();

        const list = document.getElementById("chatMessages");
        list.innerHTML =
            '<div class="text-center text-white-50 small w-100 py-3"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div>';
        try {
            const data = await apiCall("/get-messages?contact_email=" + encodeURIComponent(email));
            list.innerHTML = "";
            if (data.messages.length === 0) {
                list.innerHTML =
                    '<div class="chat-empty-inline w-100 text-center text-white-50 small py-4">No messages yet. Say hello 👋</div>';
            } else {
                data.messages.forEach((msg) => {
                    appendMessage(msg.sender, msg.content, msg.timestamp, msg.is_read, msg.is_delivered);
                });
            }
            list.scrollTop = list.scrollHeight;
            sendReadReceipt();
        } catch (err) {
            list.innerHTML = '<div class="text-danger small w-100 py-3 text-center">Failed to load messages.</div>';
        }
        updateScrollFab();
    };

    window.toggleSidebar = function(show) {
        const container = document.getElementById("chatAppContainer");
        if (!container) return;
        if (typeof show === 'undefined') {
            // toggle when no explicit argument provided
            container.classList.toggle("sidebar-hidden");
            return;
        }
        if (show) {
            container.classList.remove("sidebar-hidden");
        } else {
            container.classList.add("sidebar-hidden");
        }
    };

    window.closeChat = function () {
        activeContact = null;
        sendTyping(false);
        toggleSidebar(true); // Show sidebar again when closing chat
        document.getElementById("emptyChatState").classList.remove("d-none");
        const hdr2 = document.getElementById("chatHeader");
        hdr2.classList.add("d-none");
        hdr2.classList.remove("d-flex");
        document.getElementById("chatHeaderMenu")?.classList.add("d-none");
        document.getElementById("chatQuickTools")?.classList.add("d-none");
        document.getElementById("activeChatContainer").classList.add("d-none");
        clearPinnedMessage();
        cancelReply();
        setPeerTyping(false);
        loadContacts();
    };

    const messagesContainer = document.getElementById("chatMessages");
    const chatForm = document.getElementById("chatForm");
    const chatInput = document.getElementById("chatInput");
    const contactFilterInput = document.getElementById("contactFilterInput");
    const pinnedMessageBar = document.getElementById("pinnedMessageBar");
    const pinnedMessageText = document.getElementById("pinnedMessageText");

    chatInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            chatForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        }
    });

    if (contactFilterInput) contactFilterInput.addEventListener("input", () => loadContacts());

    window.notifyAction = function (label) {
        statusEl.innerHTML =
            '<span class="text-info" style="font-size:1.1rem; font-weight:bold;"><i class="bi bi-magic me-1"></i>' + escapeHtml(label) + " — coming soon!</span>";
        setTimeout(() => {
            if (statusEl.innerText.includes("coming soon")) statusEl.innerText = "";
        }, 3000);
    };

    window.insertQuickText = function (text) {
        if (!activeContact) return;
        chatInput.value = (chatInput.value ? chatInput.value + " " : "") + text;
        chatInput.dispatchEvent(new Event("input"));
        chatInput.focus();
    };

    window.pinLastMessage = function () {
        const rows = messagesContainer.querySelectorAll(".chat-bubble-row");
        if (!rows.length) {
            notifyAction("No messages to pin");
            return;
        }
        const last = rows[rows.length - 1];
        const t = last.querySelector(".chat-bubble-body");
        if (!t) return;
        pinnedMessageText.textContent = t.textContent.trim();
        pinnedMessageBar.classList.remove("d-none");
    };

    window.clearPinnedMessage = function () {
        pinnedMessageText.textContent = "";
        pinnedMessageBar.classList.add("d-none");
    };

    window.exportCurrentChat = function () {
        if (!activeContact) return;
        const rows = Array.from(messagesContainer.querySelectorAll(".chat-bubble-row .chat-bubble-body"))
            .map((el) => el.innerText.trim())
            .filter(Boolean);
        if (!rows.length) {
            notifyAction("No messages to export");
            return;
        }
        try {
            navigator.clipboard.writeText(rows.join("\n\n"));
            statusEl.innerHTML =
                '<span class="text-success"><i class="bi bi-clipboard-check me-1"></i>Chat copied to clipboard.</span>';
        } catch (_) {
            notifyAction("Clipboard unavailable");
        }
    };

    window.toggleFocusMode = function () {
        document.body.classList.toggle("focus-mode");
    };

    window.scrollToBottom = function () {
        if (messagesContainer) {
            messagesContainer.scrollTo({
                top: messagesContainer.scrollHeight,
                behavior: "smooth"
            });
        }
    };

    window.handleChatScroll = function () {
        updateScrollFab();
    };

    window.updateScrollFab = function () {
        const fab = document.getElementById("scrollToBottomBtn");
        if (!fab || !messagesContainer) return;
        
        // Show FAB if we scroll up more than 150px from bottom
        const distFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
        if (distFromBottom > 150) {
            fab.classList.remove("d-none");
        } else {
            fab.classList.add("d-none");
        }
    };

    window.cancelReply = function () {
        replyDraft = null;
        const bar = document.getElementById("replyDraftBar");
        if (bar) bar.classList.add("d-none");
    };

    window.startReplyTo = function (text) {
        if (!activeContact || !contextTarget) return;
        const author = contextTarget.row.dataset.sender || "";
        replyDraft = { sender: author, snippet: (text || "").slice(0, 140) };
        const bar = document.getElementById("replyDraftBar");
        document.getElementById("replyDraftPreview").textContent =
            (author.split("@")[0] || author) + ": " + replyDraft.snippet;
        bar.classList.remove("d-none");
        closeContextMenu();
        chatInput.focus();
    };

    window.ctxCopyMessage = function () {
        if (!contextTarget) return;
        navigator.clipboard.writeText(contextTarget.text).catch(() => {});
        closeContextMenu();
        statusEl.innerHTML = '<span class="text-success small">Copied.</span>';
        setTimeout(() => (statusEl.innerText = ""), 1500);
    };

    window.ctxReplyMessage = function () {
        if (!contextTarget) return;
        startReplyTo(contextTarget.text);
    };

    window.toggleInChatSearch = function () {
        const p = document.getElementById("inChatSearchPanel");
        p.classList.toggle("d-none");
        if (!p.classList.contains("d-none")) document.getElementById("inChatSearchInput").focus();
    };

    function closeInChatSearch() {
        const p = document.getElementById("inChatSearchPanel");
        if (p) p.classList.add("d-none");
    }

    window.toggleEmojiPopover = function (ev) {
        if (ev) ev.stopPropagation();
        const pop = document.getElementById("emojiPopover");
        emojiPopoverOpen = !emojiPopoverOpen;
        pop.classList.toggle("d-none", !emojiPopoverOpen);
    };

    function closeEmojiPopover() {
        const pop = document.getElementById("emojiPopover");
        if (pop) pop.classList.add("d-none");
        emojiPopoverOpen = false;
    }

    document.getElementById("emojiPopover")?.addEventListener("click", (e) => e.stopPropagation());

    document.getElementById("emojiPopoverGrid")?.addEventListener("click", (e) => {
        const btn = e.target.closest(".tg-emoji-btn");
        if (!btn) return;
        insertQuickText(btn.textContent.trim());
        closeEmojiPopover();
    });

    (function fillEmojiGrid() {
        const ep = document.getElementById("emojiPopoverGrid");
        if (!ep) return;
        ep.innerHTML = "";
        EMOJI_GRID.forEach((emo) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "tg-emoji-btn";
            b.textContent = emo;
            ep.appendChild(b);
        });
    })();

    document.getElementById("inChatSearchInput")?.addEventListener("input", function () {
        const q = this.value.trim().toLowerCase();
        messagesContainer.querySelectorAll(".chat-bubble-row").forEach((row) => {
            const body = row.querySelector(".chat-bubble-body");
            const t = (body && body.textContent) || "";
            row.classList.toggle("chat-bubble-row--dim", q.length > 0 && !t.toLowerCase().includes(q));
        });
    });

    messagesContainer.addEventListener("scroll", () => {
        if (typeof window.updateScrollFab === "function") {
            window.updateScrollFab();
        }
    });

    function initWebSocket() {
        if (requestsPollTimer) clearInterval(requestsPollTimer);
        ws = new WebSocket(WS_BASE + "/ws?token=" + encodeURIComponent(token));

        ws.onopen = function () {
            statusEl.innerHTML =
                '<span style="color:var(--nv-success);"><i class="bi bi-circle-fill me-1" style="font-size:.55rem;"></i>Connected</span>';
            loadRequests();
            loadContacts();
            requestsPollTimer = setInterval(() => loadRequests(), 12000);
        };

        ws.onmessage = function (event) {
            const data = JSON.parse(event.data);
            // WebRTC / Call signaling messages
            if (data.type === "call") {
                if (data.action === "offer_call") {
                    // will also receive the webrtc offer shortly; just store who's calling
                    callingContact = data.from || data.user;
                } else if (data.action === "call_cancelled") {
                    window.endCall();
                }
                return;
            }
            if (data.type === "webrtc") {
                handleWebRTCMessage(data.from || data.user, data.signal);
                return;
            }
            if (data.type === "typing") {
                if (activeContact && data.from === activeContact) setPeerTyping(!!data.active);
                return;
            }
            if (data.type === "read_receipt") {
                if (activeContact && data.reader === activeContact) markOutgoingRead();
                return;
            }
            if (data.type === "delivery_receipt") {
                if (activeContact && data.reader === activeContact) markOutgoingDelivered();
                return;
            }

            const sender = data.user;
            const isForActiveChat =
                activeContact &&
                (sender === activeContact || (sender === currentUserEmail && data.to === activeContact));
            if (isForActiveChat) {
                setPeerTyping(false);
                appendMessage(sender, data, data.timestamp);
                if (sender === activeContact && sender !== currentUserEmail) sendReadReceipt();
            } else {
                if (sender && sender !== currentUserEmail) {
                    unreadMap.set(sender, (unreadMap.get(sender) || 0) + 1);
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "delivered", to: sender }));
                    }
                }
                loadContacts();
                const rowEl =
                    sender &&
                    Array.from(document.querySelectorAll(".chat-contact-item")).find((el) => el.dataset.email === sender);
                if (rowEl) {
                    rowEl.classList.add("chat-contact-item--flash");
                    setTimeout(() => rowEl.classList.remove("chat-contact-item--flash"), 2400);
                }
            }
        };

        ws.onclose = function () {
            statusEl.innerHTML =
                '<span class="text-danger"><i class="bi bi-wifi-off" aria-hidden="true"></i> Reconnecting…</span>';
            if (requestsPollTimer) clearInterval(requestsPollTimer);
            setTimeout(initWebSocket, 3000);
        };

        ws.onerror = function () {
            statusEl.innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-circle me-1"></i>Connection error.</span>';
        };
    }

    chatForm.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!activeContact) return;
        const msg = chatInput.value.trim();
        
        // Return if nothing to send
        if (!msg && !selectedFile && !isRecording) return;
        
        let payloadText = msg;
        
        if (selectedFile) {
            payloadText = `📎 [Attached: ${selectedFile.name}] ${selectedFile.data || ''}\n${payloadText}`;
        }
        if (isSelfDestruct) {
            payloadText = `⏳ [Self-Destructing]\n${payloadText}`;
        }

        let payload = payloadText;
        if (replyDraft) {
            payload = JSON.stringify({
                kind: "text",
                body: payloadText,
                reply: {
                    from: replyDraft.sender,
                    authorName: (replyDraft.sender || "").split("@")[0],
                    preview: replyDraft.snippet,
                },
            });
        }
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ to: activeContact, content: payload }));
        }
        
        chatInput.value = "";
        chatInput.style.height = "auto";
        sendTyping(false);
        cancelReply();
        if (selectedFile) cancelAttachment();
        if (isSelfDestruct) toggleSelfDestruct();
        chatInput.dispatchEvent(new Event("input"));
        chatInput.focus();
    });

    // --- NEW FRONTEND FEATURES LOGIC ---
    window.handleFileSelection = function(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        // Read file as Base64 to actually send and display it!
        const reader = new FileReader();
        reader.onload = function(e) {
            selectedFile = {
                name: file.name,
                data: e.target.result,
                isImage: file.type.startsWith('image/')
            };
            document.getElementById("attachmentFileName").textContent = file.name;
            document.getElementById("attachmentPreviewBar").classList.remove("d-none");
            chatInput.dispatchEvent(new Event("input"));
        };
        reader.readAsDataURL(file);
    };

    window.cancelAttachment = function() {
        selectedFile = null;
        document.getElementById("fileAttachment").value = "";
        document.getElementById("attachmentPreviewBar").classList.add("d-none");
        chatInput.dispatchEvent(new Event("input"));
    };

    window.toggleSelfDestruct = function() {
        isSelfDestruct = !isSelfDestruct;
        const btn = document.getElementById("selfDestructBtn");
        if (isSelfDestruct) {
            btn.style.color = "#ff3333";
            statusEl.innerHTML = '<span class="text-danger"><i class="fa-solid fa-stopwatch"></i> Disappearing mode ON</span>';
        } else {
            btn.style.color = "var(--text-muted)";
            statusEl.innerText = "";
        }
    };

    window.playRealAudio = function(audioId, totalDuration) {
        const btn = document.getElementById(`playBtn_${audioId}`);
        const progBar = document.getElementById(`progBar_${audioId}`);
        const progDot = document.getElementById(`progDot_${audioId}`);
        const timeLabel = document.getElementById(`time_${audioId}`);
        const realAudio = document.getElementById(`realAudio_${audioId}`);
        
        if (btn.dataset.playing === "true") {
            // Stop it
            btn.dataset.playing = "false";
            btn.innerHTML = '<i class="fa-solid fa-play"></i>';
            clearInterval(btn.dataset.interval);
            if (realAudio) realAudio.pause();
            return;
        }
        
        // Play it
        btn.dataset.playing = "true";
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        
        if (realAudio) {
            realAudio.play().catch(e => console.error("Audio playback failed:", e));
            btn.dataset.interval = setInterval(() => {
                const current = realAudio.currentTime;
                // Use totalDuration as fallback if realAudio.duration is Infinity or NaN
                const total = (realAudio.duration && isFinite(realAudio.duration) && realAudio.duration > 0) 
                             ? realAudio.duration 
                             : totalDuration;
                
                if (realAudio.ended || current >= total) {
                    clearInterval(btn.dataset.interval);
                    btn.dataset.playing = "false";
                    btn.innerHTML = '<i class="fa-solid fa-play"></i>';
                    progBar.style.width = "0%";
                    progDot.style.left = "0%";
                    timeLabel.textContent = formatTime(totalDuration);
                } else {
                    const percent = (current / total) * 100;
                    progBar.style.width = percent + "%";
                    progDot.style.left = percent + "%";
                    // Display elapsed time instead of remaining to be more consistent
                    timeLabel.textContent = formatTime(current);
                }
            }, 100);
        } else {
            // Mock fallback
            let currentMs = 0;
            const totalMs = totalDuration * 1000;
            btn.dataset.interval = setInterval(() => {
                currentMs += 100;
                if (currentMs >= totalMs) {
                    clearInterval(btn.dataset.interval);
                    btn.dataset.playing = "false";
                    btn.innerHTML = '<i class="fa-solid fa-play"></i>';
                    progBar.style.width = "0%";
                    progDot.style.left = "0%";
                    timeLabel.textContent = formatTime(totalDuration);
                } else {
                    const percent = (currentMs / totalMs) * 100;
                    progBar.style.width = percent + "%";
                    progDot.style.left = percent + "%";
                    timeLabel.textContent = formatTime(currentMs / 1000);
                }
            }, 100);
        }
    };

    window.seekAudio = function(e, audioId, totalDuration) {
        const bar = e.currentTarget;
        const rect = bar.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const percent = Math.min(Math.max(offsetX / rect.width, 0), 1);
        const realAudio = document.getElementById(`realAudio_${audioId}`);
        
        if (realAudio) {
            const total = (realAudio.duration && isFinite(realAudio.duration) && realAudio.duration > 0) 
                         ? realAudio.duration 
                         : totalDuration;
            realAudio.currentTime = percent * total;
            
            // Update UI immediately
            document.getElementById(`progBar_${audioId}`).style.width = (percent * 100) + "%";
            document.getElementById(`progDot_${audioId}`).style.left = (percent * 100) + "%";
            document.getElementById(`time_${audioId}`).textContent = formatTime(realAudio.currentTime);
        }
    };

    window.downloadMockFile = function(filename, fileData) {
        let url;
        let blobUrl = false;
        if (fileData && fileData.startsWith('data:')) {
            url = fileData; // Direct base64 download
        } else {
            const blob = new Blob(["This is a securely encrypted file generated for demonstration."], { type: "text/plain" });
            url = URL.createObjectURL(blob);
            blobUrl = true;
        }
        
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (blobUrl) URL.revokeObjectURL(url);
    };

    // --- Call / WebRTC ---
    function _showCallBox(mode, peer) {
        const overlay = document.getElementById('callOverlay');
        const statusEl2 = document.getElementById('callStatus');
        const peerEl = document.getElementById('callPeer');
        const acceptBtn = document.getElementById('acceptCallBtn');
        const rejectBtn = document.getElementById('rejectCallBtn');
        const endBtn = document.getElementById('endCallBtn');
        overlay.classList.remove('d-none');
        
        // Resolve display name from cache
        const peerName = (() => {
            if (!peer) return 'Contact';
            const c = contactsCache.find(x => x.contact_email === peer);
            return (c && c.display_name) ? c.display_name : peer.split('@')[0];
        })();
        
        peerEl.textContent = peerName;
        if (mode === 'incoming') {
            statusEl2.textContent = peerName + ' is calling…';
            acceptBtn.classList.remove('d-none');
            rejectBtn.classList.remove('d-none');
            endBtn.classList.add('d-none');
            acceptBtn.onclick = window.acceptCall;
            rejectBtn.onclick = window.rejectCall;
        } else {
            statusEl2.textContent = 'Calling ' + peerName + '…';
            acceptBtn.classList.add('d-none');
            rejectBtn.classList.add('d-none');
            endBtn.classList.remove('d-none');
            endBtn.onclick = window.endCall;
        }
    }

    function _hideCallBox() {
        const overlay = document.getElementById('callOverlay');
        if (overlay) overlay.classList.add('d-none');
        document.getElementById('inCallVideos')?.classList.add('d-none');
        const lv = document.getElementById('localVideo');
        const rv = document.getElementById('remoteVideo');
        if (lv) lv.srcObject = null;
        if (rv) rv.srcObject = null;
    }

    async function _setupLocalMedia() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia(
                { video: isCurrentCallVideo, audio: true }
            );
            if (isCurrentCallVideo) {
                document.getElementById('localVideo').srcObject = localStream;
                document.getElementById('inCallVideos').classList.remove('d-none');
            }
        } catch (err) {
            statusEl.innerHTML = '<span class="text-danger">Media access denied: ' + err.message + '</span>';
            setTimeout(() => statusEl.innerText = '', 3000);
            throw err;
        }
    }

    function _setupPC() {
        peerConnection = new RTCPeerConnection(rtcConfig);
        peerConnection.onicecandidate = ev => {
            if (ev.candidate && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'webrtc',
                    to: callingContact,
                    from: currentUserEmail,
                    signal: { type: 'ice', candidate: ev.candidate }
                }));
            }
        };
        peerConnection.ontrack = ev => {
            document.getElementById('remoteVideo').srcObject = ev.streams[0];
            document.getElementById('inCallVideos').classList.remove('d-none');
            document.getElementById('callStatus').textContent = 'In call';
        };
        peerConnection.onconnectionstatechange = () => {
            const s = peerConnection && peerConnection.connectionState;
            if (s === 'disconnected' || s === 'failed' || s === 'closed') {
                window.endCall();
            }
        };
    }

    // startCall(isVideo: bool)  — called from HTML buttons
    window.startCall = async function(isVideo) {
        if (!activeContact) return;
        callingContact = activeContact;
        isCurrentCallVideo = !!isVideo;
        iceCandidateQueue = [];
        _showCallBox('outgoing', callingContact);

        try {
            await _setupLocalMedia();
            _setupPC();
            localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            if (ws && ws.readyState === WebSocket.OPEN) {
                // Signal the other side: first a 'call' notification, then the WebRTC offer
                ws.send(JSON.stringify({ type: 'call', to: callingContact, from: currentUserEmail, action: 'offer_call', callType: isVideo ? 'video' : 'voice' }));
                ws.send(JSON.stringify({ type: 'webrtc', to: callingContact, from: currentUserEmail, signal: { type: 'offer', offer, isVideo } }));
            }
        } catch (e) {
            console.error('startCall error', e);
            window.endCall();
        }
    };

    window.acceptCall = async function() {
        document.getElementById('acceptCallBtn').classList.add('d-none');
        document.getElementById('rejectCallBtn').classList.add('d-none');
        document.getElementById('endCallBtn').classList.remove('d-none');
        document.getElementById('callStatus').textContent = 'Connecting…';

        try {
            await _setupLocalMedia();
            localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'webrtc', to: callingContact, from: currentUserEmail, signal: { type: 'answer', answer } }));
        } catch (e) {
            console.error('acceptCall error', e);
            window.endCall();
        }
    };

    window.rejectCall = function() {
        if (callingContact && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'webrtc', to: callingContact, from: currentUserEmail, signal: { type: 'reject' } }));
        }
        window.endCall();
    };

    window.endCall = function() {
        if (peerConnection) {
            try { peerConnection.close(); } catch(e){}
            peerConnection = null;
        }
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
        if (callingContact && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'webrtc', to: callingContact, from: currentUserEmail, signal: { type: 'end' } }));
        }
        callingContact = null;
        iceCandidateQueue = [];
        _hideCallBox();
    };

    async function handleWebRTCMessage(from, signal) {
        if (!signal) return;
        try {
            if (signal.type === 'offer') {
                callingContact = from;
                isCurrentCallVideo = !!signal.isVideo;
                iceCandidateQueue = [];
                _showCallBox('incoming', from);
                // Show display name, not raw email
                const fromName = (() => {
                    const c = contactsCache.find(x => x.contact_email === from);
                    return (c && c.display_name) ? c.display_name : from.split('@')[0];
                })();
                document.getElementById('callStatus').textContent =
                    'Incoming ' + (isCurrentCallVideo ? 'video ' : 'voice ') + 'call from ' + fromName;
                document.getElementById('callPeer').textContent = fromName;

                _setupPC();
                await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.offer));

                // Flush any ICE candidates that arrived early
                while (iceCandidateQueue.length > 0) {
                    await peerConnection.addIceCandidate(iceCandidateQueue.shift());
                }

            } else if (signal.type === 'answer') {
                if (peerConnection) {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.answer));
                }

            } else if (signal.type === 'ice') {
                if (peerConnection) {
                    if (peerConnection.remoteDescription) {
                        await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
                    } else {
                        iceCandidateQueue.push(signal.candidate);
                    }
                }

            } else if (signal.type === 'reject' || signal.type === 'end') {
                if (callingContact === from) {
                    const wasCallingContact = callingContact;
                    peerConnection && peerConnection.close();
                    peerConnection = null;
                    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
                    callingContact = null;
                    _hideCallBox();
                    statusEl.innerHTML = '<span class="text-info">Call ended.</span>';
                    setTimeout(() => { if (statusEl) statusEl.innerText = ''; }, 2000);
                }
            }
        } catch (e) {
            console.error('handleWebRTCMessage error', e);
        }
    }

    const sendBtn = document.getElementById("sendMsgBtn");
    const micBtn = document.getElementById("voiceRecordBtn");

    let mediaRecorder = null;
    let audioChunks = [];

    let wantsToRecord = false;
    window.startRecording = async function() {
        wantsToRecord = true;
        isRecording = true;
        recordingTime = 0;
        audioChunks = [];
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // If user released while waiting for permission, abort
            if (!wantsToRecord) {
                stream.getTracks().forEach(t => t.stop());
                isRecording = false;
                return;
            }
            
            // Try supported mime types
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
                             ? 'audio/webm;codecs=opus' 
                             : (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : 'audio/mp4');
            
            mediaRecorder = new MediaRecorder(stream, { mimeType });
            mediaRecorder.ondataavailable = event => {
                if (event.data.size > 0) audioChunks.push(event.data);
            };
            mediaRecorder.start();
        } catch (e) {
            console.error("Microphone access denied or error:", e);
            statusEl.innerHTML = '<span class="text-danger"><i class="fa-solid fa-microchip"></i> Mic Error: ' + e.message + '</span>';
            setTimeout(() => { statusEl.innerText = ""; }, 3000);
            stopRecording();
            return;
        }

        micBtn.style.color = "#ff3333";
        micBtn.style.borderColor = "#ff3333";
        micBtn.innerHTML = '<i class="fa-solid fa-record-vinyl fa-spin"></i>';
        
        chatInput.value = ""; // Clear so placeholder shows
        chatInput.placeholder = "Recording... 0:00";
        chatInput.disabled = true;
        
        const recStart = Date.now();
        recordingInterval = setInterval(() => {
            recordingTime = (Date.now() - recStart) / 1000;
            chatInput.placeholder = `Recording... ${formatTime(recordingTime)}`;
        }, 100);
    };

    window.stopRecording = function() {
        wantsToRecord = false;
        if (!isRecording) return;
        isRecording = false;
        clearInterval(recordingInterval);
        
        micBtn.style.color = "var(--accent-color)";
        micBtn.style.borderColor = "var(--accent-color)";
        micBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
        chatInput.disabled = false;
        chatInput.placeholder = "Type a message...";
        
        const capturedDuration = Math.floor(recordingTime); // capture BEFORE reset
        if (capturedDuration >= 1) {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.onstop = () => {
                    if (audioChunks.length === 0) {
                        console.error("No audio chunks captured.");
                        return;
                    }
                    const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
                    const reader = new FileReader();
                    reader.readAsDataURL(audioBlob);
                    reader.onloadend = () => {
                        const base64Audio = reader.result;
                        let payloadText = `🎤 [Voice Note ${capturedDuration}s]\n${base64Audio}`;
                        if (isSelfDestruct) payloadText = `⏳ [Self-Destructing]\n${payloadText}`;
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ to: activeContact, content: payloadText }));
                        }
                        if (isSelfDestruct) toggleSelfDestruct();
                    };
                };
                mediaRecorder.stop();
                mediaRecorder.stream.getTracks().forEach(track => track.stop());
            } else {
                // Fallback if mic failed
                let payloadText = `🎤 [Voice Note ${capturedDuration}s]`;
                if (isSelfDestruct) payloadText = `⏳ [Self-Destructing]\n${payloadText}`;
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ to: activeContact, content: payloadText }));
                }
                if (isSelfDestruct) toggleSelfDestruct();
            }
        } else {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop();
                mediaRecorder.stream.getTracks().forEach(track => track.stop());
            }
            statusEl.innerHTML = '<span class="text-warning"><i class="fa-solid fa-circle-exclamation"></i> Hold the microphone button to record.</span>';
            setTimeout(() => { statusEl.innerText = ""; }, 2500);
        }
        recordingTime = 0;
    };

    chatInput.addEventListener("input", function () {
        this.style.height = "auto";
        this.style.height = this.scrollHeight + "px";
        
        // Dynamic Send/Mic button toggle
        if (this.value.trim().length > 0 || selectedFile) {
            if(sendBtn) sendBtn.classList.remove("d-none");
            if(micBtn) micBtn.classList.add("d-none");
        } else {
            if(sendBtn) sendBtn.classList.add("d-none");
            if(micBtn) micBtn.classList.remove("d-none");
        }

        if (activeContact && this.value.trim().length > 0) {
            if (!lastTypingSent) sendTyping(true);
            clearTimeout(outboundTypingTimer);
            outboundTypingTimer = setTimeout(() => {
                sendTyping(false);
            }, 1200);
        } else {
            clearTimeout(outboundTypingTimer);
            sendTyping(false);
        }
    });

    document.getElementById("msgContextCopy")?.addEventListener("click", (e) => {
        e.stopPropagation();
        ctxCopyMessage();
    });
    document.getElementById("msgContextReply")?.addEventListener("click", (e) => {
        e.stopPropagation();
        ctxReplyMessage();
    });
    document.getElementById("msgContextPin")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (contextTarget && contextTarget.row.querySelector(".chat-bubble-body")) {
            pinnedMessageText.textContent = contextTarget.row.querySelector(".chat-bubble-body").textContent.trim();
            pinnedMessageBar.classList.remove("d-none");
        }
        closeContextMenu();
    });

    // Delegated listener for the "More" button in the chat header
    document.addEventListener("click", (e) => {
        const menuBtn = e.target.closest("#chatMenuBtn");
        const menu = document.getElementById("chatHeaderMenu");
        
        if (menuBtn) {
            e.preventDefault();
            e.stopPropagation();
            if (menu) menu.classList.toggle("d-none");
        } else if (menu && !menu.classList.contains("d-none") && !e.target.closest("#chatHeaderMenu")) {
            // Close menu if clicking outside
            menu.classList.add("d-none");
        }
    });

    document.getElementById("chatMenuSearch")?.addEventListener("click", (e) => {
        e.stopPropagation();
        document.getElementById("chatHeaderMenu")?.classList.add("d-none");
        toggleInChatSearch();
    });

    document.getElementById("chatMenuFocus")?.addEventListener("click", (e) => {
        e.stopPropagation();
        document.getElementById("chatHeaderMenu")?.classList.add("d-none");
        toggleFocusMode();
    });
})();
