# Force server reload
import bootstrap_env  # noqa: F401 — load .env early

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from routers import workspaces as ws_router, channels as ch_router
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import sqlite3
import threading
from fastapi.middleware.cors import CORSMiddleware
import hashlib
import json
import os
import re
import secrets
from jose import JWTError, jwt
from datetime import datetime, timedelta
from fastapi import Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from email_otp import SmtpSendError, send_otp_email, smtp_configured, send_welcome_email, send_signin_alert_email
from google_email import (
    google_identity_email_allowed,
    mask_email,
    normalize_email_for_storage,
)
from cryptography.hazmat.primitives import serialization
from crypto.ecc import generate_ecc_key_pair, serialize_public_key_pem, load_public_key_pem, derive_shared_secret
from crypto.hybrid import encrypt_message, decrypt_message
from crypto.aes_gcm import encrypt_aes_gcm, decrypt_aes_gcm
from crypto.hybrid import derive_conversation_key
import time
import crypto_utils
from crypto_utils import ensure_ecc_keys, _encrypt_for_scenario, _decrypt_for_scenario

security = HTTPBearer()
app = FastAPI()

# Thread-local storage: each thread gets its own connection + cursor
_local = threading.local()


def get_db():
    """Return a (connection, cursor) pair local to the current thread."""
    if not hasattr(_local, "con") or _local.con is None:
        _local.con = sqlite3.connect("login.db", check_same_thread=False)
        _local.cursor = _local.con.cursor()
    return _local.con, _local.cursor


# Convenience aliases used by startup init functions
con, cursor = get_db()


def init_otp_table():
    con, cursor = get_db()
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS password_reset_otp (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            otp_hash   NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS signup_verification_otp (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            otp_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS chat_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender TEXT NOT NULL,
            receiver TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at TEXT NOT NULL,
            UNIQUE(sender, receiver)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender TEXT NOT NULL,
            receiver TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TEXT NOT NULL
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS user_keys (
            email TEXT PRIMARY KEY,
            public_key TEXT NOT NULL,
            private_key TEXT
        )
    """)
    try:
        cursor.execute("ALTER TABLE user_keys ADD COLUMN private_key TEXT")
    except Exception:
        pass
    # Admin flag
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0")
    except Exception:
        pass

    # ── Phase 1: Enterprise Workspace & Channel tables ──────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS workspaces (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            slug        TEXT UNIQUE NOT NULL,
            description TEXT DEFAULT '',
            owner_email TEXT NOT NULL,
            created_at  TEXT NOT NULL
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS workspace_members (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            email        TEXT NOT NULL,
            role         TEXT NOT NULL DEFAULT 'member',
            joined_at    TEXT NOT NULL,
            UNIQUE(workspace_id, email)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS channels (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            description  TEXT DEFAULT '',
            is_private   INTEGER DEFAULT 0,
            created_by   TEXT NOT NULL,
            created_at   TEXT NOT NULL,
            UNIQUE(workspace_id, name)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS channel_members (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            email      TEXT NOT NULL,
            joined_at  TEXT NOT NULL,
            UNIQUE(channel_id, email)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS channel_messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            sender     TEXT NOT NULL,
            content    TEXT NOT NULL,
            thread_id  INTEGER REFERENCES channel_messages(id) ON DELETE CASCADE,
            pinned     INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    # Indexes for performance
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_ch_msg_channel ON channel_messages(channel_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_ch_msg_thread  ON channel_messages(thread_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_ws_members      ON workspace_members(workspace_id, email)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_ch_members      ON channel_members(channel_id, email)")
    
    # Add channel image column if missing
    try:
        cursor.execute("ALTER TABLE channels ADD COLUMN image TEXT DEFAULT ''")
    except Exception:
        pass
        
    # Add workspace image column if missing
    try:
        cursor.execute("ALTER TABLE workspaces ADD COLUMN image TEXT DEFAULT ''")
    except Exception:
        pass
    
    con.commit()

# ensure_ecc_keys moved to crypto_utils


# ACTIVE_CRYPTO_SCENARIO and _encrypt/_decrypt moved to crypto_utils


init_otp_table()


def ensure_users_table():
    con, cursor = get_db()
    """Same schema as database.Create_table — app must bootstrap DB without running database.py."""
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE,
            password TEXT,
            user_id TEXT UNIQUE,
            display_name TEXT DEFAULT '',
            bio TEXT DEFAULT '',
            avatar TEXT DEFAULT '',
            welcome_sent INTEGER DEFAULT 0
        )
        """
    )
    con.commit()


ensure_users_table()

SECRET_KEY = "secret123"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days


def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# ── Authenticated gateway wrappers (inject email from JWT) ─────────────────
@app.post("/workspaces/create")
def create_workspace(data: ws_router.WorkspaceCreate, payload=Depends(verify_token)):
    return ws_router.create_workspace_auth(data, payload["sub"])

@app.get("/workspaces/mine")
def my_workspaces(payload=Depends(verify_token)):
    return ws_router.get_my_workspaces(payload["sub"])

@app.get("/workspaces/{workspace_id}")
def get_workspace(workspace_id: int, payload=Depends(verify_token)):
    return ws_router.get_workspace(workspace_id, payload["sub"])

@app.post("/workspaces/{workspace_id}/invite")
def invite_to_workspace(workspace_id: int, data: ws_router.WorkspaceInvite, payload=Depends(verify_token)):
    return ws_router.invite_member(workspace_id, data, payload["sub"])

@app.get("/workspaces/{workspace_id}/members")
def workspace_members(workspace_id: int, payload=Depends(verify_token)):
    return ws_router.get_members(workspace_id, payload["sub"])

@app.delete("/workspaces/{workspace_id}/members/{member_email}")
def kick_member(workspace_id: int, member_email: str, payload=Depends(verify_token)):
    return ws_router.remove_member(workspace_id, member_email, payload["sub"])

@app.patch("/workspaces/{workspace_id}/role/{member_email}")
def change_member_role(workspace_id: int, member_email: str, data: ws_router.WorkspaceInvite, payload=Depends(verify_token)):
    return ws_router.change_role(workspace_id, member_email, data, payload["sub"])

@app.post("/channels/create")
def create_channel(data: ch_router.ChannelCreate, payload=Depends(verify_token)):
    return ch_router.create_channel(data, payload["sub"])

@app.post("/channels/{channel_id}/mark-read")
def mark_channel_read(channel_id: int, payload=Depends(verify_token)):
    return ch_router.mark_channel_read(channel_id, payload["sub"])

@app.get("/channels/workspace/{workspace_id}")
def list_channels(workspace_id: int, payload=Depends(verify_token)):
    return ch_router.list_channels(workspace_id, payload["sub"])

@app.get("/channels/{channel_id}/messages")
def channel_messages(channel_id: int, limit: int = 50, before_id: int = 0, payload=Depends(verify_token)):
    return ch_router.get_messages(channel_id, payload["sub"], limit, before_id)

@app.get("/messages/{message_id}/read_receipts")
def get_message_read_receipts(message_id: int, payload=Depends(verify_token)):
    return ch_router.get_message_read_receipts(message_id, payload["sub"])

@app.get("/channels/{channel_id}/thread/{message_id}")
def get_thread(channel_id: int, message_id: int, payload=Depends(verify_token)):
    return ch_router.get_thread(channel_id, message_id, payload["sub"])

@app.post("/channels/{channel_id}/send")
def send_channel_message(channel_id: int, data: ch_router.ChannelMessage, payload=Depends(verify_token)):
    return ch_router.send_message(channel_id, data, payload["sub"])

@app.post("/channels/{channel_id}/join")
def join_channel(channel_id: int, payload=Depends(verify_token)):
    return ch_router.join_channel(channel_id, payload["sub"])

@app.post("/channels/{channel_id}/pin/{message_id}")
def pin_channel_message(channel_id: int, message_id: int, payload=Depends(verify_token)):
    return ch_router.pin_message(channel_id, message_id, payload["sub"])

@app.get("/channels/{channel_id}/pinned")
def get_pinned_messages(channel_id: int, payload=Depends(verify_token)):
    return ch_router.get_pinned(channel_id, payload["sub"])

@app.get("/channels/{channel_id}/members")
def get_channel_members(channel_id: int, payload=Depends(verify_token)):
    return ch_router.get_channel_members(channel_id, payload["sub"])

@app.post("/channels/{channel_id}/members")
def add_channel_member(channel_id: int, data: ch_router.AddChannelMemberReq, payload=Depends(verify_token)):
    return ch_router.add_channel_member(channel_id, data, payload["sub"])

@app.delete("/channels/{channel_id}/members/{email}")
def remove_channel_member(channel_id: int, email: str, payload=Depends(verify_token)):
    return ch_router.remove_channel_member(channel_id, email, payload["sub"])

@app.patch("/channels/{channel_id}/image")
def update_channel_image(channel_id: int, data: ch_router.ChannelImageUpdate, payload=Depends(verify_token)):
    return ch_router.update_channel_image(channel_id, data, payload["sub"])

@app.get("/channels/{channel_id}/info")
def get_channel_info(channel_id: int, payload=Depends(verify_token)):
    return ch_router.get_channel_info(channel_id, payload["sub"])

@app.post("/workspaces/{workspace_id}/leave")
def leave_workspace(workspace_id: int, payload=Depends(verify_token)):
    return ws_router.leave_workspace(workspace_id, payload["sub"])

@app.patch("/workspaces/{workspace_id}/image")
def update_workspace_image(workspace_id: int, data: ws_router.WorkspaceImageUpdate, payload=Depends(verify_token)):
    return ws_router.update_workspace_image(workspace_id, data, payload["sub"])

@app.patch("/workspaces/{workspace_id}")
def update_workspace(workspace_id: int, data: ws_router.WorkspaceUpdate, payload=Depends(verify_token)):
    return ws_router.update_workspace(workspace_id, data, payload["sub"])

@app.patch("/channels/{channel_id}")
def update_channel(channel_id: int, data: ch_router.ChannelUpdate, payload=Depends(verify_token)):
    return ch_router.update_channel(channel_id, data, payload["sub"])


# ── Register enterprise routers (fallbacks and websockets) ───────────────────
app.include_router(ws_router.router)
app.include_router(ch_router.router)

@app.get("/")
def index():
    return {"Hello": "World"}


@app.get("/auth/smtp-status")
def auth_smtp_status():
    """For UI: is SMTP configured? (no secrets leaked)."""
    allow_non = os.getenv("ALLOW_NON_GMAIL_EMAILS", "").lower() in ("1", "true", "yes")
    extra = os.getenv("GOOGLE_WORKSPACE_ALLOWED_DOMAINS", "")
    workspace_domains = [d.strip().lower() for d in extra.split(",") if d.strip()]
    return {
        "smtp_configured": smtp_configured(),
        "gmail_required": not allow_non,
        "dev_otp_enabled": os.getenv("DEV_RETURN_OTP", "").lower() in ("1", "true", "yes"),
        "workspace_domains": workspace_domains,
    }


class Info(BaseModel):
    Email: str
    Password: str


class RegisterWithOtp(BaseModel):
    Email: str
    Password: str
    Otp: str


@app.post("/login")
def login(data: Info):
    con, cursor = get_db()
    try:
        email_try = data.Email.strip()
        password = data.Password
        cursor.execute("SELECT * FROM users WHERE lower(email) = lower(?)", (email_try,))
        user = cursor.fetchone()
        if not user:
            raise HTTPException(status_code=400, detail="Invalid credentials")
        hashed_password = hashlib.sha256(password.encode()).hexdigest()
        if hashed_password == user[2]:
            token = create_access_token({"sub": user[1]})
            # Send welcome email on first normal login if not already sent
            try:
                cursor.execute("SELECT welcome_sent FROM users WHERE lower(email) = lower(?)", (email_try,))
                row = cursor.fetchone()
                sent = row[0] if row and row[0] is not None else 0
            except Exception:
                sent = 0

            welcome_email_sent = False
            if sent == 0 and smtp_configured():
                try:
                    send_welcome_email(email_try)
                    cursor.execute("UPDATE users SET welcome_sent=1 WHERE lower(email) = lower(?)", (email_try,))
                    con.commit()
                    welcome_email_sent = True
                except Exception:
                    # Do not block login on email failure
                    welcome_email_sent = False

            signin_email_sent = False
            if smtp_configured():
                try:
                    send_signin_alert_email(email_try)
                    signin_email_sent = True
                except Exception:
                    signin_email_sent = False

            return {"access_token": token, "token_type": "bearer", "welcome_email_sent": welcome_email_sent, "signin_email_sent": signin_email_sent}
        raise HTTPException(status_code=400, detail="Invalid credentials")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")


@app.post("/register")
def register(data: RegisterWithOtp):
    con, cursor = get_db()
    try:
        raw_email = data.Email.strip()
        ok, err = google_identity_email_allowed(raw_email)
        if not ok:
            raise HTTPException(status_code=400, detail=err)
        email = normalize_email_for_storage(raw_email)
        password = data.Password
        ok_pw, pw_err = validate_password_policy(password)
        if not ok_pw:
            raise HTTPException(status_code=400, detail=pw_err)
        otp = (data.Otp or "").strip()
        if len(otp) != 6 or not otp.isdigit():
            raise HTTPException(status_code=400, detail="Enter the 6-digit verification code from your email")
        cursor.execute("SELECT * FROM users WHERE lower(email) = lower(?)", (email,))
        existing_user = cursor.fetchone()
        if existing_user:
            raise HTTPException(status_code=400, detail="Email already registered")
        cursor.execute(
            """
            SELECT id, otp_hash, expires_at FROM signup_verification_otp
            WHERE lower(email) = lower(?) ORDER BY id DESC LIMIT 1
            """,
            (email,),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="No verification code. Tap “Send code” on sign up first.")
        _, stored_hash, expires_at = row
        if datetime.utcnow() > datetime.fromisoformat(expires_at):
            raise HTTPException(status_code=400, detail="Verification code expired. Request a new code.")
        if not secrets.compare_digest(stored_hash, _hash_otp(otp)):
            raise HTTPException(status_code=400, detail="Invalid verification code")
        hashed_password = hashlib.sha256(password.encode()).hexdigest()
        
        # Insert user; user_id will be set to the numeric DB id (easier numeric lookup/search)
        cursor.execute("INSERT INTO users (email, password) VALUES (?, ?)", (email, hashed_password))
        con.commit()
        numeric_id = cursor.lastrowid
        # Generate a unique 14-digit numeric user_id (string) and ensure uniqueness
        attempts = 0
        new_user_id = None
        while attempts < 10:
            candidate = str(secrets.randbelow(10**14)).zfill(14)
            cursor.execute("SELECT 1 FROM users WHERE user_id = ?", (candidate,))
            if not cursor.fetchone():
                new_user_id = candidate
                break
            attempts += 1
        if not new_user_id:
            # fallback to using the numeric DB id padded
            new_user_id = str(numeric_id).zfill(14)
        user_id = new_user_id
        cursor.execute("UPDATE users SET user_id=? WHERE id=?", (user_id, numeric_id))
        cursor.execute("DELETE FROM signup_verification_otp WHERE lower(email) = lower(?)", (email,))
        con.commit()
        # Do NOT return an auth token on registration; require explicit login.
        # Try to send welcome email (do not block registration on failure)
        email_sent = False
        email_warning = None
        if smtp_configured():
            try:
                send_welcome_email(email)
                cursor.execute("UPDATE users SET welcome_sent=1 WHERE lower(email) = lower(?)", (email,))
                con.commit()
                email_sent = True
            except SmtpSendError as e:
                email_warning = e.message
            except Exception:
                email_warning = "Unexpected error while sending email."

        resp = {
            "message": "Account Created",
            "email_sent": email_sent,
            "id": numeric_id,
            "user_id": user_id,
        }
        if email_warning:
            resp["email_warning"] = email_warning
        return resp
    except HTTPException as he:
        raise he
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")


class OtpRequest(BaseModel):
    Email: str


class ResetWithOtp(BaseModel):
    Email: str
    Otp: str
    NewPassword: str


OTP_TTL_MINUTES = 15
OTP_MAX_PER_HOUR = 5
MIN_PASSWORD_LEN = 8
_PASSWORD_SPECIAL_RE = re.compile(r'[!@#$%^&*()_+\-=\[\]{}|;:,.<>?~]')


def validate_password_policy(password: str) -> tuple[bool, str]:
    """
    Strong password rules (register + password reset). Login still accepts older hashes.
    """
    pw = password or ""
    if len(pw.strip()) < MIN_PASSWORD_LEN:
        return False, f"Password must be at least {MIN_PASSWORD_LEN} characters"
    if not re.search(r"[A-Z]", pw):
        return False, "Password must include at least one uppercase letter"
    if not re.search(r"[a-z]", pw):
        return False, "Password must include at least one lowercase letter"
    if not re.search(r"\d", pw):
        return False, "Password must include at least one digit"
    if not _PASSWORD_SPECIAL_RE.search(pw):
        return False, "Password must include at least one special character (!@#$… etc.)"
    return True, ""


def _hash_otp(otp: str) -> str:
    return hashlib.sha256(otp.strip().encode()).hexdigest()


@app.post("/request-reset-otp")
def request_reset_otp(data: OtpRequest):
    con, cursor = get_db()
    try:
        raw = data.Email.strip()
        if not raw:
            raise HTTPException(status_code=400, detail="Invalid email")
        ok, err = google_identity_email_allowed(raw)
        if not ok:
            raise HTTPException(status_code=400, detail=err)
        email = normalize_email_for_storage(raw)
        cursor.execute("SELECT id FROM users WHERE lower(email) = lower(?)", (email,))
        if not cursor.fetchone():
            raise HTTPException(status_code=400, detail="Email not found")
        since = (datetime.utcnow() - timedelta(hours=1)).isoformat()
        cursor.execute(
            "SELECT COUNT(*) FROM password_reset_otp WHERE lower(email) = lower(?) AND created_at > ?",
            (email, since),
        )
        if cursor.fetchone()[0] >= OTP_MAX_PER_HOUR:
            raise HTTPException(status_code=429, detail="Too many requests. Try again later.")
        otp_plain = f"{secrets.randbelow(1_000_000):06d}"
        otp_hash = _hash_otp(otp_plain)
        now = datetime.utcnow()
        expires = (now + timedelta(minutes=OTP_TTL_MINUTES)).isoformat()
        created = now.isoformat()
        cursor.execute("DELETE FROM password_reset_otp WHERE lower(email) = lower(?)", (email,))
        cursor.execute(
            "INSERT INTO password_reset_otp (email, otp_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (email, otp_hash, expires, created),
        )
        con.commit()
        dev_return = os.getenv("DEV_RETURN_OTP", "").lower() in ("1", "true", "yes")
        if smtp_configured():
            try:
                send_otp_email(email, otp_plain, kind="reset")
            except SmtpSendError as e:
                raise HTTPException(status_code=502, detail=e.message) from e
            except Exception:
                raise HTTPException(status_code=502, detail="Unexpected error while sending email.") from None
        elif dev_return:
            return {
                "message": "Test mode: No email sent; use the code below.",
                "email_sent": False,
                "dev_mode": True,
                "dev_otp": otp_plain,
                "masked_email": mask_email(email),
            }
        else:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Email sending not configured. "
                    "Add SMTP credentials to .env."
                ),
            )

        return {
            "message": "Verification code sent to your Gmail.",
            "email_sent": True,
            "masked_email": mask_email(email),
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")


@app.post("/request-signup-otp")
def request_signup_otp(data: OtpRequest):
    """Send a 6-digit code for new accounts only (email must not already be registered)."""
    con, cursor = get_db()
    try:
        raw = data.Email.strip()
        if not raw:
            raise HTTPException(status_code=400, detail="Invalid email")
        ok, err = google_identity_email_allowed(raw)
        if not ok:
            raise HTTPException(status_code=400, detail=err)
        email = normalize_email_for_storage(raw)
        cursor.execute("SELECT id FROM users WHERE lower(email) = lower(?)", (email,))
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="This email is already registered. Sign in instead.")
        since = (datetime.utcnow() - timedelta(hours=1)).isoformat()
        cursor.execute(
            "SELECT COUNT(*) FROM signup_verification_otp WHERE lower(email) = lower(?) AND created_at > ?",
            (email, since),
        )
        if cursor.fetchone()[0] >= OTP_MAX_PER_HOUR:
            raise HTTPException(status_code=429, detail="Too many requests. Try again later.")
        otp_plain = f"{secrets.randbelow(1_000_000):06d}"
        otp_hash = _hash_otp(otp_plain)
        now = datetime.utcnow()
        expires = (now + timedelta(minutes=OTP_TTL_MINUTES)).isoformat()
        created = now.isoformat()
        cursor.execute("DELETE FROM signup_verification_otp WHERE lower(email) = lower(?)", (email,))
        cursor.execute(
            "INSERT INTO signup_verification_otp (email, otp_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (email, otp_hash, expires, created),
        )
        con.commit()
        dev_return = os.getenv("DEV_RETURN_OTP", "").lower() in ("1", "true", "yes")
        if smtp_configured():
            try:
                send_otp_email(email, otp_plain, kind="signup")
            except SmtpSendError as e:
                raise HTTPException(status_code=502, detail=e.message) from e
            except Exception:
                raise HTTPException(status_code=502, detail="Unexpected error while sending email.") from None
        elif dev_return:
            return {
                "message": "Test mode: No email sent; use the code below.",
                "email_sent": False,
                "dev_mode": True,
                "dev_otp": otp_plain,
                "masked_email": mask_email(email),
            }
        else:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Email sending not configured. "
                    "Add SMTP credentials to .env."
                ),
            )

        return {
            "message": "Verification code sent to your Gmail.",
            "email_sent": True,
            "masked_email": mask_email(email),
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")


@app.post("/reset-password")
def reset_password(data: ResetWithOtp):
    con, cursor = get_db()
    try:
        raw = data.Email.strip()
        ok, err = google_identity_email_allowed(raw)
        if not ok:
            raise HTTPException(status_code=400, detail=err)
        email = normalize_email_for_storage(raw)
        otp = data.Otp.strip()
        new_password = data.NewPassword.strip() if data.NewPassword else ""
        ok_pw, pw_err = validate_password_policy(new_password)
        if not ok_pw:
            raise HTTPException(status_code=400, detail=pw_err)
        if len(otp) != 6 or not otp.isdigit():
            raise HTTPException(status_code=400, detail="Invalid verification code")
        cursor.execute("SELECT * FROM users WHERE lower(email) = lower(?)", (email,))
        user = cursor.fetchone()
        if not user:
            raise HTTPException(status_code=400, detail="Email not found")
        cursor.execute(
            """
            SELECT id, otp_hash, expires_at FROM password_reset_otp
            WHERE lower(email) = lower(?) ORDER BY id DESC LIMIT 1
            """,
            (email,),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="No verification code. Request a new code.")
        _, stored_hash, expires_at = row
        if datetime.utcnow() > datetime.fromisoformat(expires_at):
            raise HTTPException(status_code=400, detail="Verification code expired. Request a new code.")
        if not secrets.compare_digest(stored_hash, _hash_otp(otp)):
            raise HTTPException(status_code=400, detail="Invalid verification code")
        hashed_password = hashlib.sha256(new_password.encode()).hexdigest()
        cursor.execute("UPDATE users SET password=? WHERE lower(email) = lower(?)", (hashed_password, email))
        cursor.execute("DELETE FROM password_reset_otp WHERE lower(email) = lower(?)", (email,))
        con.commit()
        return {"message": "Password updated successfully"}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Server error")


@app.get("/home")
def home(user=Depends(verify_token)):
    return {"message": "Welcome", "user": user}


class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, list[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, email: str):
        await websocket.accept()
        email = email.lower()
        if email not in self.active_connections:
            self.active_connections[email] = []
        self.active_connections[email].append(websocket)

    def disconnect(self, websocket: WebSocket, email: str):
        email = email.lower()
        if email in self.active_connections:
            try:
                self.active_connections[email].remove(websocket)
                if not self.active_connections[email]:
                    del self.active_connections[email]
            except ValueError:
                pass

    async def send_personal_message(self, message: dict, email: str):
        email = email.lower()
        success = False
        if email in self.active_connections:
            for connection in self.active_connections[email]:
                try:
                    await connection.send_json(message)
                    success = True
                except:
                    pass
        return success


manager = ConnectionManager()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = None):
    # Verify token
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_email = payload.get("sub").lower()
    except Exception:
        await websocket.close(code=1008)
        return
    await manager.connect(websocket, user_email)
    # Use a dedicated connection for this WebSocket session (async-safe)
    ws_con = sqlite3.connect("login.db", check_same_thread=False)
    ws_cursor = ws_con.cursor()

    # On connect, push messages that were sent while user was offline (is_delivered = 0)
    try:
        ws_cursor.execute(
            "SELECT sender, content, timestamp FROM messages WHERE receiver = ? AND is_delivered = 0",
            (user_email,)
        )
        pending = ws_cursor.fetchall()
        if pending:
            for p_sender, p_content, p_timestamp in pending:
                # Decrypt/re-process is not needed here if we send raw, 
                # but we'll send it as a live message event
                # Actually, better to just push them and let client handle.
                # Client's onmessage expects {user, message, timestamp, to}
                
                # We need the plaintext content for live socket if possible, 
                # but since it's stored encrypted, we'd need to decrypt.
                # For simplicity in this mock, we'll just send a signal to refresh or similar.
                # Actually, let's just mark them delivered and notify senders.
                pass
            
            ws_cursor.execute(
                "UPDATE messages SET is_delivered = 1 WHERE receiver = ? AND is_delivered = 0",
                (user_email,)
            )
            ws_con.commit()
            
            # Notify senders that messages are now delivered
            # (In a real app we'd group these by sender)
            senders_to_notify = set(row[0] for row in pending)
            for s in senders_to_notify:
                await manager.send_personal_message(
                    {"type": "delivery_receipt", "reader": user_email, "at": datetime.utcnow().isoformat()},
                    s
                )
    except Exception as e:
        print("Error processing pending deliveries:", e)
    try:
        while True:
            data = await websocket.receive_json()
            ctrl = data.get("type")
            if ctrl == "typing":
                receiver = str(data.get("to", "")).lower().strip()
                if receiver and receiver != user_email:
                    await manager.send_personal_message(
                        {
                            "type": "typing",
                            "from": user_email,
                            "active": bool(data.get("active", True)),
                        },
                        receiver,
                    )
                continue

            if ctrl == "read":
                peer = str(data.get("to", "")).lower().strip()
                if peer and peer != user_email:
                    try:
                        ws_cursor.execute(
                            "UPDATE messages SET is_read = 1, is_delivered = 1 WHERE sender = ? AND receiver = ? AND is_read = 0",
                            (peer, user_email)
                        )
                        ws_con.commit()
                    except Exception as e:
                        print("Error updating read status:", e)
                    await manager.send_personal_message(
                        {"type": "read_receipt", "reader": user_email, "at": datetime.utcnow().isoformat()},
                        peer,
                    )
                continue

            if ctrl == "delivered":
                peer = str(data.get("to", "")).lower().strip()
                if peer and peer != user_email:
                    try:
                        ws_cursor.execute(
                            "UPDATE messages SET is_delivered = 1 WHERE sender = ? AND receiver = ? AND is_delivered = 0",
                            (peer, user_email)
                        )
                        ws_con.commit()
                    except Exception as e:
                        print("Error updating delivered status:", e)
                    await manager.send_personal_message(
                        {"type": "delivery_receipt", "reader": user_email, "at": datetime.utcnow().isoformat()},
                        peer,
                    )
                continue

            if ctrl in ["call", "webrtc"]:
                receiver = str(data.get("to", "")).lower().strip()
                if receiver and receiver != user_email:
                    # Inject sender email so receiver knows who it's from
                    data["from"] = user_email
                    await manager.send_personal_message(data, receiver)
                continue

            if "to" not in data:
                continue

            receiver = str(data["to"]).lower().strip()
            if not receiver:
                continue

            timestamp = datetime.utcnow().isoformat()

            # Encryption logic
            content = str(data.get("content", "")).strip()
            if not content:
                continue

            try:
                enc_result = _encrypt_for_scenario(crypto_utils.ACTIVE_CRYPTO_SCENARIO, user_email, receiver, content.encode('utf-8'))
                payload_str = json.dumps({
                    "scenario": enc_result["scenario"],
                    "iv": enc_result["iv"],
                    "ciphertext": enc_result["ciphertext"],
                    "tag": enc_result["tag"]
                })
            except Exception as e:
                print("Encryption error:", e)
                payload_str = content  # Fallback
            
            msg_payload = {
                "user": user_email,
                "message": content, # Send plaintext to live sockets
                "timestamp": timestamp,
                "to": receiver,
            }

            ws_cursor.execute(
                "INSERT INTO messages (sender, receiver, content, timestamp) VALUES (?, ?, ?, ?)",
                (user_email, receiver, payload_str, timestamp),
            )
            ws_con.commit()

            delivered = await manager.send_personal_message(msg_payload, receiver)
            if delivered:
                ws_cursor.execute(
                    "UPDATE messages SET is_delivered = 1 WHERE sender = ? AND receiver = ? AND timestamp = ?",
                    (user_email, receiver, timestamp)
                )
                ws_con.commit()
                # Notify sender immediately of delivery
                await manager.send_personal_message(
                    {"type": "delivery_receipt", "reader": receiver, "at": timestamp},
                    user_email
                )

            # Echo to sender's other connected sessions
            if receiver != user_email:
                await manager.send_personal_message(msg_payload, user_email)

    except WebSocketDisconnect:
        manager.disconnect(websocket, user_email)
    except Exception:
        manager.disconnect(websocket, user_email)
    finally:
        ws_con.close()


class ActionRequest(BaseModel):
    contact_email: str

@app.post("/search-users")
def search_users(req: ActionRequest, payload=Depends(verify_token)):
    con, cursor = get_db()
    user_email = payload.get("sub").lower()
    # Only support searching by exact 14-digit numeric `user_id`.
    raw = (req.contact_email or "").strip()
    # Normalize to digits only
    search = re.sub(r"\D", "", raw)
    if not search:
        return {"users": []}

    # If 14 digits, match user_id exactly. If fewer digits, allow searching by numeric DB id or
    # by zero-padded user_id equivalent (so typing '1' will match user_id '00000000000001').
    users_data = []
    if re.fullmatch(r"\d{14}", search):
        cursor.execute("SELECT id, email, user_id, display_name, bio, avatar FROM users WHERE user_id = ? AND lower(email) != ?", (search, user_email))
        users_data = cursor.fetchall()
    else:
        # Try numeric DB id match and zero-padded user_id match
        try:
            numeric_id = int(search)
        except Exception:
            numeric_id = None
        padded = search.zfill(14)
        if numeric_id is not None:
            cursor.execute(
                "SELECT id, email, user_id, display_name, bio, avatar FROM users WHERE (id = ? OR user_id = ?) AND lower(email) != ?",
                (numeric_id, padded, user_email),
            )
        else:
            cursor.execute(
                "SELECT id, email, user_id, display_name, bio, avatar FROM users WHERE user_id = ? AND lower(email) != ?",
                (padded, user_email),
            )
        users_data = cursor.fetchall()

    # Return contact_email under a non-displayed key, frontend may use it for actions but should not render it visibly.
    users_data = [
        {"id": u[0], "contact_email": u[1], "user_id": u[2], "display_name": u[3], "bio": u[4], "avatar": u[5]}
        for u in users_data
    ]
    return {"users": users_data}

# Legacy profile endpoints removed to avoid duplicate route definitions.
# New profile endpoints (display_name, avatar, bio) are defined later in the file.

@app.post("/send-request")
def send_request(req: ActionRequest, payload=Depends(verify_token)):
    con, cursor = get_db()
    user_email = payload.get("sub").lower()
    receiver = req.contact_email.lower().strip()
    
    cursor.execute("SELECT * FROM users WHERE lower(email) = ?", (receiver,))
    if not cursor.fetchone():
        raise HTTPException(status_code=400, detail="User not found")
        
    cursor.execute("SELECT status FROM chat_requests WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?)", 
        (user_email, receiver, receiver, user_email))
    existing = cursor.fetchone()
    if existing:
        raise HTTPException(status_code=400, detail=f"Request already exists (status: {existing[0]})")
        
    created_at = datetime.utcnow().isoformat()
    cursor.execute("INSERT INTO chat_requests (sender, receiver, status, created_at) VALUES (?, ?, 'pending', ?)",
        (user_email, receiver, created_at))
    con.commit()
    return {"message": "Request sent"}

@app.get("/get-requests")
def get_requests(payload=Depends(verify_token)):
    con, cursor = get_db()
    user_email = payload.get("sub").lower()
    cursor.execute("SELECT sender, created_at FROM chat_requests WHERE receiver=? AND status='pending'", (user_email,))
    rows = cursor.fetchall()
    requests = []
    for r in rows:
        sender_email = r[0]
        cursor.execute("SELECT display_name, avatar, user_id FROM users WHERE lower(email)=?", (sender_email,))
        u = cursor.fetchone()
        requests.append({
            "sender": sender_email, 
            "display_name": u[0] if u and u[0] else None, 
            "avatar": u[1] if u and u[1] else None,
            "user_id": u[2] if u and u[2] else None,
            "created_at": r[1]
        })
    return {"requests": requests}

@app.post("/accept-request")
def accept_request(req: ActionRequest, payload=Depends(verify_token)):
    con, cursor = get_db()
    user_email = payload.get("sub").lower()
    sender = req.contact_email.lower().strip()
    
    cursor.execute("UPDATE chat_requests SET status='accepted' WHERE sender=? AND receiver=? AND status='pending'", (sender, user_email))
    if cursor.rowcount == 0:
        raise HTTPException(status_code=400, detail="No pending request found")
    con.commit()
    return {"message": "Request accepted"}

@app.post("/reject-request")
def reject_request(req: ActionRequest, payload=Depends(verify_token)):
    con, cursor = get_db()
    user_email = payload.get("sub").lower()
    sender = req.contact_email.lower().strip()
    cursor.execute("DELETE FROM chat_requests WHERE sender=? AND receiver=? AND status='pending'", (sender, user_email))
    con.commit()
    return {"message": "Request rejected"}

@app.post("/delete-contact")
def delete_contact(req: ActionRequest, payload=Depends(verify_token)):
    con, cursor = get_db()
    user_email = payload.get("sub").lower()
    contact = req.contact_email.lower().strip()
    cursor.execute("DELETE FROM chat_requests WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?)", 
                   (user_email, contact, contact, user_email))
    con.commit()
    return {"message": "Contact deleted"}

@app.get("/get-contacts")
def get_contacts(payload=Depends(verify_token)):
    con, cursor = get_db()
    user_email = payload.get("sub").lower()
    cursor.execute("""
        SELECT sender, receiver FROM chat_requests 
        WHERE (sender=? OR receiver=?) AND status='accepted'
    """, (user_email, user_email))
    contacts = []
    for row in cursor.fetchall():
        contact_email = row[0] if row[1] == user_email else row[1]
        # Fetch display_name, bio, avatar from users table
        cursor.execute("SELECT id, user_id, display_name, bio, avatar FROM users WHERE lower(email)=?", (contact_email,))
        u_info = cursor.fetchone()
        if u_info:
            # Count unread messages from this contact
            cursor.execute("SELECT COUNT(*) FROM messages WHERE sender=? AND receiver=? AND is_read=0", (contact_email, user_email))
            unread_count = cursor.fetchone()[0]
            
            contacts.append({
                "contact_email": contact_email,
                "id": u_info[0],
                "user_id": u_info[1],
                "display_name": u_info[2],
                "bio": u_info[3],
                "avatar": u_info[4],
                "unread_count": unread_count
            })
    return {"contacts": contacts}

@app.get("/get-messages")
def get_messages(contact_email: str, payload=Depends(verify_token)):
    con, cursor = get_db()
    user_email = payload.get("sub").lower()
    contact = contact_email.lower().strip()

    cursor.execute("""
        SELECT sender, content, timestamp, is_read, is_delivered FROM messages 
        WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?)
        ORDER BY timestamp ASC
    """, (user_email, contact, contact, user_email))
    
    msgs = []
    for row in cursor.fetchall():
        sender, content_str, timestamp, is_read, is_delivered = row
        
        try:
            enc_data = json.loads(content_str)
            if "ciphertext" in enc_data:
                decrypted_bytes = _decrypt_for_scenario(enc_data, user_email, contact)
                plain = decrypted_bytes.decode('utf-8')
            else:
                plain = content_str
        except Exception:
            plain = content_str

        msgs.append({"sender": sender, "content": plain, "timestamp": timestamp, "is_read": bool(is_read), "is_delivered": bool(is_delivered)})
        
    return {"messages": msgs}

class PublicKeyData(BaseModel):
    public_key: str


class ProfileData(BaseModel):
    display_name: str | None = None
    bio: str | None = None
    avatar: str | None = None

@app.post("/register-key")
def register_key(data: PublicKeyData, payload=Depends(verify_token)):
    con, cursor = get_db()
    user_email = payload.get("sub").lower()
    cursor.execute("REPLACE INTO user_keys (email, public_key) VALUES (?, ?)", (user_email, data.public_key))
    con.commit()
    return {"message": "Key registered"}

@app.get("/get-key")
def get_key(email: str, payload=Depends(verify_token)):
    con, cursor = get_db()
    cursor.execute("SELECT public_key FROM user_keys WHERE email=?", (email.lower().strip(),))
    row = cursor.fetchone()
    if row:
        return {"public_key": row[0]}
    return {"public_key": None}


@app.get("/get-profile")
def get_profile(email: str | None = None, payload=Depends(verify_token)):
    con, cursor = get_db()
    requester = payload.get("sub").lower()
    target = requester if not email else email.lower().strip()
    cursor.execute("SELECT id, user_id, display_name, email, bio, avatar FROM users WHERE lower(email)=?", (target,))
    row = cursor.fetchone()
    if not row:
        return {"id": None, "user_id": None, "display_name": None, "email": target, "bio": None, "avatar": None, "profile_banner": None}
    id_ret, user_id_ret, display_name, email_ret, bio, avatar = row
    return {
        "id": id_ret,
        "user_id": user_id_ret or None,
        "display_name": display_name or None,
        "email": email_ret,
        "bio": bio or None,
        "avatar": avatar or None,
        "profile_banner": avatar or None,
    }


@app.post("/update-profile")
def update_profile(data: ProfileData, payload=Depends(verify_token)):
    con, cursor = get_db()
    user_email = payload.get("sub").lower()
    # Build dynamic update
    updates = []
    params = []
    if data.display_name is not None:
        updates.append("display_name = ?")
        params.append(data.display_name)
    if data.bio is not None:
        updates.append("bio = ?")
        params.append(data.bio)
    if data.avatar is not None:
        updates.append("avatar = ?")
        params.append(data.avatar)
    if not updates:
        return {"message": "No changes"}
    params.append(user_email)
    sql = "UPDATE users SET " + ", ".join(updates) + " WHERE lower(email)=?"
    cursor.execute(sql, params)
    con.commit()
    return {"message": "Profile updated"}

# ─────────────────────────────────────────────
# ADMIN ROUTES
# ─────────────────────────────────────────────

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@securechat.local")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Admin@12345")


def _require_admin(payload=Depends(verify_token)):
    """Dependency: raises 403 if the token owner is not an admin."""
    email = payload.get("sub", "").lower()
    con, cursor = get_db()
    cursor.execute("SELECT is_admin FROM users WHERE lower(email)=?", (email,))
    row = cursor.fetchone()
    if not row or not row[0]:
        raise HTTPException(status_code=403, detail="Admin access required")
    return payload


class AdminLoginRequest(BaseModel):
    Email: str
    Password: str


@app.post("/admin/login")
def admin_login(data: AdminLoginRequest):
    """Admin-only login. Creates the admin user if it doesn't exist yet."""
    con, cursor = get_db()
    email = data.Email.strip().lower()
    password = data.Password

    hashed_password = hashlib.sha256(password.encode()).hexdigest()

    # Auto-create the admin account on first login
    cursor.execute("SELECT id, password, is_admin FROM users WHERE lower(email)=?", (email,))
    row = cursor.fetchone()

    if not row:
        # First-time: create admin user
        user_id = "00000000000000"
        cursor.execute(
            "INSERT INTO users (email, password, user_id, display_name, is_admin) VALUES (?, ?, ?, ?, 1)",
            (email, hashed_password, user_id, "Admin"),
        )
        con.commit()
        cursor.execute("SELECT id FROM users WHERE lower(email)=?", (email,))
        row2 = cursor.fetchone()
        token = create_access_token({"sub": email})
        return {"access_token": token, "token_type": "bearer", "is_admin": True}

    db_id, db_hash, is_admin = row
    if not is_admin:
        raise HTTPException(status_code=403, detail="This account is not an admin")
    if hashlib.sha256(password.encode()).hexdigest() != db_hash:
        raise HTTPException(status_code=401, detail="Invalid admin credentials")

    token = create_access_token({"sub": email})
    return {"access_token": token, "token_type": "bearer", "is_admin": True}


@app.get("/admin/stats")
def admin_stats(payload=Depends(_require_admin)):
    """Dashboard stats: user count, message count, contact pairs."""
    con, cursor = get_db()
    cursor.execute("SELECT COUNT(*) FROM users WHERE is_admin IS NULL OR is_admin=0")
    total_users = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM messages")
    total_messages = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM channel_messages")
    total_channel_messages = cursor.fetchone()[0]
    
    cursor.execute("SELECT COUNT(*) FROM workspaces")
    total_workspaces = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM channels")
    total_channels = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM chat_requests WHERE status='pending'")
    pending_requests = cursor.fetchone()[0]

    cursor.execute(
        "SELECT email, display_name, user_id FROM users WHERE is_admin IS NULL OR is_admin=0 ORDER BY id DESC LIMIT 5"
    )
    recent_users = [{"email": r[0], "display_name": r[1], "user_id": r[2]} for r in cursor.fetchall()]
    
    # Collect all unique online emails from both managers
    online_emails = set(manager.active_connections.keys())
    # Add emails from channel manager
    try:
        from routers.channels import channel_manager
        online_emails.update(channel_manager.get_all_online_users())
    except Exception:
        pass
    
    online_users = len(online_emails)
    
    return {
        "total_users": total_users,
        "total_messages": total_messages + total_channel_messages,
        "total_workspaces": total_workspaces,
        "total_channels": total_channels,
        "online_users": online_users,
        "pending_requests": pending_requests,
        "recent_users": recent_users,
    }

@app.get("/admin/workspaces")
def admin_workspaces(payload=Depends(_require_admin)):
    """List all workspaces with basic stats."""
    con, cursor = get_db()
    cursor.execute("""
        SELECT w.id, w.name, w.owner_email, 
               (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) as member_count,
               (SELECT COUNT(*) FROM channels WHERE workspace_id = w.id) as channel_count
        FROM workspaces w
        ORDER BY w.id DESC
    """)
    rows = cursor.fetchall()
    workspaces = []
    for r in rows:
        workspaces.append({
            "id": r[0], "name": r[1], "owner": r[2], 
            "members_count": r[3], "channels_count": r[4]
        })
    return {"workspaces": workspaces}

@app.get("/admin/workspace/{ws_id}/details")
def admin_workspace_details(ws_id: int, payload=Depends(_require_admin)):
    """Get members and channels for a specific workspace."""
    con, cursor = get_db()
    # Members
    cursor.execute("""
        SELECT email, role, joined_at 
        FROM workspace_members 
        WHERE workspace_id = ?
    """, (ws_id,))
    members = [{"email": r[0], "role": r[1], "joined_at": r[2]} for r in cursor.fetchall()]
    
    # Channels
    cursor.execute("""
        SELECT id, name, created_at 
        FROM channels 
        WHERE workspace_id = ?
    """, (ws_id,))
    channels = [{"id": r[0], "name": r[1], "created_at": r[2]} for r in cursor.fetchall()]
    
    return {"members": members, "channels": channels}



class CryptoDemoRequest(BaseModel):
    scenario: str          # "aes_gcm" | "ecc" | "hybrid"
    plaintext: str         # The message to encrypt
    aes_key_hex: str | None = None  # Optional 32-byte hex key for AES-GCM scenario


@app.post("/admin/crypto-demo")
def crypto_demo(req: CryptoDemoRequest, payload=Depends(_require_admin)):
    """
    Run a live encryption demo for the admin dashboard.
    Returns step-by-step flow data for visualization.
    """
    scenario = req.scenario.strip().lower()
    plaintext = req.plaintext or "Hello, Secure World!"
    plaintext_bytes = plaintext.encode("utf-8")
    steps = []

    if scenario == "aes_gcm":
        # ── AES-256-GCM standalone ──────────────────────────────────────────
        t0 = time.perf_counter()
        # Generate or use provided key
        if req.aes_key_hex and len(req.aes_key_hex) == 64:
            try:
                key = bytes.fromhex(req.aes_key_hex)
            except Exception:
                key = os.urandom(32)
        else:
            key = os.urandom(32)

        steps.append({"step": 1, "title": "Key Generation", "detail": f"256-bit symmetric key generated: {key.hex()[:32]}…"})

        enc = encrypt_aes_gcm(key, plaintext_bytes)
        steps.append({"step": 2, "title": "Encrypt (AES-256-GCM)", "detail": f"IV={enc['iv']} | Ciphertext={enc['ciphertext'][:24]}… | Tag={enc['tag']}"})

        dec = decrypt_aes_gcm(key, enc["iv"], enc["ciphertext"], enc["tag"])
        steps.append({"step": 3, "title": "Decrypt & Verify Tag", "detail": f"GCM tag verified ✓ | Plaintext recovered: '{dec.decode()}'"})

        elapsed_ms = round((time.perf_counter() - t0) * 1000, 3)
        return {
            "scenario": "AES-256-GCM",
            "plaintext": plaintext,
            "key_hex": key.hex(),
            "encrypted": enc,
            "decrypted": dec.decode("utf-8"),
            "elapsed_ms": elapsed_ms,
            "steps": steps,
        }

    elif scenario == "ecc":
        # ── ECC key pair generation + ECDH shared secret ────────────────────
        t0 = time.perf_counter()
        alice_priv, alice_pub = generate_ecc_key_pair()
        steps.append({"step": 1, "title": "Alice generates ECC key pair", "detail": "Curve: SECP256R1 | Private key kept secret"})

        bob_priv, bob_pub = generate_ecc_key_pair()
        steps.append({"step": 2, "title": "Bob generates ECC key pair", "detail": "Curve: SECP256R1 | Public key shared with Alice"})

        alice_pub_pem = serialize_public_key_pem(alice_pub).decode()
        bob_pub_pem   = serialize_public_key_pem(bob_pub).decode()

        shared_alice = derive_conversation_key(alice_priv, bob_pub)
        shared_bob   = derive_conversation_key(bob_priv, alice_pub)
        match = shared_alice == shared_bob
        steps.append({"step": 3, "title": "ECDH Key Agreement", "detail": f"Alice & Bob derive same 256-bit key via HKDF-SHA256 | Match={match}"})
        steps.append({"step": 4, "title": "Shared Secret", "detail": f"{shared_alice.hex()[:32]}… (truncated for display)"})

        elapsed_ms = round((time.perf_counter() - t0) * 1000, 3)
        return {
            "scenario": "ECC (SECP256R1 + ECDH + HKDF)",
            "plaintext": plaintext,
            "alice_public_key": alice_pub_pem,
            "bob_public_key": bob_pub_pem,
            "shared_secret_hex": shared_alice.hex(),
            "keys_match": match,
            "elapsed_ms": elapsed_ms,
            "steps": steps,
        }

    elif scenario == "hybrid":
        # ── Hybrid: ECDH + HKDF + AES-256-GCM ─────────────────────────────
        t0 = time.perf_counter()
        sender_priv, sender_pub = generate_ecc_key_pair()
        steps.append({"step": 1, "title": "Sender key pair", "detail": "SECP256R1 private + public key generated"})

        receiver_priv, receiver_pub = generate_ecc_key_pair()
        steps.append({"step": 2, "title": "Receiver key pair", "detail": "SECP256R1 private + public key generated"})

        derived_key = derive_conversation_key(sender_priv, receiver_pub)
        steps.append({"step": 3, "title": "ECDH + HKDF", "detail": f"Shared 256-bit AES key derived: {derived_key.hex()[:32]}…"})

        enc = encrypt_message(sender_priv, receiver_pub, plaintext_bytes)
        steps.append({"step": 4, "title": "AES-256-GCM Encrypt", "detail": f"IV={enc['iv']} | CT={enc['ciphertext'][:24]}… | Tag={enc['tag']}"})

        dec_bytes = decrypt_message(receiver_priv, sender_pub, enc)
        steps.append({"step": 5, "title": "Decrypt & Verify", "detail": f"GCM tag verified ✓ | Recovered: '{dec_bytes.decode()}'"})

        elapsed_ms = round((time.perf_counter() - t0) * 1000, 3)
        return {
            "scenario": "Hybrid (ECC + HKDF + AES-256-GCM)",
            "plaintext": plaintext,
            "sender_public_key": serialize_public_key_pem(sender_pub).decode(),
            "receiver_public_key": serialize_public_key_pem(receiver_pub).decode(),
            "derived_key_hex": derived_key.hex(),
            "encrypted": enc,
            "decrypted": dec_bytes.decode("utf-8"),
            "elapsed_ms": elapsed_ms,
            "steps": steps,
        }

    else:
        raise HTTPException(status_code=400, detail="scenario must be 'aes_gcm', 'ecc', or 'hybrid'")


class ScenarioRequest(BaseModel):
    scenario: str


@app.get("/admin/get-scenario")
def get_active_scenario(payload=Depends(_require_admin)):
    return {"scenario": crypto_utils.ACTIVE_CRYPTO_SCENARIO}


@app.post("/admin/set-scenario")
def set_active_scenario(req: ScenarioRequest, payload=Depends(_require_admin)):
    s = req.scenario.strip().lower()
    if s not in ("aes_gcm", "ecc", "hybrid"):
        raise HTTPException(status_code=400, detail="scenario must be 'aes_gcm', 'ecc', or 'hybrid'")
    crypto_utils.ACTIVE_CRYPTO_SCENARIO = s
    return {"scenario": crypto_utils.ACTIVE_CRYPTO_SCENARIO}


@app.get("/admin/messages-crypto")
def admin_messages_crypto(payload=Depends(_require_admin)):
    """Return recent messages with raw encrypted data + decrypted plaintext for admin inspection."""
    con, cursor = get_db()
    cursor.execute("""
        SELECT * FROM (
            SELECT m.id, m.sender, m.receiver, m.content, m.timestamp, 'direct' as msg_type, NULL as workspace_name, NULL as channel_name
            FROM messages m
            UNION ALL
            SELECT cm.id, cm.sender, 'channel_' || cm.channel_id as receiver, cm.content, cm.created_at as timestamp, 'channel' as msg_type, w.name as workspace_name, c.name as channel_name
            FROM channel_messages cm
            JOIN channels c ON cm.channel_id = c.id
            JOIN workspaces w ON c.workspace_id = w.id
        )
        ORDER BY timestamp DESC LIMIT 30
    """)
    rows = cursor.fetchall()
    messages = []
    for row in rows:
        msg_id, sender, receiver, content_str, ts, msg_type, ws_name, ch_name = row
        enc_data = None
        is_encrypted = False
        plaintext = content_str
        scenario_used = "none"
        crypto_details = {}
        try:
            parsed = json.loads(content_str)
            if "ciphertext" in parsed:
                enc_data = parsed
                is_encrypted = True
                scenario_used = parsed.get("scenario", "hybrid")
                dec = _decrypt_for_scenario(parsed, sender, receiver)
                plaintext = dec.decode('utf-8')
                crypto_details["iv"] = parsed["iv"]
                crypto_details["ciphertext"] = parsed["ciphertext"]
                crypto_details["tag"] = parsed["tag"]
                # Show derived key info
                sa = sender.lower().strip()
                ra = receiver.lower().strip()
                if scenario_used == "aes_gcm":
                    km = ''.join(sorted([sa, ra]))
                    crypto_details["aes_key_hex"] = hashlib.sha256(km.encode()).hexdigest()
                    crypto_details["key_method"] = "SHA-256(sorted_emails)"
                elif scenario_used == "ecc":
                    priv, s_pub = ensure_ecc_keys(sa)
                    _, r_pub = ensure_ecc_keys(ra)
                    raw = derive_shared_secret(priv, r_pub)
                    crypto_details["sender_public_key"] = serialize_public_key_pem(s_pub).decode('utf-8')
                    crypto_details["receiver_public_key"] = serialize_public_key_pem(r_pub).decode('utf-8')
                    crypto_details["shared_secret_hex"] = raw.hex()
                    crypto_details["derived_key_hex"] = hashlib.sha256(raw).hexdigest()
                    crypto_details["key_method"] = "ECDH → SHA-256"
                else:
                    priv, s_pub = ensure_ecc_keys(sa)
                    _, r_pub = ensure_ecc_keys(ra)
                    dk = derive_conversation_key(priv, r_pub)
                    crypto_details["sender_public_key"] = serialize_public_key_pem(s_pub).decode('utf-8')
                    crypto_details["receiver_public_key"] = serialize_public_key_pem(r_pub).decode('utf-8')
                    crypto_details["derived_key_hex"] = dk.hex()
                    crypto_details["key_method"] = "ECDH → HKDF-SHA256"
        except Exception as e:
            plaintext = content_str
            crypto_details["error"] = str(e)
        messages.append({
            "id": msg_id, "sender": sender, "receiver": receiver,
            "timestamp": ts, "is_encrypted": is_encrypted,
            "scenario": scenario_used, "plaintext": plaintext,
            "crypto": crypto_details, "msg_type": msg_type,
            "workspace_name": ws_name, "channel_name": ch_name
        })
    return {"messages": messages, "active_scenario": crypto_utils.ACTIVE_CRYPTO_SCENARIO}


if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
