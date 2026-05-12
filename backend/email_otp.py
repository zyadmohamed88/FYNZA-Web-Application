"""Send email via Gmail SMTP."""
import os
import smtplib
import ssl
from email.utils import formataddr, parseaddr
from email.message import EmailMessage


class SmtpSendError(Exception):
    """Clear error for API display."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _smtp_settings():
    user = os.getenv("SMTP_USER", "").strip()
    raw_pw = os.getenv("SMTP_PASSWORD", "").strip()
    # Google App Passwords may have spaces — SMTP needs 16 chars without spaces
    password = raw_pw.replace(" ", "") if raw_pw else ""
    host = os.getenv("SMTP_HOST", "smtp.gmail.com").strip()
    port = int(os.getenv("SMTP_PORT", "587"))
    mail_from = (os.getenv("SMTP_FROM") or user or "").strip()
    from_name = (os.getenv("SMTP_FROM_NAME") or "FYNZA").strip()
    use_ssl = os.getenv("SMTP_SSL", "").lower() in ("1", "true", "yes")
    return host, port, user, password, mail_from, from_name, use_ssl


def smtp_configured() -> bool:
    _, _, user, password, _, _, _ = _smtp_settings()
    return bool(user and password)


def _format_html_email(msg: EmailMessage, plain_body: str) -> None:
    html_body = f"""
    <html>
      <head>
        <style>
          body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; line-height: 1.6; padding: 20px; background: #f4f6fc; }}
          .container {{ max-width: 600px; margin: 0 auto; background: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }}
          .logo-container {{ text-align: center; margin-bottom: 25px; padding-bottom: 20px; border-bottom: 1px solid #eee; }}
          .css-logo {{ font-size: 36px; font-weight: 800; letter-spacing: -1.5px; color: #1a1a1a; text-decoration: none; }}
          .css-logo .f-letter {{ color: #8b5cf6; }}
          .content {{ font-size: 16px; color: #333; white-space: pre-wrap; }}
          .footer {{ margin-top: 30px; text-align: center; font-size: 12px; color: #888; }}
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo-container">
            <div class="css-logo"><span class="f-letter">F</span>YNZA</div>
          </div>
          <div class="content">{plain_body}</div>
          <div class="footer">
            &copy; 2026 FYNZA. Secure Messaging.
          </div>
        </div>
      </body>
    </html>
    """
    msg.set_content(plain_body)
    msg.add_alternative(html_body, subtype='html')


def send_otp_email(to_email: str, otp_plain: str, *, kind: str = "reset") -> None:
    host, port, user, password, mail_from, from_name, use_ssl = _smtp_settings()
    if not user or not password:
        raise SmtpSendError("SMTP_USER or SMTP_PASSWORD not set")

    if len(password) < 8:
        raise SmtpSendError("SMTP_PASSWORD seems invalid.")

    # English subject to avoid encoding issues
    if kind == "signup":
        subject = "FYNZA | Sign up verification code"
        body = (
            f"Your sign-up verification code: {otp_plain}\n\n"
            "This code is valid for 15 minutes.\n"
            "If you did not start creating a FYNZA account, ignore this email.\n\n"
            "---\n"
            "FYNZA Security\n"
        )
    else:
        subject = "FYNZA | Password reset verification code"
        body = (
            f"Your verification code: {otp_plain}\n\n"
            "This code is valid for 15 minutes.\n"
            "If you did not request a reset, ignore this email.\n\n"
            "---\n"
            "FYNZA Security\n"
        )

    msg = EmailMessage()
    _, from_address = parseaddr(mail_from)
    sender_address = from_address or mail_from
    msg["From"] = formataddr((from_name, sender_address))
    msg["To"] = to_email
    msg["Subject"] = subject
    _format_html_email(msg, body)

    context = ssl.create_default_context()

    try:
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, context=context, timeout=60) as server:
                server.login(user, password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=60) as server:
                server.ehlo()
                server.starttls(context=context)
                server.ehlo()
                server.login(user, password)
                server.send_message(msg)
    except smtplib.SMTPAuthenticationError as e:
        raise SmtpSendError("Gmail SMTP authentication failed.") from e
    except smtplib.SMTPRecipientsRefused as e:
        raise SmtpSendError(f"Recipient email rejected: {to_email}") from e
    except (smtplib.SMTPException, OSError, TimeoutError) as e:
        err = str(e).strip() or type(e).__name__
        raise SmtpSendError(f"Failed to send email via SMTP: {err}") from e


def send_welcome_email(to_email: str) -> None:
    host, port, user, password, mail_from, from_name, use_ssl = _smtp_settings()
    if not user or not password:
        raise SmtpSendError("SMTP_USER or SMTP_PASSWORD not set")

    subject = "Welcome to FYNZA"
    body = (
        "Hello,\n\n"
        "Thank you for signing up for FYNZA. We hope you have a safe and enjoyable experience.\n\n"
        "If you need any help, reply to this email.\n\n"
        "---\n"
        "FYNZA Team\n"
    )

    msg = EmailMessage()
    _, from_address = parseaddr(mail_from)
    sender_address = from_address or mail_from
    msg["From"] = formataddr((from_name, sender_address))
    msg["To"] = to_email
    msg["Subject"] = subject
    _format_html_email(msg, body)

    context = ssl.create_default_context()

    try:
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, context=context, timeout=60) as server:
                server.login(user, password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=60) as server:
                server.ehlo()
                server.starttls(context=context)
                server.ehlo()
                server.login(user, password)
                server.send_message(msg)
    except smtplib.SMTPAuthenticationError as e:
        raise SmtpSendError("Gmail SMTP authentication failed.") from e
    except smtplib.SMTPRecipientsRefused as e:
        raise SmtpSendError(f"Recipient email rejected: {to_email}") from e
    except (smtplib.SMTPException, OSError, TimeoutError) as e:
        err = str(e).strip() or type(e).__name__
        raise SmtpSendError(f"Failed to send email via SMTP: {err}") from e


def send_signin_alert_email(to_email: str) -> None:
    host, port, user, password, mail_from, from_name, use_ssl = _smtp_settings()
    if not user or not password:
        raise SmtpSendError("SMTP_USER or SMTP_PASSWORD not set")

    subject = "FYNZA | New Sign-In Alert"
    body = (
        "Hello,\n\n"
        "We noticed a new sign-in to your FYNZA account.\n\n"
        "If this was you, you can safely ignore this email.\n"
        "If you did not sign in, please secure your account immediately.\n\n"
        "---\n"
        "FYNZA Security\n"
    )

    msg = EmailMessage()
    _, from_address = parseaddr(mail_from)
    sender_address = from_address or mail_from
    msg["From"] = formataddr((from_name, sender_address))
    msg["To"] = to_email
    msg["Subject"] = subject
    _format_html_email(msg, body)

    context = ssl.create_default_context()

    try:
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, context=context, timeout=60) as server:
                server.login(user, password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=60) as server:
                server.ehlo()
                server.starttls(context=context)
                server.ehlo()
                server.login(user, password)
                server.send_message(msg)
    except smtplib.SMTPAuthenticationError as e:
        raise SmtpSendError("Gmail SMTP authentication failed.") from e
    except smtplib.SMTPRecipientsRefused as e:
        raise SmtpSendError(f"Recipient email rejected: {to_email}") from e
    except (smtplib.SMTPException, OSError, TimeoutError) as e:
        err = str(e).strip() or type(e).__name__
        raise SmtpSendError(f"Failed to send email via SMTP: {err}") from e
