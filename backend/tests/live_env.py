"""Settings for the live end-to-end suites (a running backend plus the Clerk test instance).

These suites create or sign in real Clerk test users and write to whatever database the target backend
uses, so they only run when explicitly enabled:

    RUN_LIVE_TESTS=1     required; otherwise every live suite is skipped
    E2E_BASE             backend URL to test, e.g. http://127.0.0.1:8000 (takes precedence)
    BACKEND_ENV_FILE     backend env file holding CLERK_SECRET_KEY (default: backend/.env)
    FRONTEND_ENV_FILE    frontend env file holding REACT_APP_BACKEND_URL, used when E2E_BASE is unset
                         (default: frontend/.env, then frontend/.env.development)

Values already set in the process environment are never overridden by an env file.
"""
import os
from pathlib import Path

import pytest
from dotenv import dotenv_values, load_dotenv

TESTS_DIR = Path(__file__).resolve().parent
BACKEND_DIR = TESTS_DIR.parent
FRONTEND_DIR = BACKEND_DIR.parent / "frontend"


def require_live_opt_in():
    """Skip the calling test module unless live suites were explicitly enabled."""
    if os.environ.get("RUN_LIVE_TESTS") != "1":
        pytest.skip("live suite: set RUN_LIVE_TESTS=1 to run against a backend and the Clerk test instance",
                    allow_module_level=True)


def backend_env_file():
    return Path(os.environ.get("BACKEND_ENV_FILE") or BACKEND_DIR / ".env")


def frontend_env_file():
    explicit = os.environ.get("FRONTEND_ENV_FILE")
    if explicit:
        return Path(explicit)
    for name in (".env", ".env.development"):
        candidate = FRONTEND_DIR / name
        if candidate.exists():
            return candidate
    return FRONTEND_DIR / ".env"


def load_backend_env():
    """Load CLERK_SECRET_KEY and friends from the backend env file without overriding the environment."""
    load_dotenv(backend_env_file(), override=False)
    if not os.environ.get("CLERK_SECRET_KEY"):
        raise RuntimeError(f"CLERK_SECRET_KEY is not set and was not found in {backend_env_file()}")


def backend_url():
    url = os.environ.get("E2E_BASE") or dotenv_values(frontend_env_file()).get("REACT_APP_BACKEND_URL")
    if not url:
        raise RuntimeError(f"Set E2E_BASE or REACT_APP_BACKEND_URL in {frontend_env_file()}")
    return url.rstrip("/")


def websocket_url(base):
    """http -> ws and https -> wss."""
    return base.replace("http", "ws", 1) + "/api/ws"


def configure():
    """Opt-in check, env loading and E2E_BASE setup; call before importing e2e_match."""
    require_live_opt_in()
    load_backend_env()
    base = backend_url()
    os.environ["E2E_BASE"] = base
    return base
