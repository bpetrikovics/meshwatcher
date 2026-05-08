import logging
import os
import tempfile

import pytest
import yaml


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_yaml(tmp_path, data):
    p = tmp_path / "api_keys.yaml"
    p.write_text(yaml.dump(data))
    return str(p)


# ---------------------------------------------------------------------------
# load_api_keys
# ---------------------------------------------------------------------------

def test_load_valid_keys(tmp_path, monkeypatch):
    path = _write_yaml(tmp_path, [
        {"key": "secret1", "name": "Client A"},
        {"key": "secret2", "name": "Client B"},
    ])
    monkeypatch.setenv("API_KEYS_FILE", path)

    from app import api_keys
    api_keys.load_api_keys()

    assert api_keys.validate_key("secret1") == "Client A"
    assert api_keys.validate_key("secret2") == "Client B"


def test_missing_env_var_logs_warning(monkeypatch, caplog):
    monkeypatch.delenv("API_KEYS_FILE", raising=False)

    from app import api_keys
    with caplog.at_level(logging.WARNING, logger="app.api_keys"):
        api_keys.load_api_keys()

    assert api_keys.validate_key("anything") is None
    assert any("API_KEYS_FILE" in m for m in caplog.messages)


def test_file_not_found_logs_warning(monkeypatch, caplog):
    monkeypatch.setenv("API_KEYS_FILE", "/nonexistent/path/api_keys.yaml")

    from app import api_keys
    with caplog.at_level(logging.WARNING, logger="app.api_keys"):
        api_keys.load_api_keys()

    assert api_keys.validate_key("anything") is None
    assert any("not found" in m for m in caplog.messages)


def test_malformed_yaml_logs_warning(tmp_path, monkeypatch, caplog):
    p = tmp_path / "bad.yaml"
    p.write_text(": invalid: yaml: {{{{")
    monkeypatch.setenv("API_KEYS_FILE", str(p))

    from app import api_keys
    with caplog.at_level(logging.WARNING, logger="app.api_keys"):
        api_keys.load_api_keys()

    assert api_keys.validate_key("anything") is None
    assert any("parse" in m.lower() or "failed" in m.lower() for m in caplog.messages)


def test_yaml_not_a_list_logs_warning(tmp_path, monkeypatch, caplog):
    p = tmp_path / "bad.yaml"
    p.write_text(yaml.dump({"key": "foo", "name": "bar"}))
    monkeypatch.setenv("API_KEYS_FILE", str(p))

    from app import api_keys
    with caplog.at_level(logging.WARNING, logger="app.api_keys"):
        api_keys.load_api_keys()

    assert api_keys.validate_key("foo") is None


def test_skip_invalid_entries_logs_warning(tmp_path, monkeypatch, caplog):
    path = _write_yaml(tmp_path, [
        {"key": "valid", "name": "Good Client"},
        {"key": "missing_name"},
        {"name": "missing_key"},
        "not_a_dict",
    ])
    monkeypatch.setenv("API_KEYS_FILE", path)

    from app import api_keys
    with caplog.at_level(logging.WARNING, logger="app.api_keys"):
        api_keys.load_api_keys()

    assert api_keys.validate_key("valid") == "Good Client"
    assert api_keys.validate_key("missing_name") is None


# ---------------------------------------------------------------------------
# validate_key
# ---------------------------------------------------------------------------

def test_validate_key_returns_none_for_invalid(tmp_path, monkeypatch):
    path = _write_yaml(tmp_path, [{"key": "realkey", "name": "Me"}])
    monkeypatch.setenv("API_KEYS_FILE", path)

    from app import api_keys
    api_keys.load_api_keys()

    assert api_keys.validate_key("wrongkey") is None
    assert api_keys.validate_key("") is None


def test_validate_key_returns_name_for_valid(tmp_path, monkeypatch):
    path = _write_yaml(tmp_path, [{"key": "mytoken", "name": "Automation"}])
    monkeypatch.setenv("API_KEYS_FILE", path)

    from app import api_keys
    api_keys.load_api_keys()

    assert api_keys.validate_key("mytoken") == "Automation"


# ---------------------------------------------------------------------------
# is_origin_allowed
# ---------------------------------------------------------------------------

def test_is_origin_allowed_wildcard(monkeypatch):
    # Re-import after patching parsed property via monkeypatching the raw attribute
    from app import api_keys
    from app.config import settings
    monkeypatch.setattr(settings, "cors_allowed_origins", "*")

    assert api_keys.is_origin_allowed("http://anything.example.com") is True
    assert api_keys.is_origin_allowed(None) is False


def test_is_origin_allowed_list(monkeypatch):
    from app import api_keys
    from app.config import settings
    monkeypatch.setattr(settings, "cors_allowed_origins", "http://trusted.example.com,http://other.example.com")

    assert api_keys.is_origin_allowed("http://trusted.example.com") is True
    assert api_keys.is_origin_allowed("http://untrusted.example.com") is False
    assert api_keys.is_origin_allowed(None) is False
