import os

replacements = {
    'lang="ar" dir="rtl"': 'lang="en" dir="ltr"',

    "مرحباً | Elshiekh": "Welcome | Elshiekh",
    "لوحة الترحيب": "Welcome Dashboard",
    "تسجيل الخروج": "Logout",
    "جاري التحقق...": "Verifying...",
    "انتهت الجلسة أو الرمز غير صالح": "Session expired or invalid token",
    "تم تسجيل الدخول كـ: ": "Logged in as: ",
    "أهلاً بك.": "Welcome.",
    "تسجيل الدخول | Elshiekh": "Login | Elshiekh",
    "تسجيل الدخول": "Login",
    "البريد الإلكتروني": "Email Address",
    "أدخل البريد الإلكتروني": "Enter email address",
    "كلمة المرور": "Password",
    "أدخل كلمة المرور": "Enter password",
    "إظهار كلمة المرور": "Show password",
    "دخول": "Login",
    "إنشاء حساب": "Create Account",
    "نسيت كلمة المرور؟": "Forgot Password?",
    "التسجيل ببريد": "Register with",
    "فقط (@gmail.com) المرتبط بحساب Google.": "only (@gmail.com) linked to Google.",
    "بريد Gmail": "Gmail Address",
    "تسجيل": "Register",
    "العودة لتسجيل الدخول": "Back to Login",
    "تم إرسال الرمز.": "OTP Sent.",
    "افتح تطبيق أو موقع Gmail وابحث عن الرسالة (الوارد أو الرسائل غير المرغوب فيها). الرمز صالح 15 دقيقة.": (
        "Check your Gmail inbox or spam. "
        "Valid for 15 mins."
    ),
    "إعادة تعيين كلمة المرور": "Reset Password",
    "يُقبل فقط نفس بريد": "Only the registered",
    "المسجّل لدينا؛ لا يُرسل رمز لبريد وهمي أو غير Google.": "is accepted; no codes sent to fake/non-Google emails.",
    "بريد Gmail المسجّل": "Registered Gmail",
    "رمز التحقق (6 أرقام)": "Verification Code (6 digits)",
    "من البريد": "From email",
    "إرسال الرمز": "Send Code",
    "بعد إدخال البريد اضغط «إرسال الرمز»، ثم انسخ الرمز من الإيميل وأدخل كلمة المرور الجديدة.": (
        "Click 'Send Code', then copy the code from your email "
        "to enter a new password."
    ),
    "كلمة المرور الجديدة": "New Password",
    "6 أحرف على الأقل": "At least 6 characters",
    "تأكيد كلمة المرور": "Confirm Password",
    "أعد إدخال كلمة المرور": "Re-enter password",
    "تحديث كلمة المرور": "Update Password",

    "وضع تجريبي: لم يُرسل بريد؛ استخدم الرمز أدناه.": "Test mode: No email sent; use the code below.",
    "لم يُضبط إرسال البريد. أضف SMTP_USER و SMTP_PASSWORD في ملف .env أو فعّل DEV_RETURN_OTP=true للتجربة.": (
        "Email sending not configured. "
        "Add SMTP credentials to .env."
    ),
    "تم إرسال رمز التحقق إلى بريدك على Gmail.": "Verification code sent to your Gmail.",

    "خطأ واضح للعرض في الـ API (بدون تسريب أسرار).": "Clear error for API display.",
    "SMTP_USER أو SMTP_PASSWORD غير مضبوطين في البيئة أو ملف .env": ("SMTP_USER or SMTP_PASSWORD not set"),
    "SMTP_PASSWORD يبدو غير صالح (تأكد من App Password كامل من Google).": ("SMTP_PASSWORD seems invalid."),
    "رمز التحقق:": "Verification code:",
    "صالح لمدة 15 دقيقة.": "Valid for 15 minutes.",
    "فشل تسجيل الدخول لـ Gmail SMTP. استخدم App Password (ليس كلمة مرور الحساب)، وتأكد أن SMTP_USER هو نفس بريد Gmail، وأن التحقق بخطوتين مفعّل.": (
        "Gmail SMTP login failed. Use an App Password, "
        "ensure matches, and 2FA is enabled."
    ),
    "البريد المستلم مرفوض من الخادم:": "Recipient email rejected:",
    "فشل إرسال البريد عبر SMTP:": "Failed to send email via SMTP:",
    "إرسال البريد عبر Gmail SMTP (App Password).": "Send email via Gmail SMTP.",
    "عنوان إنجليزي يتفادى مشاكل ترميز بعض السيرفرات": "English subject to avoid encoding issues",
    "Google تعطي App Password غالباً بمسافات بين المجموعات — SMTP يحتاج الـ16 حرف بدون مسافات": (
        "Google App Passwords may have spaces — "
        "SMTP needs 16 chars without spaces"
    ),

    "سياسة البريد: حساب Google حقيقي = Gmail / googlemail أو نطاق Workspace مُعرّف في البيئة.": (
        "Email policy: Valid Google account."
    ),
    "يُرجع (مسموح، رسالة_خطأ_عربية).": "Returns (allowed, error_message).",
    "لا يمكن برمجياً إثبات أن أي Gmail «موجود» بدون OAuth؛ نعتمد على نطاق Google المعروف.": (
        "Cannot programmatically prove Gmail exists "
        "without OAuth."
    ),
    "صيغة البريد غير صالحة.": "Invalid email format.",
    "مسموح فقط بحساب Gmail (@gmail.com أو @googlemail.com) المرتبط بـ Google. ": (
        "Only Google-linked Gmail (@gmail.com) allowed."
    ),
    "بريد وهمي أو عام (مثل yahoo/outlook) غير مقبول لإرسال رمز التحقق. ": "Fake/public emails not accepted. ",
    "لحسابات الشركة على Google Workspace أضف النطاق في GOOGLE_WORKSPACE_ALLOWED_DOMAINS في ملف .env.": (
        "For Workspace, add domain to GOOGLE_WORKSPACE_ALLOWED_DOMAINS in .env."
    ),
    "توحيد تسجيل Gmail (Google يتجاهل حالة الأحرف في العنوان).": (
        "Normalize Gmail."
    )
}

files_to_check = ['index.html', 'message.html', 'app.py', 'email_otp.py', 'google_email.py']

for f in files_to_check:
    if os.path.exists(f):
        with open(f, 'r', encoding='utf-8') as file:
            content = file.read()
        
        for ar, en in replacements.items():
            content = content.replace(ar, en)
            
        with open(f, 'w', encoding='utf-8') as file:
            file.write(content)
print('Done translating.')
