"""AES-256-GCM encryption and decryption helpers."""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def encrypt_aes_gcm(key, plaintext, aad=None):
    """
    Encrypt bytes using AES-256-GCM with a fresh random 96-bit IV.

    Inputs:
        key: 32-byte symmetric key.
        plaintext: bytes to encrypt.
        aad: optional associated authenticated data bytes.
    Outputs:
        dict with base64 iv, ciphertext, and tag.
    Security property:
        Provides confidentiality and integrity; tampering is detected on decrypt.
    """
    iv = os.urandom(12)
    aesgcm = AESGCM(key)
    encrypted = aesgcm.encrypt(iv, plaintext, aad)
    ciphertext, tag = encrypted[:-16], encrypted[-16:]
    return {
        "iv": base64.b64encode(iv).decode("utf-8"),
        "ciphertext": base64.b64encode(ciphertext).decode("utf-8"),
        "tag": base64.b64encode(tag).decode("utf-8"),
    }


def decrypt_aes_gcm(key, iv_b64, ciphertext_b64, tag_b64, aad=None):
    """
    Decrypt AES-256-GCM payload and verify its authentication tag.

    Inputs:
        key: 32-byte symmetric key.
        iv_b64: base64 IV string.
        ciphertext_b64: base64 ciphertext string.
        tag_b64: base64 authentication tag string.
        aad: optional associated authenticated data bytes.
    Outputs:
        plaintext bytes on successful authentication.
    Security property:
        Rejects modified ciphertext/IV/tag, enforcing authenticated decryption.
    """
    iv = base64.b64decode(iv_b64)
    ciphertext = base64.b64decode(ciphertext_b64)
    tag = base64.b64decode(tag_b64)
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(iv, ciphertext + tag, aad)
