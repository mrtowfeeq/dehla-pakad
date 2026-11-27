"""Production-safety settings: CORS never defaults to "everyone", and API docs are off for live."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_medals import _import_server  # noqa: E402

server = _import_server()


def test_cors_is_closed_when_unset_and_never_combines_a_wildcard_with_credentials():
    assert server.cors_settings("") == {"allow_origins": [], "allow_credentials": True}
    assert server.cors_settings(" https://dehlapakad.tech/ , http://localhost:3000") == {
        "allow_origins": ["https://dehlapakad.tech", "http://localhost:3000"], "allow_credentials": True}
    assert server.cors_settings("*") == {"allow_origins": ["*"], "allow_credentials": False}


def test_api_docs_are_off_for_live_and_on_for_preview_unless_overridden():
    assert server.api_docs_enabled("live", "") is False
    assert server.api_docs_enabled("preview", "") is True
    assert server.api_docs_enabled("live", "true") is True
    assert server.api_docs_enabled("preview", "false") is False
