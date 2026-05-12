"""Email policy: Valid Google account."""
from __future__ import annotations

import os
from typing import Optional, Tuple


def google_identity_email_allowed(email: str) -> Tuple[bool, Optional[str]]:
    """
    Returns (allowed, error_message).
    Cannot programmatically prove Gmail exists without OAuth.
    """
    e = (email or "").strip()
    if "@" not in e or e.count("@") != 1:
        return False, "Invalid email format."

    local, domain = e.rsplit("@", 1)
    domain_l = domain.lower().strip()
    local = local.strip()
    if not local or not domain_l:
        return False, "Invalid email format."

    if os.getenv("ALLOW_NON_GMAIL_EMAILS", "").lower() in ("1", "true", "yes"):
        return True, None

    if domain_l in ("gmail.com", "googlemail.com"):
        return True, None

    extra = os.getenv("GOOGLE_WORKSPACE_ALLOWED_DOMAINS", "")
    allowed = {d.strip().lower() for d in extra.split(",") if d.strip()}
    if domain_l in allowed:
        return True, None

    return False, (
        "Only Google-linked Gmail (@gmail.com) allowed. "
        "Fake/public emails not accepted. "
        "For Workspace, add domain to GOOGLE_WORKSPACE_ALLOWED_DOMAINS in .env."
    )


def normalize_email_for_storage(email: str) -> str:
    """توحيد Register Gmail (Google يتجاهل حالة الأحرف في العنوان)."""
    e = email.strip()
    if "@" not in e:
        return e
    local, domain = e.rsplit("@", 1)
    if domain.lower() in ("gmail.com", "googlemail.com"):
        return f"{local}@{domain.lower()}".lower()
    return e


def mask_email(email: str) -> str:
    if "@" not in email:
        return "***"
    local, domain = email.rsplit("@", 1)
    if len(local) <= 2:
        return f"**@{domain}"
    return f"{local[0]}***@{domain}"
