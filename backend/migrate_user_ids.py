#!/usr/bin/env python3
"""
One-off migration helper: assign unique 14-digit numeric `user_id`
to any rows in `users` where `user_id` is NULL or empty.

Run from the project root with the same Python used for the server.
Example:
  & D:/vs/python.exe c:/Users/SKYTOP/Desktop/Project_Final2/backend/migrate_user_ids.py
"""
import sqlite3
import secrets
import sys

DB = "login.db"


def main(dry_run=False):
    con = sqlite3.connect(DB)
    cur = con.cursor()

    cur.execute("SELECT user_id FROM users WHERE user_id IS NOT NULL AND user_id != ''")
    existing = {r[0] for r in cur.fetchall()}

    cur.execute("SELECT id FROM users WHERE user_id IS NULL OR user_id = ''")
    rows = [r[0] for r in cur.fetchall()]

    if not rows:
        print("No users require a new user_id. Nothing to do.")
        return 0

    assigned = []
    for uid in rows:
        new_id = None
        attempts = 0
        while attempts < 100:
            cand = str(secrets.randbelow(10**14)).zfill(14)
            if cand not in existing:
                new_id = cand
                existing.add(cand)
                break
            attempts += 1

        if new_id is None:
            # Fallback deterministic padding from numeric DB id
            new_id = str(uid).zfill(14)
            if new_id in existing:
                # As a last resort, increment until free
                base = int(new_id)
                while True:
                    base = (base + 1) % (10**14)
                    cand = str(base).zfill(14)
                    if cand not in existing:
                        new_id = cand
                        existing.add(cand)
                        break

        assigned.append((uid, new_id))
        if not dry_run:
            cur.execute("UPDATE users SET user_id = ? WHERE id = ?", (new_id, uid))

    if not dry_run:
        con.commit()

    print(f"Assigned {len(assigned)} new user_id(s):")
    for uid, nid in assigned:
        print(f"  id={uid} -> user_id={nid}")

    return 0


if __name__ == '__main__':
    dry = False
    if len(sys.argv) > 1 and sys.argv[1] in ('--dry-run', '-n'):
        dry = True
        print('Dry run: no DB changes will be made')
    raise SystemExit(main(dry_run=dry))
