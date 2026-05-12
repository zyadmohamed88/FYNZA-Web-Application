const API_BASE = "http://127.0.0.1:8000";
const CHAT_PAGE = "message.html";
const PASSWORD_MIN_LEN = 8;
const PASSWORD_SPECIAL_CHARS = '!@#$%^&*()_+-=[]{}|;:,.<>?~';

function passwordHasSpecialChar(p) {
    const s = p || "";
    for (let i = 0; i < PASSWORD_SPECIAL_CHARS.length; i++) {
        if (s.indexOf(PASSWORD_SPECIAL_CHARS[i]) !== -1) return true;
    }
    return false;
}

function goToChatWithToken(token) {
    const safeToken = (token || "").trim();
    if (!safeToken) return;
    try {
        localStorage.setItem("token", safeToken);
    } catch (_) {
        // Ignore storage failures and rely on URL fallback.
    }
    // URL hash fallback avoids auth loop if browser blocks localStorage between pages.
    window.location.replace(CHAT_PAGE + "#token=" + encodeURIComponent(safeToken));
}

/**
 * If a valid token is already stored, skip the auth page and go straight to chat.
 * Called once on DOMContentLoaded so returning users are not forced to log in again.
 */
async function checkAlreadyLoggedIn() {
    const params = new URLSearchParams(window.location.search);
    const authState = params.get("auth");
    if (authState === "failed" || authState === "missing") {
        // Prevent redirect loops after returning from chat due invalid/missing auth.
        params.delete("auth");
        const next = window.location.pathname + (params.toString() ? "?" + params.toString() : "");
        window.history.replaceState({}, document.title, next);
        return;
    }

    const token = localStorage.getItem("token");
    if (!token) return;
    try {
        const res = await fetch(API_BASE + "/home", {
            headers: { "Authorization": "Bearer " + token }
        });
        if (res.ok) {
            goToChatWithToken(token);
        } else {
            // Token expired or invalid — clean up silently
            localStorage.removeItem("token");
        }
    } catch {
        // Server unreachable — leave token in place so user can try when server is up
    }
}

/** Updated from the server when the reset form opens */
let authSmtpStatus = {
    smtp_configured: false,
    dev_otp_enabled: false,
    gmail_required: true,
    workspace_domains: [],
};

function emailDomain(email) {
    const e = (email || "").trim().toLowerCase();
    const i = e.lastIndexOf("@");
    if (i < 0) return "";
    return e.slice(i + 1);
}

function isAllowedGoogleEmail(email) {
    const d = emailDomain(email);
    if (d === "gmail.com" || d === "googlemail.com") return true;
    if (authSmtpStatus.workspace_domains && authSmtpStatus.workspace_domains.includes(d)) return true;
    if (!authSmtpStatus.gmail_required) return true;
    return false;
}

function setOtpSentBanner(visible) {
    const b = document.getElementById("otpSentBanner");
    if (!b) return;
    b.classList.toggle("d-none", !visible);
}

function setRegisterOtpSentBanner(visible) {
    const b = document.getElementById("registerOtpSentBanner");
    if (!b) return;
    b.classList.toggle("d-none", !visible);
}

function emailShapeValid(email) {
    const e = (email || "").trim();
    if (!e || e.indexOf("@") < 0) return false;
    const parts = e.split("@");
    if (parts.length !== 2) return false;
    return parts[0].trim().length > 0 && parts[1].trim().length > 0;
}

function passwordPolicyState(password) {
    const p = password || "";
    return {
        lengthOk: p.length >= PASSWORD_MIN_LEN,
        upperOk: /[A-Z]/.test(p),
        lowerOk: /[a-z]/.test(p),
        digitOk: /\d/.test(p),
        specialOk: passwordHasSpecialChar(p),
    };
}

function passwordMeetsPolicy(password) {
    const s = passwordPolicyState(password);
    return s.lengthOk && s.upperOk && s.lowerOk && s.digitOk && s.specialOk;
}

function renderLiveChecklist(ul, items) {
    if (!ul) return;
    ul.innerHTML = "";
    items.forEach(({ label, state }) => {
        const li = document.createElement("li");
        li.className =
            state === "ok" ? "live-check--ok" : state === "bad" ? "live-check--bad" : "live-check--wait";
        const icon =
            state === "ok" ? "bi-check-circle-fill" : state === "bad" ? "bi-x-circle-fill" : "bi-circle";
        const ic = document.createElement("i");
        ic.className = "bi " + icon + " live-check__icon";
        ic.setAttribute("aria-hidden", "true");
        const span = document.createElement("span");
        span.textContent = label;
        li.appendChild(ic);
        li.appendChild(span);
        ul.appendChild(li);
    });
}

function updateRegisterEmailChecks() {
    // Disabled per user request
}

function updateResetEmailChecks() {
    // Disabled per user request
}

function updatePasswordCriteriaList(ul, password) {
    if (!ul) return;
    const p = password || "";
    const s = passwordPolicyState(p);
    const rows = [
        { key: "len", label: "At least " + PASSWORD_MIN_LEN + " characters", ok: s.lengthOk },
        { key: "up", label: "One uppercase letter (A–Z)", ok: s.upperOk },
        { key: "lo", label: "One lowercase letter (a–z)", ok: s.lowerOk },
        { key: "dig", label: "One digit (0–9)", ok: s.digitOk },
        { key: "spec", label: "One special character (!@#$…)", ok: s.specialOk },
    ];
    const items = rows.map((r) => ({
        label: r.label,
        state: !p ? "wait" : r.ok ? "ok" : "bad",
    }));
    renderLiveChecklist(ul, items);
}

function updateRegisterPasswordChecks() {
    const pw = document.getElementById("regPassword");
    const ul = document.getElementById("regPasswordChecks");
    updatePasswordCriteriaList(ul, pw ? pw.value : "");
    updateRegisterConfirmMatch();
}

function updateResetPasswordChecks() {
    const pw = document.getElementById("resetNewPassword");
    const ul = document.getElementById("resetPasswordChecks");
    updatePasswordCriteriaList(ul, pw ? pw.value : "");
    updateResetConfirmMatch();
}

function setInlineMatch(el, text, variant) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove("live-hint--ok", "live-hint--bad", "live-hint--muted");
    if (variant === "ok") el.classList.add("live-hint--ok");
    else if (variant === "bad") el.classList.add("live-hint--bad");
    else el.classList.add("live-hint--muted");
}

function updateRegisterConfirmMatch() {
    const el = document.getElementById("regConfirmMatch");
    const pw = document.getElementById("regPassword");
    const c = document.getElementById("regConfirmPassword");
    if (!el || !pw || !c) return;
    const a = pw.value;
    const b = c.value;
    if (!b && !a) {
        setInlineMatch(el, "Re-enter your password to confirm.", "muted");
        return;
    }
    if (!b) {
        setInlineMatch(el, "Type the same password again.", "muted");
        return;
    }
    if (a === b) {
        setInlineMatch(el, "Passwords match.", "ok");
    } else {
        setInlineMatch(el, "Passwords do not match yet.", "bad");
    }
}

function updateResetConfirmMatch() {
    const el = document.getElementById("resetConfirmMatch");
    const pw = document.getElementById("resetNewPassword");
    const c = document.getElementById("resetConfirmPassword");
    if (!el || !pw || !c) return;
    const a = pw.value;
    const b = c.value;
    if (!b && !a) {
        setInlineMatch(el, "Re-enter your new password to confirm.", "muted");
        return;
    }
    if (!b) {
        setInlineMatch(el, "Type the same password again.", "muted");
        return;
    }
    if (a === b) {
        setInlineMatch(el, "Passwords match.", "ok");
    } else {
        setInlineMatch(el, "Passwords do not match yet.", "bad");
    }
}

function refreshSmtpHint() {
    const hints = document.querySelectorAll(".smtp-config-hint");
    if (!hints.length) return;
    fetch(API_BASE + "/auth/smtp-status")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            if (!data) return;
            authSmtpStatus = data;
            const text = !data.smtp_configured && !data.dev_otp_enabled
                ? "Note: email (SMTP) is not configured on the server. No real code will be delivered until you set credentials in .env or enable DEV_RETURN_OTP=true for local testing."
                : "";
            hints.forEach((hint) => {
                if (!data.smtp_configured && !data.dev_otp_enabled) {
                    hint.textContent = text;
                    hint.classList.remove("d-none");
                } else {
                    hint.classList.add("d-none");
                }
            });
        })
        .catch(() => {
            const text = "Could not reach the server. Make sure the API is running at " + API_BASE;
            hints.forEach((hint) => {
                hint.textContent = text;
                hint.classList.remove("d-none");
            });
        });
}

function formatApiError(data) {
    const d = data && data.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d) && d.length && d[0].msg) return d.map((x) => x.msg).join(" — ");
    return "Something went wrong with the request.";
}

function parseJsonResponse(res) {
    return res.text().then((text) => {
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            return {};
        }
    });
}

function setMessage(el, text, isError) {
    el.innerText = text;
    el.classList.toggle("form-message--error", !!isError);
    el.classList.toggle("form-message--ok", !isError && !!text);
}

function setButtonLoading(btn, loading, loadingLabel) {
    if (!btn) return;
    if (loading) {
        btn.dataset.originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>' + (loadingLabel || "...");
    } else {
        btn.disabled = false;
        if (btn.dataset.originalText !== undefined) {
            btn.innerHTML = btn.dataset.originalText;
            delete btn.dataset.originalText;
        }
    }
}

function togglePassword(inputId, iconId) {
    const passwordInput = document.getElementById(inputId);
    const eyeIcon = document.getElementById(iconId);

    if (passwordInput.type === "password") {
        passwordInput.type = "text";
        eyeIcon.classList.remove("bi-eye");
        eyeIcon.classList.add("bi-eye-slash");
    } else {
        passwordInput.type = "password";
        eyeIcon.classList.remove("bi-eye-slash");
        eyeIcon.classList.add("bi-eye");
    }
}

function clearResetFormFields(clearEmail) {
    document.getElementById("resetOtpInput").value = "";
    document.getElementById("resetNewPassword").value = "";
    const c = document.getElementById("resetConfirmPassword");
    if (c) c.value = "";
    if (clearEmail) document.getElementById("resetEmail").value = "";
}

function showForm(formId) {
    const authSec = document.getElementById("auth-section");
    const wasHidden = authSec ? authSec.classList.contains("d-none") : false;

    // Ensure the unified auth section is visible
    if (authSec) authSec.classList.remove("d-none");

    document.getElementById("loginForm").classList.add("d-none");
    document.getElementById("registerForm").classList.add("d-none");
    document.getElementById("resetForm").classList.add("d-none");

    setMessage(document.getElementById("loginMessage"), "", false);
    setMessage(document.getElementById("registerMessage"), "", false);
    setMessage(document.getElementById("resetMessage"), "", false);

    if (formId === "resetForm") {
        setOtpSentBanner(false);
        const re = document.getElementById("resetEmail");
        const le = document.getElementById("loginEmail");
        if (le && le.value.trim() && !re.value.trim()) {
            re.value = le.value.trim();
        }
        clearResetFormFields(false);
        refreshSmtpHint();
        updateResetEmailChecks();
        updateResetPasswordChecks();
    }
    if (formId === "registerForm") {
        setRegisterOtpSentBanner(false);
        refreshSmtpHint();
        updateRegisterEmailChecks();
        updateRegisterPasswordChecks();
    }
    if (formId === "loginForm") {
        clearResetFormFields(true);
    }

    document.getElementById(formId).classList.remove("d-none");
    
    // Re-center the box dynamically as the height changes between forms
    if (authSec) {
        // Use instant scroll (no smooth animation) to avoid visual jitter when swapping forms
        setTimeout(() => {
            authSec.scrollIntoView({behavior: "auto", block: "center"});
        }, 15);
    }
}

function login(event) {
    event.preventDefault();

    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const msg = document.getElementById("loginMessage");
    const submit = document.getElementById("loginSubmit");

    setMessage(msg, "", false);
    setButtonLoading(submit, true, "Signing in…");

    fetch(API_BASE + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Email: email, Password: password }),
    })
        .then(async (res) => {
            const data = await parseJsonResponse(res);
            if (!res.ok) throw new Error(formatApiError(data));
            return data;
        })
        .then((data) => {
            if (data.access_token) {
                goToChatWithToken(data.access_token);
            } else {
                setMessage(msg, "Login succeeded but no token was returned by the server.", true);
            }
        })
        .catch((err) => {
            setMessage(msg, err.message, true);
        })
        .finally(() => setButtonLoading(submit, false));
}

function registerAccount(event) {
    event.preventDefault();

    const email = document.getElementById("regEmail").value.trim();
    const password = document.getElementById("regPassword").value;
    const confirm = document.getElementById("regConfirmPassword").value;
    const otp = document.getElementById("regOtpInput").value.replace(/\D/g, "").trim();
    const msg = document.getElementById("registerMessage");
    const submit = document.getElementById("registerSubmit");

    if (!isAllowedGoogleEmail(email)) {
        setMessage(
            msg,
            "Please use a Google-verified Gmail address (@gmail.com). Disposable or non-Gmail addresses are not accepted.",
            true
        );
        return;
    }
    if (otp.length !== 6) {
        setMessage(msg, "Enter the 6-digit code from your email (tap “Send code” first).", true);
        return;
    }
    if (!passwordMeetsPolicy(password)) {
        setMessage(msg, "Your password does not meet all complexity requirements yet.", true);
        return;
    }
    if (password !== confirm) {
        setMessage(msg, "Password and confirmation do not match.", true);
        return;
    }

    setMessage(msg, "", false);
    setButtonLoading(submit, true, "Creating account…");

    fetch(API_BASE + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Email: email, Password: password, Otp: otp }),
    })
        .then(async (res) => {
            const data = await parseJsonResponse(res);
            if (!res.ok) throw new Error(formatApiError(data));
            return data;
        })
        .then((data) => {
                // Show success message and prompt user to sign in manually.
                setMessage(msg, "تم تسجيل الحساب بنجاح، يمكنك الآن تسجيل الدخول.", false);
                // Shorter delay before switching to login to reduce perceived flicker
                setTimeout(() => showForm("loginForm"), 800);
        })
        .catch((err) => setMessage(msg, err.message, true))
        .finally(() => setButtonLoading(submit, false));
}

function requestSignupOtp() {
    const email = document.getElementById("regEmail").value.trim();
    const msg = document.getElementById("registerMessage");
    const btn = document.getElementById("registerSendOtpBtn");

    if (!email) {
        setMessage(msg, "Enter your email first.", true);
        return;
    }
    if (!isAllowedGoogleEmail(email)) {
        setMessage(
            msg,
            "Only Gmail (or a Workspace domain allowed by the server) can receive a code.",
            true
        );
        setRegisterOtpSentBanner(false);
        return;
    }

    setMessage(msg, "", false);
    setRegisterOtpSentBanner(false);
    setButtonLoading(btn, true, "Sending…");

    fetch(API_BASE + "/request-signup-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Email: email }),
    })
        .then(async (res) => {
            const data = await parseJsonResponse(res);
            if (!res.ok) throw new Error(formatApiError(data));
            return data;
        })
        .then((data) => {
            if (data.email_sent) {
                setRegisterOtpSentBanner(true);
                setMessage(msg, "Code sent successfully. Check your inbox now.", false);
            } else if (data.dev_otp) {
                setRegisterOtpSentBanner(false);
                setMessage(
                    msg,
                    "Dev mode (no email sent). Your code is " + data.dev_otp + " — do not use this mode in production.",
                    false
                );
            } else {
                setRegisterOtpSentBanner(false);
                setMessage(msg, data.message || "Request received.", false);
            }
        })
        .catch((err) => setMessage(msg, err.message, true))
        .finally(() => setButtonLoading(btn, false));
}

function requestResetOtp() {
    const email = document.getElementById("resetEmail").value.trim();
    const msg = document.getElementById("resetMessage");
    const btn = document.getElementById("resetSendOtpBtn");

    if (!email) {
        setMessage(msg, "Enter your email first.", true);
        return;
    }
    if (!isAllowedGoogleEmail(email)) {
        setMessage(
            msg,
            "Only Gmail (or a Workspace domain allowed by the server) can receive a code.",
            true
        );
        setOtpSentBanner(false);
        return;
    }

    setMessage(msg, "", false);
    setOtpSentBanner(false);
    setButtonLoading(btn, true, "Sending…");

    fetch(API_BASE + "/request-reset-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Email: email }),
    })
        .then(async (res) => {
            const data = await parseJsonResponse(res);
            if (!res.ok) throw new Error(formatApiError(data));
            return data;
        })
        .then((data) => {
            if (data.email_sent) {
                setOtpSentBanner(true);
                setMessage(msg, "Code sent successfully. Check your inbox now.", false);
            } else if (data.dev_otp) {
                setOtpSentBanner(false);
                setMessage(
                    msg,
                    "Dev mode (no email sent). Your code is " + data.dev_otp + " — do not use this mode in production.",
                    false
                );
            } else {
                setOtpSentBanner(false);
                setMessage(msg, data.message || "Request received.", false);
            }
        })
        .catch((err) => setMessage(msg, err.message, true))
        .finally(() => setButtonLoading(btn, false));
}

function submitPasswordReset(event) {
    event.preventDefault();

    const email = document.getElementById("resetEmail").value.trim();
    const otp = document.getElementById("resetOtpInput").value.replace(/\D/g, "").trim();
    const newPassword = document.getElementById("resetNewPassword").value;
    const confirm = document.getElementById("resetConfirmPassword").value;
    const msg = document.getElementById("resetMessage");
    const submit = document.getElementById("resetSubmit");

    if (!email) {
        setMessage(msg, "Enter your email.", true);
        return;
    }
    if (!isAllowedGoogleEmail(email)) {
        setMessage(
            msg,
            "Only Gmail (or an allowed Workspace domain on the server) is accepted.",
            true
        );
        return;
    }
    if (otp.length !== 6) {
        setMessage(msg, "Enter the 6-digit code (tap “Send code” first if you have not).", true);
        return;
    }
    if (!passwordMeetsPolicy(newPassword)) {
        setMessage(msg, "Your new password does not meet all complexity requirements yet.", true);
        return;
    }
    if (newPassword !== confirm) {
        setMessage(msg, "Password and confirmation do not match.", true);
        return;
    }

    setMessage(msg, "", false);
    setButtonLoading(submit, true, "Updating…");

    fetch(API_BASE + "/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Email: email, Otp: otp, NewPassword: newPassword }),
    })
        .then(async (res) => {
            const data = await parseJsonResponse(res);
            if (!res.ok) throw new Error(formatApiError(data));
            return data;
        })
        .then(() => {
            setMessage(msg, "Password updated successfully.", false);
        })
        .catch((err) => setMessage(msg, err.message, true))
        .finally(() => setButtonLoading(submit, false));
}

function bindAuthLiveValidation() {
    const regEmail = document.getElementById("regEmail");
    const regPw = document.getElementById("regPassword");
    const regCf = document.getElementById("regConfirmPassword");
    if (regEmail) regEmail.addEventListener("input", updateRegisterEmailChecks);
    if (regPw) regPw.addEventListener("input", updateRegisterPasswordChecks);
    if (regCf) regCf.addEventListener("input", updateRegisterConfirmMatch);

    const reEmail = document.getElementById("resetEmail");
    const rePw = document.getElementById("resetNewPassword");
    const reCf = document.getElementById("resetConfirmPassword");
    if (reEmail) reEmail.addEventListener("input", updateResetEmailChecks);
    if (rePw) rePw.addEventListener("input", updateResetPasswordChecks);
    if (reCf) reCf.addEventListener("input", updateResetConfirmMatch);
}

document.addEventListener("DOMContentLoaded", function () {
    // Do not show any form by default; wait for user action.
    // showForm("loginForm");
    refreshSmtpHint();
    bindAuthLiveValidation();
    updateRegisterEmailChecks();
    updateRegisterPasswordChecks();
    updateResetEmailChecks();
    updateResetPasswordChecks();
});
