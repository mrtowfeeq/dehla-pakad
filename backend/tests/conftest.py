"""Make every test run import the backend exactly the way production does, whatever the working directory.

The backend modules import each other with ``try: from backend.X import ... / except ModuleNotFoundError:
from X import ...``. Production runs Uvicorn from ``backend/`` (``server:app``), so only the flat names
(``wallet``, ``session_guard``, ...) exist. Started from the repository root, ``python -m pytest`` puts the
root on ``sys.path``; ``backend`` then imports as a namespace package and ``server`` loads
``backend.wallet`` while the tests load ``wallet``: two copies of every module, so for example
``except InsufficientCoins`` in the server never matches the exception a test's ``Wallet`` raises.

Blocking the ``backend`` package name (``None`` in ``sys.modules`` makes ``import backend.X`` raise
ModuleNotFoundError) and putting ``backend/`` first on the path gives one copy of each module, the
production layout, from any directory.
"""
import sys
from pathlib import Path

BACKEND = str(Path(__file__).resolve().parents[1])
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)
sys.modules["backend"] = None
