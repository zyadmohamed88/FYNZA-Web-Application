"""يُستورد أولاً من app.py لتحميل .env قبل أي كود يعتمد على المتغيرات."""
from pathlib import Path
import os


def load_dotenv():
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip("'\"")
        if not key:
            continue
        if val:
            os.environ[key] = val
        elif key not in os.environ:
            os.environ[key] = val


load_dotenv()
