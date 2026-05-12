"""Hybrid encryption helpers using ECDH + HKDF + AES-256-GCM."""

from __future__ import annotations

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .aes_gcm import decrypt_aes_gcm, encrypt_aes_gcm
from .ecc import derive_shared_secret


def derive_conversation_key(private_key, peer_public_key, salt=None, info=b"secure-chat"):
    """
    Derive a 256-bit symmetric key from ECDH shared secret using HKDF-SHA256.

    Inputs:
        private_key: local elliptic-curve private key.
        peer_public_key: remote elliptic-curve public key.
        salt: optional HKDF salt bytes.
        info: optional HKDF context bytes.
    Outputs:
        32-byte symmetric key.
    Security property:
        Converts raw ECDH material into a uniformly distributed AES key.
    """
    shared_secret = derive_shared_secret(private_key, peer_public_key)
    hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info)
    return hkdf.derive(shared_secret)


def encrypt_message(private_key, peer_public_key, plaintext):
    """
    Encrypt plaintext using ECDH-derived AES-256-GCM key.

    Inputs:
        private_key: sender private key.
        peer_public_key: recipient public key.
        plaintext: bytes message content.
    Outputs:
        dict containing base64 iv, ciphertext, and tag.
    Security property:
        Ensures end-to-end confidentiality and integrity with per-peer derived key.
    """
    key = derive_conversation_key(private_key, peer_public_key)
    return encrypt_aes_gcm(key, plaintext)


def decrypt_message(private_key, peer_public_key, encrypted_payload):
    """
    Decrypt and authenticate payload encrypted with encrypt_message().

    Inputs:
        private_key: recipient private key.
        peer_public_key: sender public key.
        encrypted_payload: dict with iv, ciphertext, tag in base64.
    Outputs:
        plaintext bytes if authentication succeeds.
    Security property:
        Verifies authenticity via GCM tag and prevents plaintext release on tampering.
    """
    key = derive_conversation_key(private_key, peer_public_key)
    return decrypt_aes_gcm(
        key,
        encrypted_payload["iv"],
        encrypted_payload["ciphertext"],
        encrypted_payload["tag"],
    )
