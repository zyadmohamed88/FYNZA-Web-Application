"""
Channels Router — Phase 1
Handles channel creation, membership, and real-time messaging.
"""

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from typing import Optional, List
import sqlite3
import threading
import time
import json
import datetime
import crypto_utils

router = APIRouter(prefix="/channels", tags=["channels"])

# ── Shared DB helper ────────────────────────────────────────────────────────
_local = threading.local()

def get_db():
    if not hasattr(_local, "con") or _local.con is None:
        _local.con = sqlite3.connect("login.db", check_same_thread=False)
        _local.cursor = _local.con.cursor()
    return _local.con, _local.cursor


# ── Pydantic models ─────────────────────────────────────────────────────────
class ChannelCreate(BaseModel):
    workspace_id: int
    name: str
    description: Optional[str] = ""
    is_private: Optional[bool] = False

class ChannelMessage(BaseModel):
    content: str
    thread_id: Optional[int] = None   # None = top-level message

class ChannelUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_private: Optional[bool] = None


# ── WebSocket connection manager (per channel) ──────────────────────────────
class ChannelConnectionManager:
    def __init__(self):
        # channel_id → list of (websocket, email)
        self.rooms: dict[int, list] = {}

    async def connect(self, channel_id: int, ws: WebSocket, email: str):
        await ws.accept()
        if channel_id not in self.rooms:
            self.rooms[channel_id] = []
        self.rooms[channel_id].append((ws, email))

    def disconnect(self, channel_id: int, ws: WebSocket):
        if channel_id in self.rooms:
            self.rooms[channel_id] = [(w, e) for w, e in self.rooms[channel_id] if w != ws]

    async def broadcast(self, channel_id: int, message: dict, exclude_ws=None):
        if channel_id not in self.rooms:
            return
        dead = []
        for ws, email in self.rooms[channel_id]:
            if ws == exclude_ws:
                continue
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(channel_id, ws)

    def online_in_channel(self, channel_id: int) -> List[str]:
        return [e for _, e in self.rooms.get(channel_id, [])]

    def get_all_online_users(self) -> List[str]:
        all_emails = []
        for r in self.rooms.values():
            for _, email in r:
                all_emails.append(email)
        return list(set(all_emails))


channel_manager = ChannelConnectionManager()


# ── Helpers ──────────────────────────────────────────────────────────────────
def _check_channel_access(channel_id: int, email: str):
    """Return channel row or raise 403/404."""
    con, cursor = get_db()
    cursor.execute("SELECT id, workspace_id, name, is_private FROM channels WHERE id=?", (channel_id,))
    ch = cursor.fetchone()
    if not ch:
        raise HTTPException(404, "Channel not found")
    if ch[3]:  # private channel
        cursor.execute(
            "SELECT id FROM channel_members WHERE channel_id=? AND email=?",
            (channel_id, email.lower())
        )
        if not cursor.fetchone():
            raise HTTPException(403, "Not a member of this private channel")
    else:
        # Public channel: check workspace membership
        cursor.execute("""
            SELECT id FROM workspace_members
            WHERE workspace_id=? AND email=?
        """, (ch[1], email.lower()))
        if not cursor.fetchone():
            raise HTTPException(403, "Not a member of this workspace")
    return ch


def _require_workspace_role(workspace_id: int, email: str, min_role: str = "member"):
    hierarchy = {"guest": 0, "member": 1, "admin": 2, "owner": 3}
    con, cursor = get_db()
    cursor.execute(
        "SELECT role FROM workspace_members WHERE workspace_id=? AND email=?",
        (workspace_id, email.lower())
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(403, "Not a member of this workspace")
    if hierarchy.get(row[0], 0) < hierarchy.get(min_role, 1):
        raise HTTPException(403, f"Requires '{min_role}' role or higher")
    return row[0]

def _encrypt_content(sender: str, channel_id: int, plaintext: str) -> str:
    try:
        scenario = crypto_utils.ACTIVE_CRYPTO_SCENARIO
        receiver = f"channel_{channel_id}"
        enc = crypto_utils._encrypt_for_scenario(scenario, sender, receiver, plaintext.encode('utf-8'))
        return json.dumps(enc)
    except Exception as e:
        print(f"Error encrypting channel message: {e}")
        return plaintext

def _decrypt_content(sender: str, channel_id: int, content_str: str) -> str:
    try:
        parsed = json.loads(content_str)
        if "ciphertext" in parsed:
            receiver = f"channel_{channel_id}"
            dec = crypto_utils._decrypt_for_scenario(parsed, sender, receiver)
            return dec.decode('utf-8')
    except Exception:
        pass
    return content_str


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/create")
def create_channel(data: ChannelCreate, user_email: str):
    """Create a channel inside a workspace (member+ only)."""
    _require_workspace_role(data.workspace_id, user_email, "member")
    con, cursor = get_db()

    name = data.name.strip().lower().replace(" ", "-")
    if not name:
        raise HTTPException(400, "Channel name is required")

    # Unique within workspace
    cursor.execute(
        "SELECT id FROM channels WHERE workspace_id=? AND name=?",
        (data.workspace_id, name)
    )
    if cursor.fetchone():
        raise HTTPException(409, f"Channel #{name} already exists")

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cursor.execute(
        "INSERT INTO channels (workspace_id, name, description, is_private, created_by, created_at) VALUES (?,?,?,?,?,?)",
        (data.workspace_id, name, data.description or "", 1 if data.is_private else 0, user_email.lower(), now)
    )
    channel_id = cursor.lastrowid

    # Creator auto-joins
    cursor.execute(
        "INSERT INTO channel_members (channel_id, email, joined_at) VALUES (?,?,?)",
        (channel_id, user_email.lower(), now)
    )
    con.commit()

    return {
        "id": channel_id,
        "name": name,
        "description": data.description,
        "is_private": data.is_private,
        "workspace_id": data.workspace_id
    }


@router.get("/workspace/{workspace_id}")
def list_channels(workspace_id: int, user_email: str):
    """List all channels the user can see in a workspace."""
    _require_workspace_role(workspace_id, user_email, "guest")
    con, cursor = get_db()

    # Ensure read-status table exists
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS channel_read_status (
            channel_id INTEGER NOT NULL,
            email TEXT NOT NULL,
            last_read_id INTEGER DEFAULT 0,
            PRIMARY KEY (channel_id, email)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS channel_delivery_status (
            channel_id INTEGER NOT NULL,
            email TEXT NOT NULL,
            last_delivered_id INTEGER DEFAULT 0,
            PRIMARY KEY (channel_id, email)
        )
    """)
    con.commit()

    # Auto-mark delivery for this user for all channels they can see in this workspace
    cursor.execute("""
        INSERT INTO channel_delivery_status (channel_id, email, last_delivered_id)
        SELECT cm.channel_id, ?, MAX(cm.id)
        FROM channel_messages cm
        JOIN channels c ON c.id = cm.channel_id
        WHERE c.workspace_id = ?
          AND (c.is_private = 0 OR EXISTS (SELECT 1 FROM channel_members mem WHERE mem.channel_id=c.id AND mem.email=?))
        GROUP BY cm.channel_id
        ON CONFLICT(channel_id, email) DO UPDATE SET last_delivered_id=excluded.last_delivered_id
    """, (user_email.lower(), workspace_id, user_email.lower()))
    con.commit()


    # Public channels + private channels the user is in, with unread counts
    cursor.execute("""
        SELECT c.id, c.name, c.description, c.is_private, c.created_by, c.created_at,
               (SELECT COUNT(*) FROM channel_messages cm WHERE cm.channel_id = c.id) as msg_count,
               CASE 
                   WHEN c.is_private = 1 THEN (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id)
                   ELSE (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = c.workspace_id)
               END as member_count,
               COALESCE((
                   SELECT COUNT(*) FROM channel_messages cm
                   WHERE cm.channel_id = c.id
                     AND cm.id > COALESCE(
                         (SELECT last_read_id FROM channel_read_status
                          WHERE channel_id=c.id AND email=?), 0)
                     AND cm.sender != ?
               ), 0) as unread_count
        FROM channels c
        WHERE c.workspace_id = ?
          AND (c.is_private = 0
               OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.email=?))
        ORDER BY c.name ASC
    """, (user_email.lower(), user_email.lower(), workspace_id, user_email.lower()))

    rows = cursor.fetchall()
    return [
        {
            "id": r[0], "name": r[1], "description": r[2],
            "is_private": bool(r[3]), "created_by": r[4], "created_at": r[5],
            "message_count": r[6], "member_count": r[7], "unread_count": r[8]
        }
        for r in rows
    ]


def mark_channel_read(channel_id: int, user_email: str):
    """Mark all messages in a channel as read for a user."""
    con, cursor = get_db()
    cursor.execute("""
        SELECT MAX(id) FROM channel_messages WHERE channel_id=?
    """, (channel_id,))
    row = cursor.fetchone()
    last_id = row[0] if row and row[0] else 0
    cursor.execute("""
        INSERT INTO channel_read_status (channel_id, email, last_read_id)
        VALUES (?, ?, ?)
        ON CONFLICT(channel_id, email) DO UPDATE SET last_read_id=excluded.last_read_id
    """, (channel_id, user_email.lower(), last_id))
    cursor.execute("""
        INSERT INTO channel_delivery_status (channel_id, email, last_delivered_id)
        VALUES (?, ?, ?)
        ON CONFLICT(channel_id, email) DO UPDATE SET last_delivered_id=excluded.last_delivered_id
    """, (channel_id, user_email.lower(), last_id))
    con.commit()
    return {"ok": True}



@router.get("/{channel_id}/messages")
def get_messages(channel_id: int, user_email: str, limit: int = 50, before_id: int = 0):
    """Fetch messages for a channel (paginated)."""
    _check_channel_access(channel_id, user_email)
    con, cursor = get_db()

    if before_id > 0:
        cursor.execute("""
            SELECT cm.id, cm.sender, cm.content, cm.thread_id, cm.pinned, cm.created_at,
                   u.display_name, u.avatar, u.user_id
            FROM channel_messages cm
            LEFT JOIN users u ON lower(u.email) = cm.sender
            WHERE cm.channel_id=? AND cm.id < ? AND cm.thread_id IS NULL
            ORDER BY cm.id DESC LIMIT ?
        """, (channel_id, before_id, limit))
    else:
        cursor.execute("""
            SELECT cm.id, cm.sender, cm.content, cm.thread_id, cm.pinned, cm.created_at,
                   u.display_name, u.avatar, u.user_id
            FROM channel_messages cm
            LEFT JOIN users u ON lower(u.email) = cm.sender
            WHERE cm.channel_id=? AND cm.thread_id IS NULL
            ORDER BY cm.id DESC LIMIT ?
        """, (channel_id, limit))

    rows = cursor.fetchall()
    
    # Get total members for this channel
    # We now base member_count on channel_members table for both private AND public channels
    # so that read receipts are specific to people who actually joined the group.
    cursor.execute("SELECT COUNT(*) FROM channel_members WHERE channel_id=?", (channel_id,))
    member_count = cursor.fetchone()[0]
    
    # Fallback: if somehow channel_members is empty (shouldn't happen with creator auto-join),
    # use 1 to avoid division by zero or weirdness.
    if member_count == 0: member_count = 1

    messages = []
    for r in rows:
        msg_id = r[0]
        # Count thread replies
        cursor.execute("SELECT COUNT(*) FROM channel_messages WHERE thread_id=?", (msg_id,))
        reply_count = cursor.fetchone()[0]
        
        # Count how many other users have read this message
        cursor.execute("""
            SELECT COUNT(*) FROM channel_read_status 
            WHERE channel_id=? AND last_read_id >= ? AND email != ?
        """, (channel_id, msg_id, r[1]))
        read_by_count = cursor.fetchone()[0]
        
        # Count how many other users have received this message
        cursor.execute("""
            SELECT COUNT(*) FROM channel_delivery_status 
            WHERE channel_id=? AND last_delivered_id >= ? AND email != ?
        """, (channel_id, msg_id, r[1]))
        delivered_by_count = cursor.fetchone()[0]

        messages.append({
            "id": msg_id, "sender": r[1], "content": _decrypt_content(r[1], channel_id, r[2]),
            "thread_id": r[3], "pinned": bool(r[4]), "created_at": r[5],
            "display_name": r[6] or r[1], "avatar": r[7] or "",
            "user_id": r[8] or "",
            "reply_count": reply_count,
            "read_by_count": read_by_count,
            "delivered_by_count": delivered_by_count,
            "member_count": member_count
        })
    return list(reversed(messages))


@router.get("/messages/{message_id}/read_receipts")
def get_message_read_receipts(message_id: int, user_email: str):
    """Get list of users who have read a specific channel message."""
    con, cursor = get_db()
    
    # Verify access to the message's channel
    cursor.execute("SELECT channel_id FROM channel_messages WHERE id=?", (message_id,))
    row = cursor.fetchone()
    if not row:
        raise HTTPException(404, "Message not found")
    channel_id = row[0]
    _check_channel_access(channel_id, user_email)

    # Get all members except sender
    cursor.execute("""
        SELECT u.email, u.display_name,
               COALESCE((SELECT 1 FROM channel_read_status crs WHERE crs.channel_id=? AND crs.email=u.email AND crs.last_read_id >= ?), 0) as is_read,
               COALESCE((SELECT 1 FROM channel_delivery_status cds WHERE cds.channel_id=? AND cds.email=u.email AND cds.last_delivered_id >= ?), 0) as is_delivered
        FROM channel_members cm
        JOIN users u ON lower(u.email) = cm.email
        WHERE cm.channel_id = ? AND cm.email != ?
    """, (channel_id, message_id, channel_id, message_id, channel_id, user_email))
    
    readers = []
    for r in cursor.fetchall():
        readers.append({
            "user_email": r[0],
            "display_name": r[1],
            "is_read": bool(r[2]),
            "is_delivered": bool(r[3])
        })
    return readers



@router.get("/{channel_id}/thread/{message_id}")
def get_thread(channel_id: int, message_id: int, user_email: str):
    """Fetch the original message + all replies in a thread."""
    _check_channel_access(channel_id, user_email)
    con, cursor = get_db()

    cursor.execute("""
        SELECT cm.id, cm.sender, cm.content, cm.thread_id, cm.pinned, cm.created_at,
               u.display_name, u.avatar, u.user_id
        FROM channel_messages cm
        LEFT JOIN users u ON lower(u.email) = cm.sender
        WHERE cm.id=? AND cm.channel_id=?
    """, (message_id, channel_id))
    parent = cursor.fetchone()
    if not parent:
        raise HTTPException(404, "Message not found")

    cursor.execute("""
        SELECT cm.id, cm.sender, cm.content, cm.thread_id, cm.pinned, cm.created_at,
               u.display_name, u.avatar, u.user_id
        FROM channel_messages cm
        LEFT JOIN users u ON lower(u.email) = cm.sender
        WHERE cm.thread_id=?
        ORDER BY cm.id ASC
    """, (message_id,))
    replies = cursor.fetchall()

    def fmt(r):
        return {
            "id": r[0], "sender": r[1], "content": _decrypt_content(r[1], channel_id, r[2]),
            "thread_id": r[3], "pinned": bool(r[4]), "created_at": r[5],
            "display_name": r[6] or r[1], "avatar": r[7] or "",
            "user_id": r[8] or ""
        }

    return {"parent": fmt(parent), "replies": [fmt(r) for r in replies]}


@router.post("/{channel_id}/send")
def send_message(channel_id: int, data: ChannelMessage, user_email: str):
    """Send a message to a channel (HTTP fallback — WS preferred)."""
    _check_channel_access(channel_id, user_email)
    if not data.content.strip():
        raise HTTPException(400, "Message content is required")

    con, cursor = get_db()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Validate thread_id if given
    if data.thread_id:
        cursor.execute(
            "SELECT id FROM channel_messages WHERE id=? AND channel_id=?",
            (data.thread_id, channel_id)
        )
        if not cursor.fetchone():
            raise HTTPException(400, "Invalid thread_id")

    enc_content = _encrypt_content(user_email.lower(), channel_id, data.content.strip())
    cursor.execute(
        "INSERT INTO channel_messages (channel_id, sender, content, thread_id, pinned, created_at) VALUES (?,?,?,?,?,?)",
        (channel_id, user_email.lower(), enc_content, data.thread_id, 0, now)
    )
    msg_id = cursor.lastrowid
    con.commit()

    return {
        "id": msg_id,
        "channel_id": channel_id,
        "sender": user_email.lower(),
        "content": data.content.strip(),
        "thread_id": data.thread_id,
        "created_at": now
    }


@router.post("/{channel_id}/pin/{message_id}")
def pin_message(channel_id: int, message_id: int, user_email: str):
    """Pin/unpin a message (admin+ only)."""
    ch = _check_channel_access(channel_id, user_email)
    _require_workspace_role(ch[1], user_email, "admin")
    con, cursor = get_db()
    cursor.execute(
        "UPDATE channel_messages SET pinned = NOT pinned WHERE id=? AND channel_id=?",
        (message_id, channel_id)
    )
    if cursor.rowcount == 0:
        raise HTTPException(404, "Message not found")
    con.commit()
    cursor.execute("SELECT pinned FROM channel_messages WHERE id=?", (message_id,))
    pinned = bool(cursor.fetchone()[0])
    return {"message_id": message_id, "pinned": pinned}


@router.get("/{channel_id}/pinned")
def get_pinned(channel_id: int, user_email: str):
    """Get all pinned messages in a channel."""
    _check_channel_access(channel_id, user_email)
    con, cursor = get_db()
    cursor.execute("""
        SELECT cm.id, cm.sender, cm.content, cm.created_at, u.display_name
        FROM channel_messages cm
        LEFT JOIN users u ON lower(u.email) = cm.sender
        WHERE cm.channel_id=? AND cm.pinned=1
        ORDER BY cm.created_at DESC
    """, (channel_id,))
    rows = cursor.fetchall()
    return [{"id": r[0], "sender": r[1], "content": _decrypt_content(r[1], channel_id, r[2]), "created_at": r[3], "display_name": r[4] or r[1]} for r in rows]


@router.post("/{channel_id}/join")
def join_channel(channel_id: int, user_email: str):
    """Join a public channel."""
    con, cursor = get_db()
    cursor.execute("SELECT workspace_id, is_private FROM channels WHERE id=?", (channel_id,))
    ch = cursor.fetchone()
    if not ch:
        raise HTTPException(404, "Channel not found")
    if ch[1]:
        raise HTTPException(403, "Cannot self-join a private channel")
    _require_workspace_role(ch[0], user_email, "guest")

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cursor.execute(
        "INSERT OR IGNORE INTO channel_members (channel_id, email, joined_at) VALUES (?,?,?)",
        (channel_id, user_email.lower(), now)
    )
    con.commit()
    return {"status": "joined", "channel_id": channel_id}


@router.websocket("/{channel_id}/ws")
async def channel_ws(channel_id: int, ws: WebSocket, token: str):
    """Real-time WebSocket endpoint for a channel."""
    # Validate token
    from jose import jwt, JWTError
    SECRET_KEY = "secret123"
    ALGORITHM = "HS256"
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub", "").lower()
    except JWTError:
        await ws.close(code=4001)
        return

    try:
        _check_channel_access(channel_id, email)
    except HTTPException:
        await ws.close(code=4003)
        return

    con, cursor = get_db()
    cursor.execute("SELECT display_name, avatar, user_id FROM users WHERE lower(email)=?", (email,))
    urow = cursor.fetchone()
    display_name = (urow[0] if urow and urow[0] else email)
    avatar = (urow[1] if urow and urow[1] else "")
    user_id = (urow[2] if urow and urow[2] else "")

    await channel_manager.connect(channel_id, ws, email)

    # Notify others
    await channel_manager.broadcast(channel_id, {
        "type": "user_joined",
        "email": email,
        "display_name": display_name,
        "online": channel_manager.online_in_channel(channel_id)
    }, exclude_ws=ws)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except Exception:
                continue

            msg_type = data.get("type", "message")

            if msg_type == "message":
                content = (data.get("content") or "").strip()
                thread_id = data.get("thread_id")
                if not content:
                    continue

                now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                enc_content = _encrypt_content(email, channel_id, content)
                cursor.execute(
                    "INSERT INTO channel_messages (channel_id, sender, content, thread_id, pinned, created_at) VALUES (?,?,?,?,?,?)",
                    (channel_id, email, enc_content, thread_id, 0, now)
                )
                msg_id = cursor.lastrowid
                con.commit()

                cursor.execute("SELECT is_private, workspace_id FROM channels WHERE id=?", (channel_id,))
                ch_info = cursor.fetchone()
                if ch_info and ch_info[0]:
                    cursor.execute("SELECT COUNT(*) FROM channel_members WHERE channel_id=?", (channel_id,))
                    member_count = cursor.fetchone()[0]
                elif ch_info:
                    cursor.execute("SELECT COUNT(*) FROM workspace_members WHERE workspace_id=?", (ch_info[1],))
                    member_count = cursor.fetchone()[0]
                else:
                    member_count = 1

                payload_out = {
                    "type": "message",
                    "id": msg_id,
                    "channel_id": channel_id,
                    "sender": email,
                    "display_name": display_name,
                    "avatar": avatar,
                    "user_id": user_id,
                    "content": content,
                    "thread_id": thread_id,
                    "created_at": now,
                    "member_count": member_count,
                    "read_by_count": 0,
                    "delivered_by_count": 0
                }
                # Echo to sender too
                await ws.send_text(json.dumps(payload_out))
                await channel_manager.broadcast(channel_id, payload_out, exclude_ws=ws)

            elif msg_type == "typing":
                await channel_manager.broadcast(channel_id, {
                    "type": "typing",
                    "email": email,
                    "display_name": display_name
                }, exclude_ws=ws)
                
            elif msg_type == "webrtc":
                # Relay WebRTC signaling (offer, answer, ICE candidates) to others in the channel
                await channel_manager.broadcast(channel_id, data, exclude_ws=ws)
                
            elif msg_type == "read":
                msg_id = data.get("msg_id")
                if msg_id:
                    # Update read status
                    cursor.execute("""
                        INSERT INTO channel_read_status (channel_id, email, last_read_id)
                        VALUES (?, ?, ?)
                        ON CONFLICT(channel_id, email) DO UPDATE SET last_read_id=excluded.last_read_id
                    """, (channel_id, email, msg_id))
                    # Update delivery status too because if they read it, they definitely received it
                    cursor.execute("""
                        INSERT INTO channel_delivery_status (channel_id, email, last_delivered_id)
                        VALUES (?, ?, ?)
                        ON CONFLICT(channel_id, email) DO UPDATE SET last_delivered_id=excluded.last_delivered_id
                    """, (channel_id, email, msg_id))
                    con.commit()
                    
                    # Notify others that this user read up to msg_id
                    await channel_manager.broadcast(channel_id, {
                        "type": "read_receipt",
                        "reader": email,
                        "msg_id": msg_id
                    }, exclude_ws=ws)


    except WebSocketDisconnect:
        channel_manager.disconnect(channel_id, ws)
        await channel_manager.broadcast(channel_id, {
            "type": "user_left",
            "email": email,
            "online": channel_manager.online_in_channel(channel_id)
        })

class AddChannelMemberReq(BaseModel):
    user_id: str

@router.post("/{channel_id}/members")
def add_channel_member(channel_id: int, data: AddChannelMemberReq, user_email: str):
    con, cursor = get_db()
    # Basic access check
    _check_channel_access(channel_id, user_email)
    
    cursor.execute("SELECT workspace_id, is_private, created_by FROM channels WHERE id=?", (channel_id,))
    ch = cursor.fetchone()
    if not ch: raise HTTPException(404, "Channel not found")
    workspace_id, is_private, created_by = ch[0], bool(ch[1]), ch[2]
    
    # Lookup target user by user_id
    cursor.execute("SELECT email FROM users WHERE user_id=?", (data.user_id,))
    target_row = cursor.fetchone()
    if not target_row:
        raise HTTPException(404, "User not found by ID")
    target_email = target_row[0].lower()

    
    # Check if target user is in workspace
    cursor.execute("SELECT 1 FROM workspace_members WHERE workspace_id=? AND email=?", (workspace_id, target_email))
    if not cursor.fetchone():
        raise HTTPException(400, "User is not in the workspace")
    
    # Permission logic
    if target_email == user_email.lower():
        # User trying to join
        if is_private:
            # Cannot join private channel without being added by admin
            raise HTTPException(403, "Cannot join private channel manually")
        # Public channel - anyone in workspace can join
    else:
        # Admin/Creator adding someone else
        cursor.execute("SELECT role FROM workspace_members WHERE workspace_id=? AND email=?", (workspace_id, user_email.lower()))
        role_row = cursor.fetchone()
        is_admin = role_row and role_row[0] in ["admin", "owner"]
        is_creator = created_by == user_email.lower()
        
        if not (is_admin or is_creator):
            raise HTTPException(403, "Only admins or channel creator can add members")
        
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ')
    cursor.execute("INSERT OR IGNORE INTO channel_members (channel_id, email, joined_at) VALUES (?,?,?)",
                   (channel_id, target_email, now))
    con.commit()
    return {"ok": True}

@router.delete("/{channel_id}/members/{email}")
def remove_channel_member(channel_id: int, email: str, user_email: str):
    con, cursor = get_db()
    _check_channel_access(channel_id, user_email)
    
    cursor.execute("SELECT workspace_id, is_private, created_by FROM channels WHERE id=?", (channel_id,))
    ch = cursor.fetchone()
    if not ch: raise HTTPException(404, "Channel not found")
    workspace_id, is_private, created_by = ch[0], bool(ch[1]), ch[2]
    
    target_email = email.lower()
    
    if target_email == user_email.lower():
        # User leaving - usually allowed
        pass
    else:
        # Admin/Creator removing someone else
        cursor.execute("SELECT role FROM workspace_members WHERE workspace_id=? AND email=?", (workspace_id, user_email.lower()))
        role_row = cursor.fetchone()
        is_admin = role_row and role_row[0] in ["admin", "owner"]
        is_creator = created_by == user_email.lower()
        
        if not (is_admin or is_creator):
            raise HTTPException(403, "Only admins or channel creator can remove members")
            
    cursor.execute("DELETE FROM channel_members WHERE channel_id=? AND email=?", (channel_id, target_email))
    con.commit()
    return {"ok": True}

@router.get("/{channel_id}/members")
def get_channel_members(channel_id: int, user_email: str):
    con, cursor = get_db()
    # Need to know workspace_id to join workspace_members correctly
    cursor.execute("SELECT workspace_id FROM channels WHERE id=?", (channel_id,))
    ch = cursor.fetchone()
    if not ch: raise HTTPException(404, "Channel not found")
    workspace_id = ch[0]
    
    _check_channel_access(channel_id, user_email)
    
    cursor.execute("""
        SELECT u.email, u.display_name, cm.joined_at, wm.role
        FROM channel_members cm
        JOIN users u ON lower(u.email) = cm.email
        LEFT JOIN workspace_members wm ON wm.workspace_id = ? AND wm.email = cm.email
        WHERE cm.channel_id=?
    """, (workspace_id, channel_id))
    return [{"email": r[0], "display_name": r[1] or r[0], "joined_at": r[2], "role": r[3] or "member"} for r in cursor.fetchall()]


class ChannelImageUpdate(BaseModel):
    image: str  # base64 data URI

@router.patch("/{channel_id}/image")
def update_channel_image(channel_id: int, data: ChannelImageUpdate, user_email: str):
    """Update channel image (admin/creator only)."""
    con, cursor = get_db()
    cursor.execute("SELECT workspace_id, created_by FROM channels WHERE id=?", (channel_id,))
    ch = cursor.fetchone()
    if not ch: raise HTTPException(404, "Channel not found")
    workspace_id, created_by = ch[0], ch[1]
    
    # Check admin/creator
    cursor.execute("SELECT role FROM workspace_members WHERE workspace_id=? AND email=?", (workspace_id, user_email.lower()))
    role_row = cursor.fetchone()
    is_admin = role_row and role_row[0] in ["admin", "owner"]
    is_creator = created_by == user_email.lower()
    
    if not (is_admin or is_creator):
        raise HTTPException(403, "Only admins or channel creator can update channel image")
    
    cursor.execute("UPDATE channels SET image=? WHERE id=?", (data.image, channel_id))
    con.commit()
    return {"ok": True}

@router.get("/{channel_id}/info")
def get_channel_info(channel_id: int, user_email: str):
    """Get channel details including image."""
    _check_channel_access(channel_id, user_email)
    con, cursor = get_db()
    cursor.execute("SELECT id, workspace_id, name, description, is_private, created_by, image FROM channels WHERE id=?", (channel_id,))
    ch = cursor.fetchone()
    if not ch: raise HTTPException(404, "Channel not found")
    return {
        "id": ch[0], "workspace_id": ch[1], "name": ch[2],
        "description": ch[3], "is_private": bool(ch[4]),
        "created_by": ch[5], "image": ch[6] or ""
    }

@router.patch("/{channel_id}")
def update_channel(channel_id: int, data: ChannelUpdate, user_email: str):
    """Update channel details (admin/creator only)."""
    con, cursor = get_db()
    cursor.execute("SELECT workspace_id, created_by, name FROM channels WHERE id=?", (channel_id,))
    ch = cursor.fetchone()
    if not ch: raise HTTPException(404, "Channel not found")
    workspace_id, created_by, current_name = ch[0], ch[1], ch[2]
    
    # Check admin/creator
    cursor.execute("SELECT role FROM workspace_members WHERE workspace_id=? AND email=?", (workspace_id, user_email.lower()))
    role_row = cursor.fetchone()
    is_admin = role_row and role_row[0] in ["admin", "owner"]
    is_creator = created_by == user_email.lower()
    
    if not (is_admin or is_creator):
        raise HTTPException(403, "Only admins or channel creator can update channel details")
        
    updates = []
    params = []
    if data.name is not None:
        name = data.name.strip().lower().replace(" ", "-")
        if not name: raise HTTPException(400, "Channel name cannot be empty")
        # Ensure unique in workspace
        if name != current_name:
            cursor.execute("SELECT id FROM channels WHERE workspace_id=? AND name=?", (workspace_id, name))
            if cursor.fetchone(): raise HTTPException(409, f"Channel #{name} already exists")
        updates.append("name=?")
        params.append(name)
        
    if data.description is not None:
        updates.append("description=?")
        params.append(data.description.strip())
        
    if not updates:
        return {"ok": True, "message": "Nothing to update"}
        
    params.append(channel_id)
    query = f"UPDATE channels SET {', '.join(updates)} WHERE id=?"
    cursor.execute(query, params)
    con.commit()
    return {"ok": True, "channel_id": channel_id}
