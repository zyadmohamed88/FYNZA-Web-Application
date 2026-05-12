<div align="center">
  <h1>🛡️ FYNZA Application</h1>
  <h3>Next-Generation Secure Messaging & Workspace Ecosystem</h3>
  
  [![Python](https://img.shields.io/badge/Python-3.10+-blue.svg)](https://www.python.org)
  [![FastAPI](https://img.shields.io/badge/FastAPI-0.95+-00a393.svg)](https://fastapi.tiangolo.com)
  [![Security](https://img.shields.io/badge/Security-Hybrid_Encryption-red.svg)]()
  [![License](https://img.shields.io/badge/License-MIT-green.svg)]()
</div>

<br>

## 📖 About The Project

**FYNZA Enterprise** is an advanced, web-based secure communication platform designed for modern organizations. It bridges the gap between absolute user privacy and essential administrative oversight. 

Unlike traditional messaging applications, FYNZA utilizes a **Multi-Layered Hybrid Cryptographic Engine** (combining AES-256-GCM and ECC NIST P-256) to secure data, while simultaneously providing a comprehensive **Forensic Administrative Dashboard** for real-time system monitoring and cryptographic auditing.

---

## ✨ Key Features

### 🏢 Enterprise Workspaces & Channels
* **Multi-Tenancy:** Isolated workspaces with dedicated membership and role-based access control (Owner, Admin, Member).
* **Channel Ecosystem:** Support for both Public and Private channels within workspaces.
* **Granular Tracking:** Track user presence and message flow across different channels.

### 🔒 Cryptographic Engine (V2.0)
* **AES-256-GCM:** High-speed, authenticated symmetric encryption.
* **ECC (ECDH):** Secure asymmetric key exchange using the NIST P-256 curve.
* **The Hybrid Gold Standard:** Combining ECDH for secure key agreement and HKDF-SHA256 for key derivation, resulting in unbreakable AES-GCM encryption with Perfect Forward Secrecy.
* **Live Protocol Switching:** Admins can dynamically switch the encryption algorithm globally without restarting the server.

### ⚡ Real-Time Communication
* **WebSocket Architecture:** Sub-100ms latency for instant messaging.
* **Live Indicators:** Typing status, delivery reports, and read receipts.
* **Privacy Controls:** Self-destructing messages with customizable timers.

### 🕵️‍♂️ Forensic Admin Dashboard
* **Live Crypto Auditing:** Inspect IVs, Authentication Tags, and Ciphertext for any message in real-time.
* **System Metrics:** Monitor active connections, workspace growth, and user registration.

---

## 🛠️ Technology Stack

* **Backend:** Python, FastAPI, Uvicorn, Python-Jose (JWT), Cryptography.io
* **Frontend:** Vanilla JavaScript, HTML5, CSS3 (Glassmorphism UI)
* **Database:** SQLite3 (Optimized with indexing)
* **Networking:** Native WebSockets
* **Security:** SMTP-based OTP (2FA), Password Hashing (SHA-256)

---

## 🚀 Installation & Setup

Follow these steps to run the project locally on your machine:

### 1. Prerequisites
Make sure you have [Python 3.10+](https://www.python.org/downloads/) installed.

### 2. Clone the Repository
```bash
git clone https://github.com/your-username/FYNZA.git
cd FYNZA
```

### 3. Install Dependencies
```bash
pip install fastapi uvicorn cryptography python-jose pydantic passlib
```
*(Note: Adjust the requirements based on your actual `requirements.txt` if available)*

### 4. Run the Server
```bash
cd backend
python app.py
```

### 5. Access the Platform
* **User Application:** Open `frontend/index.html` in your browser.
* **Admin Dashboard:** Open `frontend/admin.html` in your browser.

---

## 👥 Team Members

This project was developed by a dedicated team of 6 members:

1. *Zyad Elsheshtawy*
2. *Ahmed Elshkieh*
3. *Abdalla Elbedawee*
4. *Ahmed Tarek*
5. *Ali Elqulasi*
6. *Zyad Ammar*

*(Please replace the placeholders above with the actual names and roles of your team members).*

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.

<br>
<div align="center">
  <i>Built with ❤️ by the FYNZA Team</i>
</div>
