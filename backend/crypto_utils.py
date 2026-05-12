import hashlib
import json
import sqlite3
import threading
import time
from cryptography.hazmat.primitives import serialization
from crypto.ecc import generate_ecc_key_pair, serialize_public_key_pem, load_public_key_pem, derive_shared_secret
from crypto.hybrid import encrypt_message, decrypt_message, derive_conversation_key
from crypto.aes_gcm import encrypt_aes_gcm, decrypt_aes_gcm

_local = threading.local()

def get_db():
    if not hasattr(_local, "con") or _local.con is None:
        _local.con = sqlite3.connect("login.db", check_same_thread=False)
        _local.cursor = _local.con.cursor()
    return _local.con, _local.cursor

ACTIVE_CRYPTO_SCENARIO = "hybrid"

def ensure_ecc_keys(email: str):
    email = email.lower().strip()
    con, cursor = get_db()
    cursor.execute("SELECT public_key, private_key FROM user_keys WHERE email=?", (email,))
    row = cursor.fetchone()
    if row and row[1]:
        pub_pem = row[0].encode()
        priv_pem = row[1].encode()
        priv = serialization.load_pem_private_key(priv_pem, password=None)
        pub = load_public_key_pem(pub_pem)
        return priv, pub

    priv, pub = generate_ecc_key_pair()
    pub_pem = serialize_public_key_pem(pub).decode()
    priv_pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    ).decode()
    
    cursor.execute("REPLACE INTO user_keys (email, public_key, private_key) VALUES (?, ?, ?)", (email, pub_pem, priv_pem))
    con.commit()
    return priv, pub

def _encrypt_for_scenario(scenario, sender_email, receiver_email, plaintext_bytes):
    sender_email = sender_email.lower().strip()
    receiver_email = receiver_email.lower().strip()
    if scenario == "aes_gcm":
        key_material = ''.join(sorted([sender_email, receiver_email]))
        key = hashlib.sha256(key_material.encode()).digest()
        enc = encrypt_aes_gcm(key, plaintext_bytes)
        enc["scenario"] = "aes_gcm"
        return enc
    elif scenario == "ecc":
        s_priv, _ = ensure_ecc_keys(sender_email)
        _, r_pub = ensure_ecc_keys(receiver_email)
        raw_secret = derive_shared_secret(s_priv, r_pub)
        key = hashlib.sha256(raw_secret).digest()
        enc = encrypt_aes_gcm(key, plaintext_bytes)
        enc["scenario"] = "ecc"
        return enc
    else:  # hybrid
        s_priv, _ = ensure_ecc_keys(sender_email)
        _, r_pub = ensure_ecc_keys(receiver_email)
        enc = encrypt_message(s_priv, r_pub, plaintext_bytes)
        enc["scenario"] = "hybrid"
        return enc

def _decrypt_for_scenario(enc_data, email_a, email_b):
    scenario = enc_data.get("scenario", "hybrid")
    email_a = email_a.lower().strip()
    email_b = email_b.lower().strip()
    if scenario == "aes_gcm":
        key_material = ''.join(sorted([email_a, email_b]))
        key = hashlib.sha256(key_material.encode()).digest()
        return decrypt_aes_gcm(key, enc_data["iv"], enc_data["ciphertext"], enc_data["tag"])
    elif scenario == "ecc":
        priv, _ = ensure_ecc_keys(email_a)
        _, pub = ensure_ecc_keys(email_b)
        raw_secret = derive_shared_secret(priv, pub)
        key = hashlib.sha256(raw_secret).digest()
        return decrypt_aes_gcm(key, enc_data["iv"], enc_data["ciphertext"], enc_data["tag"])
    else:  # hybrid
        priv, _ = ensure_ecc_keys(email_a)
        _, pub = ensure_ecc_keys(email_b)
        return decrypt_message(priv, pub, enc_data)
