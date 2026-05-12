"""
Workspaces Router — Phase 1
Handles workspace creation, membership, and retrieval.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import sqlite3
import threading
import time

router = APIRouter(prefix="/workspaces", tags=["workspaces"])

# ── Shared DB helper (mirrors app.py pattern) ──────────────────────────────
_local = threading.local()

def get_db():
    if not hasattr(_local, "con") or _local.con is None:
        _local.con = sqlite3.connect("login.db", check_same_thread=False)
        _local.cursor = _local.con.cursor()
    return _local.con, _local.cursor


# ── Pydantic models ────────────────────────────────────────────────────────
class WorkspaceCreate(BaseModel):
    name: str
    description: Optional[str] = ""

class WorkspaceInvite(BaseModel):
    user_id: str
    role: Optional[str] = "member"   # owner | admin | member | guest

class WorkspaceUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


# ── Helpers ────────────────────────────────────────────────────────────────
def _slugify(name: str) -> str:
    import re
    slug = name.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_-]+", "-", slug)
    slug = slug.strip("-")
    return slug[:50]

def _require_workspace_role(workspace_id: int, email: str, min_role: str = "member"):
    """Raise 403 if user doesn't have the required role."""
    hierarchy = {"guest": 0, "member": 1, "admin": 2, "owner": 3}
    con, cursor = get_db()
    cursor.execute(
        "SELECT role FROM workspace_members WHERE workspace_id=? AND email=?",
        (workspace_id, email.lower())
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=403, detail="Not a member of this workspace")
    if hierarchy.get(row[0], 0) < hierarchy.get(min_role, 1):
        raise HTTPException(status_code=403, detail=f"Requires '{min_role}' role or higher")
    return row[0]


# ── Routes ─────────────────────────────────────────────────────────────────

@router.post("/create")
def create_workspace(data: WorkspaceCreate, payload=Depends(lambda: None)):
    """Create a new workspace. Injected dependency resolved in app.py."""
    raise HTTPException(500, "Use the authenticated version")


@router.post("/create/auth")
def create_workspace_auth(data: WorkspaceCreate, user_email: str):
    """Create workspace — called internally after token verification."""
    con, cursor = get_db()
    name = data.name.strip()
    if not name:
        raise HTTPException(400, "Workspace name is required")

    # Unique slug
    base_slug = _slugify(name)
    slug = base_slug
    suffix = 1
    while True:
        cursor.execute("SELECT id FROM workspaces WHERE slug=?", (slug,))
        if not cursor.fetchone():
            break
        slug = f"{base_slug}-{suffix}"
        suffix += 1

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cursor.execute(
        "INSERT INTO workspaces (name, slug, description, owner_email, created_at) VALUES (?,?,?,?,?)",
        (name, slug, data.description or "", user_email.lower(), now)
    )
    workspace_id = cursor.lastrowid

    # Owner auto-joins
    cursor.execute(
        "INSERT INTO workspace_members (workspace_id, email, role, joined_at) VALUES (?,?,?,?)",
        (workspace_id, user_email.lower(), "owner", now)
    )

    # Auto-create #general channel
    cursor.execute(
        "INSERT INTO channels (workspace_id, name, description, is_private, created_by, created_at) VALUES (?,?,?,?,?,?)",
        (workspace_id, "general", "General discussion", 0, user_email.lower(), now)
    )
    channel_id = cursor.lastrowid

    # Owner joins #general
    cursor.execute(
        "INSERT INTO channel_members (channel_id, email, joined_at) VALUES (?,?,?)",
        (channel_id, user_email.lower(), now)
    )

    con.commit()
    return {
        "id": workspace_id,
        "name": name,
        "slug": slug,
        "description": data.description,
        "owner": user_email.lower(),
        "default_channel_id": channel_id
    }


@router.get("/mine")
def get_my_workspaces(user_email: str):
    """Return all workspaces the user belongs to."""
    con, cursor = get_db()
    cursor.execute("""
        SELECT w.id, w.name, w.slug, w.description, w.owner_email, wm.role, w.created_at, w.image
        FROM workspaces w
        JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE wm.email = ?
        ORDER BY w.created_at DESC
    """, (user_email.lower(),))
    rows = cursor.fetchall()
    return [
        {
            "id": r[0], "name": r[1], "slug": r[2], "description": r[3],
            "owner": r[4], "my_role": r[5], "created_at": r[6],
            "image": r[7] if len(r)>7 and r[7] else ""
        }
        for r in rows
    ]


@router.get("/{workspace_id}")
def get_workspace(workspace_id: int, user_email: str):
    """Get workspace details."""
    _require_workspace_role(workspace_id, user_email, "guest")
    con, cursor = get_db()
    cursor.execute("SELECT id, name, slug, description, owner_email, created_at FROM workspaces WHERE id=?", (workspace_id,))
    w = cursor.fetchone()
    if not w:
        raise HTTPException(404, "Workspace not found")

    # Member count
    cursor.execute("SELECT COUNT(*) FROM workspace_members WHERE workspace_id=?", (workspace_id,))
    member_count = cursor.fetchone()[0]

    return {
        "id": w[0], "name": w[1], "slug": w[2],
        "description": w[3], "owner": w[4],
        "created_at": w[5], "member_count": member_count
    }


@router.post("/{workspace_id}/invite")
def invite_member(workspace_id: int, data: WorkspaceInvite, user_email: str):
    """Invite a user to the workspace (admin/owner only)."""
    _require_workspace_role(workspace_id, user_email, "admin")
    con, cursor = get_db()

    # Verify invitee exists
    cursor.execute("SELECT email FROM users WHERE user_id=?", (data.user_id,))
    target_row = cursor.fetchone()
    if not target_row:
        raise HTTPException(404, "User not found by ID")
    target_email = target_row[0].lower()

    # Check not already member
    cursor.execute(
        "SELECT id FROM workspace_members WHERE workspace_id=? AND email=?",
        (workspace_id, target_email)
    )
    if cursor.fetchone():
        raise HTTPException(409, "User is already a member")

    valid_roles = {"owner", "admin", "member", "guest"}
    role = data.role if data.role in valid_roles else "member"

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cursor.execute(
        "INSERT INTO workspace_members (workspace_id, email, role, joined_at) VALUES (?,?,?,?)",
        (workspace_id, target_email, role, now)
    )

    # Also add to #general channel automatically
    cursor.execute(
        "SELECT id FROM channels WHERE workspace_id=? AND name='general'",
        (workspace_id,)
    )
    gen = cursor.fetchone()
    if gen:
        cursor.execute(
            "INSERT OR IGNORE INTO channel_members (channel_id, email, joined_at) VALUES (?,?,?)",
            (gen[0], target_email, now)
        )

    con.commit()
    return {"status": "invited", "email": data.email.lower(), "role": role}


@router.get("/{workspace_id}/members")
def get_members(workspace_id: int, user_email: str):
    """List all workspace members with their roles."""
    _require_workspace_role(workspace_id, user_email, "guest")
    con, cursor = get_db()
    cursor.execute("""
        SELECT wm.email, wm.role, wm.joined_at, u.display_name, u.avatar
        FROM workspace_members wm
        LEFT JOIN users u ON lower(u.email) = wm.email
        WHERE wm.workspace_id=?
        ORDER BY wm.role DESC, wm.joined_at ASC
    """, (workspace_id,))
    rows = cursor.fetchall()
    return [
        {
            "email": r[0], "role": r[1], "joined_at": r[2],
            "display_name": r[3] or r[0], "avatar": r[4] or ""
        }
        for r in rows
    ]


@router.delete("/{workspace_id}/members/{member_email}")
def remove_member(workspace_id: int, member_email: str, user_email: str):
    """Remove a member (admin/owner only, cannot remove owner)."""
    _require_workspace_role(workspace_id, user_email, "admin")
    con, cursor = get_db()

    cursor.execute(
        "SELECT role FROM workspace_members WHERE workspace_id=? AND email=?",
        (workspace_id, member_email.lower())
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(404, "Member not found")
    if row[0] == "owner":
        raise HTTPException(403, "Cannot remove the workspace owner")

    cursor.execute(
        "DELETE FROM workspace_members WHERE workspace_id=? AND email=?",
        (workspace_id, member_email.lower())
    )
    # Also remove from all channels
    cursor.execute("""
        DELETE FROM channel_members WHERE email=? AND channel_id IN (
            SELECT id FROM channels WHERE workspace_id=?
        )
    """, (member_email.lower(), workspace_id))
    con.commit()
    return {"status": "removed", "email": member_email.lower()}


@router.patch("/{workspace_id}/role/{member_email}")
def change_role(workspace_id: int, member_email: str, data: WorkspaceInvite, user_email: str):
    """Change a member's role (owner only)."""
    _require_workspace_role(workspace_id, user_email, "owner")
    valid_roles = {"admin", "member", "guest"}
    if data.role not in valid_roles:
        raise HTTPException(400, f"Role must be one of {valid_roles}")
    con, cursor = get_db()
    cursor.execute(
        "UPDATE workspace_members SET role=? WHERE workspace_id=? AND email=?",
        (data.role, workspace_id, member_email.lower())
    )
    if cursor.rowcount == 0:
        raise HTTPException(404, "Member not found")
    con.commit()
    return {"status": "updated", "email": member_email.lower(), "role": data.role}


@router.post("/{workspace_id}/leave")
def leave_workspace(workspace_id: int, user_email: str):
    """Allow a member to leave the workspace voluntarily. Owner cannot leave."""
    con, cursor = get_db()
    cursor.execute(
        "SELECT role FROM workspace_members WHERE workspace_id=? AND email=?",
        (workspace_id, user_email.lower())
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(404, "You are not a member of this workspace")
    if row[0] == "owner":
        raise HTTPException(403, "Owner cannot leave their own workspace. Transfer ownership first.")
    
    # Remove from workspace
    cursor.execute(
        "DELETE FROM workspace_members WHERE workspace_id=? AND email=?",
        (workspace_id, user_email.lower())
    )
    # Also remove from all channels in this workspace
    cursor.execute("""
        DELETE FROM channel_members WHERE email=? AND channel_id IN (
            SELECT id FROM channels WHERE workspace_id=?
        )
    """, (user_email.lower(), workspace_id))
    con.commit()
    return {"status": "left", "workspace_id": workspace_id}

class WorkspaceImageUpdate(BaseModel):
    image: str

@router.patch("/{workspace_id}/image")
def update_workspace_image(workspace_id: int, data: WorkspaceImageUpdate, user_email: str):
    """Update workspace image (owner/admin only)."""
    con, cursor = get_db()
    cursor.execute(
        "SELECT role FROM workspace_members WHERE workspace_id=? AND email=?",
        (workspace_id, user_email.lower())
    )
    row = cursor.fetchone()
    if not row or row[0] not in ["admin", "owner"]:
        raise HTTPException(403, "Only admins or the owner can update the workspace image")
    
    cursor.execute("UPDATE workspaces SET image=? WHERE id=?", (data.image, workspace_id))
    con.commit()
    return {"ok": True}

@router.patch("/{workspace_id}")
def update_workspace(workspace_id: int, data: WorkspaceUpdate, user_email: str):
    """Update workspace details like name and description (admin/owner only)."""
    _require_workspace_role(workspace_id, user_email, "admin")
    con, cursor = get_db()
    
    updates = []
    params = []
    if data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(400, "Workspace name cannot be empty")
        updates.append("name=?")
        params.append(name)
    if data.description is not None:
        updates.append("description=?")
        params.append(data.description.strip())
        
    if not updates:
        return {"ok": True, "message": "Nothing to update"}
        
    params.append(workspace_id)
    query = f"UPDATE workspaces SET {', '.join(updates)} WHERE id=?"
    cursor.execute(query, params)
    con.commit()
    return {"ok": True, "workspace_id": workspace_id}
