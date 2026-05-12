"""ECC key operations and ECDH shared-secret utilities."""

from __future__ import annotations

import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def generate_ecc_key_pair():
    """
    Generate an ECC private/public key pair on curve SECP256R1.

    Inputs:
        None.
    Outputs:
        Tuple[EllipticCurvePrivateKey, EllipticCurvePublicKey].
    Security property:
        Produces fresh asymmetric key material required for ECDH key agreement.
    """
    private_key = ec.generate_private_key(ec.SECP256R1())
    return private_key, private_key.public_key()


def serialize_public_key_pem(public_key):
    """
    Serialize an ECC public key to PEM bytes.

    Inputs:
        public_key: EllipticCurvePublicKey instance.
    Outputs:
        bytes containing SubjectPublicKeyInfo PEM.
    Security property:
        Exposes only the non-secret public component for safe distribution.
    """
    return public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def load_public_key_pem(pem_bytes):
    """
    Deserialize a PEM-encoded ECC public key.

    Inputs:
        pem_bytes: bytes containing a PEM public key.
    Outputs:
        EllipticCurvePublicKey.
    Security property:
        Ensures key exchange uses validated key objects, reducing parsing misuse.
    """
    return serialization.load_pem_public_key(pem_bytes)


def derive_shared_secret(private_key, peer_public_key):
    """
    Perform ECDH and return raw shared secret bytes.

    Inputs:
        private_key: local EllipticCurvePrivateKey.
        peer_public_key: remote EllipticCurvePublicKey.
    Outputs:
        bytes shared secret.
    Security property:
        Derives a secret known only to participants owning matching private keys.
    """
    return private_key.exchange(ec.ECDH(), peer_public_key)


def benchmark_key_generation(iterations=100):
    """
    Benchmark ECC key generation average time in milliseconds.

    Inputs:
        iterations: int number of key generations to time.
    Outputs:
        float average milliseconds per operation.
    Security property:
        Operational metric only; does not weaken key generation randomness.
    """
    started = time.perf_counter()
    for _ in range(iterations):
        generate_ecc_key_pair()
    elapsed = time.perf_counter() - started
    return (elapsed / iterations) * 1000


def benchmark_ecdh(iterations=200):
    """
    Benchmark ECDH shared-secret derivation average time in milliseconds.

    Inputs:
        iterations: int number of ECDH operations to time.
    Outputs:
        float average milliseconds per operation.
    Security property:
        Measures agreement cost while still deriving genuine ECDH secrets.
    """
    a_priv, a_pub = generate_ecc_key_pair()
    b_priv, b_pub = generate_ecc_key_pair()
    _ = b_priv  # kept to ensure both keypairs are real and complete

    started = time.perf_counter()
    for _ in range(iterations):
        derive_shared_secret(a_priv, b_pub)
    elapsed = time.perf_counter() - started
    return (elapsed / iterations) * 1000
