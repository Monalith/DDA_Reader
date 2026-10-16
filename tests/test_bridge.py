"""Tests for the local Claude bridge (dda_lab_bridge.py).

All subprocess / binary lookups are monkeypatched; no real `claude` invocation.
"""
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dda_lab_bridge  # noqa: E402


VALID_RESULT = {
    "track_outline": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]],
    "racing_line": [[0.15, 0.15], [0.85, 0.15]],
    "apexes": [{"turn": 1, "x": 0.5, "y": 0.5, "label": "T1"}],
    "markers": [{"type": "brake", "x": 0.2, "y": 0.3, "text": "hard"}],
    "start_finish": {"x": 0.5, "y": 0.1},
    "turn_labels": [{"n": 1, "x": 0.52, "y": 0.52}],
}


class FakeCompleted:
    def __init__(self, stdout: str, returncode: int = 0, stderr: str = ""):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def claude_json(text: str) -> str:
    return json.dumps({"result": text})


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(dda_lab_bridge, "SCHEMA_DIR", tmp_path / "schemas")
    monkeypatch.setattr(dda_lab_bridge.shutil, "which", lambda name: "/usr/bin/claude")
    return TestClient(dda_lab_bridge.app)


def png_upload(name="schema.png"):
    return {"file": (name, io.BytesIO(b"\x89PNG\r\n\x1a\nfake"), "image/png")}


# --- /health ---------------------------------------------------------------

def test_health_claude_present(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "claude": True}


def test_health_claude_missing(monkeypatch):
    monkeypatch.setattr(dda_lab_bridge.shutil, "which", lambda name: None)
    r = TestClient(dda_lab_bridge.app).get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "claude": False}


# --- /analyze-schema happy path -------------------------------------------

def test_analyze_schema_returns_parsed_dict(client, monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        fenced = "```json\n" + json.dumps(VALID_RESULT) + "\n```"
        return FakeCompleted(claude_json(fenced))

    monkeypatch.setattr(dda_lab_bridge.subprocess, "run", fake_run)

    r = client.post("/analyze-schema", files=png_upload())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["apexes"] == [{"turn": 1, "x": 0.5, "y": 0.5, "label": "T1"}]
    assert body["start_finish"] == {"x": 0.5, "y": 0.1}
    assert body["markers"][0]["type"] == "brake"
    assert len(body["track_outline"]) == 3
    assert len(calls) == 1
    cmd = calls[0][0]
    assert cmd[0] == "claude"
    assert cmd[1] == "-p"
    assert "--output-format" in cmd and "json" in cmd
    assert "--allowedTools" in cmd and "Read" in cmd
    assert calls[0][1]["timeout"] == 180
    assert "Image file:" in cmd[2]


def test_analyze_schema_clamps_coordinates(client, monkeypatch):
    out = json.loads(json.dumps(VALID_RESULT))
    out["apexes"] = [{"turn": 2, "x": 1.7, "y": -0.4, "label": None}]
    out["track_outline"] = [[-1.0, 2.0], [0.5, 0.5]]
    monkeypatch.setattr(
        dda_lab_bridge.subprocess, "run",
        lambda cmd, **kw: FakeCompleted(claude_json(json.dumps(out))),
    )
    body = client.post("/analyze-schema", files=png_upload()).json()
    assert body["apexes"][0]["x"] == 1.0
    assert body["apexes"][0]["y"] == 0.0
    assert body["track_outline"][0] == [0.0, 1.0]


# --- retry path ------------------------------------------------------------

def test_analyze_schema_retries_once_then_succeeds(client, monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if len(calls) == 1:
            return FakeCompleted(claude_json("this is not json at all"))
        return FakeCompleted(claude_json(json.dumps(VALID_RESULT)))

    monkeypatch.setattr(dda_lab_bridge.subprocess, "run", fake_run)

    r = client.post("/analyze-schema", files=png_upload())
    assert r.status_code == 200, r.text
    assert len(calls) == 2
    assert "not valid JSON" in calls[1][2]


def test_analyze_schema_both_garbage_422(client, monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return FakeCompleted(claude_json("nope nope nope"))

    monkeypatch.setattr(dda_lab_bridge.subprocess, "run", fake_run)

    r = client.post("/analyze-schema", files=png_upload())
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_model_output"
    assert r.json()["detail"]
    assert len(calls) == 2


def test_analyze_schema_schema_violation_422(client, monkeypatch):
    bad = {"track_outline": "not-a-list", "racing_line": []}
    monkeypatch.setattr(
        dda_lab_bridge.subprocess, "run",
        lambda cmd, **kw: FakeCompleted(claude_json(json.dumps(bad))),
    )
    r = client.post("/analyze-schema", files=png_upload())
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_model_output"


# --- 503 paths -------------------------------------------------------------

def test_analyze_schema_claude_missing_503(monkeypatch, tmp_path):
    monkeypatch.setattr(dda_lab_bridge, "SCHEMA_DIR", tmp_path / "schemas")
    monkeypatch.setattr(dda_lab_bridge.shutil, "which", lambda name: None)
    c = TestClient(dda_lab_bridge.app)
    r = c.post("/analyze-schema", files=png_upload())
    assert r.status_code == 503
    assert r.json()["error"] == "claude_unavailable"


def test_analyze_schema_nonzero_exit_503(client, monkeypatch):
    monkeypatch.setattr(
        dda_lab_bridge.subprocess, "run",
        lambda cmd, **kw: FakeCompleted("", returncode=2, stderr="boom"),
    )
    r = client.post("/analyze-schema", files=png_upload())
    assert r.status_code == 503
    assert r.json()["error"] == "claude_unavailable"
    assert "boom" in r.json()["detail"]


def test_analyze_schema_timeout_503(client, monkeypatch):
    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, 180)

    monkeypatch.setattr(dda_lab_bridge.subprocess, "run", fake_run)
    r = client.post("/analyze-schema", files=png_upload())
    assert r.status_code == 503
    assert r.json()["error"] == "claude_unavailable"


# --- upload validation -----------------------------------------------------

def test_analyze_schema_unsupported_extension_415(client):
    files = {"file": ("notes.txt", io.BytesIO(b"hello"), "text/plain")}
    r = client.post("/analyze-schema", files=files)
    assert r.status_code == 415


def test_analyze_schema_pdf_without_pypdfium2_415(client, monkeypatch):
    monkeypatch.setattr(dda_lab_bridge, "_render_pdf_first_page", None)
    files = {"file": ("schema.pdf", io.BytesIO(b"%PDF-1.4 fake"), "application/pdf")}
    r = client.post("/analyze-schema", files=files)
    assert r.status_code == 415


def test_uploaded_file_is_saved_under_schema_dir(client, monkeypatch, tmp_path):
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["cwd"] = kwargs.get("cwd")
        seen["prompt"] = cmd[2]
        return FakeCompleted(claude_json(json.dumps(VALID_RESULT)))

    monkeypatch.setattr(dda_lab_bridge.subprocess, "run", fake_run)
    r = client.post("/analyze-schema", files=png_upload())
    assert r.status_code == 200
    schema_dir = dda_lab_bridge.SCHEMA_DIR
    assert schema_dir.is_dir()
    assert str(schema_dir) in str(seen["cwd"])
    img_path = seen["prompt"].split("Image file:")[-1].strip()
    assert Path(img_path).is_absolute()
    assert Path(img_path).exists()


def test_cors_headers_present(client):
    r = client.get("/health", headers={"Origin": "http://localhost:5190"})
    assert r.headers.get("access-control-allow-origin") in ("*", "http://localhost:5190")


def test_prompt_file_exists_and_mentions_json_keys():
    text = dda_lab_bridge.PROMPT_PATH.read_text()
    for key in ("track_outline", "racing_line", "apexes", "markers",
                "start_finish", "turn_labels"):
        assert key in text


# --------------------------------------------------------------------------- #
# Corridor store                                                              #
# --------------------------------------------------------------------------- #

VALID_CORRIDOR = {
    "version": 2,
    "key": "serres-23518-41073",
    "center": [23.518, 41.073],
    "lengthM": 3186.0,
    "leftEdge": [[23.518 + i * 1e-5, 41.073] for i in range(10)],
    "rightEdge": [[23.518 + i * 1e-5, 41.0729] for i in range(10)],
}


@pytest.fixture()
def corridor_client(tmp_path, monkeypatch):
    monkeypatch.setattr(dda_lab_bridge, "CORRIDOR_DIR", tmp_path / "corridors")
    monkeypatch.setattr(dda_lab_bridge, "CORRIDOR_TOKEN", "s3cret")
    return TestClient(dda_lab_bridge.app)


def test_corridor_round_trip(corridor_client):
    r = corridor_client.put(
        "/corridors/serres-23518-41073",
        json=VALID_CORRIDOR,
        headers={"X-Corridor-Token": "s3cret"},
    )
    assert r.status_code == 200, r.text
    got = corridor_client.get("/corridors/serres-23518-41073")
    assert got.status_code == 200
    assert got.json()["leftEdge"] == VALID_CORRIDOR["leftEdge"]


def test_corridor_missing_is_404(corridor_client):
    assert corridor_client.get("/corridors/nothing-here").status_code == 404


def test_corridor_write_needs_the_token(corridor_client):
    r = corridor_client.put("/corridors/serres-23518-41073", json=VALID_CORRIDOR)
    assert r.status_code == 401
    assert corridor_client.get("/corridors/serres-23518-41073").status_code == 404


def test_corridor_write_is_open_when_no_token_is_configured(tmp_path, monkeypatch):
    # a local bridge (no DDA_CORRIDOR_TOKEN) saves corridors without a token;
    # a host that HAS one still requires it (test above)
    monkeypatch.setattr(dda_lab_bridge, "CORRIDOR_DIR", tmp_path / "corridors")
    monkeypatch.setattr(dda_lab_bridge, "CORRIDOR_TOKEN", "")
    client = TestClient(dda_lab_bridge.app)
    r = client.put("/corridors/serres-23518-41073", json=VALID_CORRIDOR)
    assert r.status_code == 200, r.text
    assert client.get("/corridors/serres-23518-41073").status_code == 200


@pytest.mark.parametrize(
    "key",
    ["../etc-passwd", "a/b", "..", "-leading-dash", "UPPER", "x" * 65, "", "a b"],
)
def test_corridor_rejects_keys_outside_the_allowlist(corridor_client, key):
    r = corridor_client.put(
        f"/corridors/{key}", json=VALID_CORRIDOR, headers={"X-Corridor-Token": "s3cret"}
    )
    assert r.status_code in (400, 404, 405), f"{key!r} was not rejected"


def test_corridor_path_traversal_writes_nothing_outside_the_directory(corridor_client, tmp_path):
    corridor_client.put(
        "/corridors/..%2F..%2Fescaped",
        json=VALID_CORRIDOR,
        headers={"X-Corridor-Token": "s3cret"},
    )
    assert not (tmp_path / "escaped.json").exists()
    assert not (tmp_path.parent / "escaped.json").exists()


def test_corridor_rejects_mismatched_array_lengths(corridor_client):
    bad = {**VALID_CORRIDOR, "rightEdge": [[1.0, 1.0]]}
    r = corridor_client.put(
        "/corridors/serres-23518-41073", json=bad, headers={"X-Corridor-Token": "s3cret"}
    )
    assert r.status_code == 422


def test_corridor_rejects_too_many_points(corridor_client):
    # Above CORRIDOR_MAX_POINTS but comfortably under CORRIDOR_MAX_BODY_BYTES,
    # so this exercises the pydantic point-count validator specifically,
    # distinct from the raw body-size cap tested below.
    n = 25_000
    too_many_points = {
        **VALID_CORRIDOR,
        "leftEdge": [[1.0, 1.0]] * n,
        "rightEdge": [[1.0, 1.0]] * n,
    }
    r = corridor_client.put(
        "/corridors/serres-23518-41073", json=too_many_points, headers={"X-Corridor-Token": "s3cret"}
    )
    assert r.status_code == 422


def test_corridor_write_rejects_huge_body_without_token_before_validating(corridor_client):
    # A body this large would fail CorridorPayload validation (it isn't even
    # valid JSON), but with no token the request must never reach the
    # validator at all: 401, not 422, proves the token check runs first.
    huge_body = b"{" + b"x" * (3 * 1024 * 1024) + b"}"
    r = corridor_client.put(
        "/corridors/serres-23518-41073",
        content=huge_body,
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 401
    assert corridor_client.get("/corridors/serres-23518-41073").status_code == 404


def test_corridor_write_rejects_oversized_body_with_a_valid_token(corridor_client):
    huge_body = b"{" + b"x" * (3 * 1024 * 1024) + b"}"
    r = corridor_client.put(
        "/corridors/serres-23518-41073",
        content=huge_body,
        headers={"X-Corridor-Token": "s3cret", "Content-Type": "application/json"},
    )
    assert r.status_code == 413


def test_corridor_get_self_heals_a_corrupted_file(corridor_client):
    corridor_client.put(
        "/corridors/serres-23518-41073",
        json=VALID_CORRIDOR,
        headers={"X-Corridor-Token": "s3cret"},
    )
    path = dda_lab_bridge._corridor_path("serres-23518-41073")
    path.write_text("{not valid json", encoding="utf-8")

    r = corridor_client.get("/corridors/serres-23518-41073")
    assert r.status_code == 404
    assert not path.exists()


# --------------------------------------------------------------------------- #
# OCP job queue (spec v2 §2.10, plan W5 Task 5.1)                             #
# --------------------------------------------------------------------------- #

import time  # noqa: E402

from ocp.job_queue import JobQueue  # noqa: E402

# The worker runs the solver in a child process (so a timeout can really kill
# it and a crash cannot take the bridge down); the fake solver below is
# imported there by "module:function" reference, which is why it lives at
# module level here instead of being a monkeypatched lambda.
FAKE_SOLVER = "test_bridge:fake_ocp_solver"
FIXED_RESULT = {"offsetsM": [0.0] * 10, "vMs": [20.0] * 10, "lapTimeS": 42.0, "iterations": 7}


def fake_ocp_solver(payload, progress=None):
    """Sleeps `machine.sleepS` (default 0.05 s) and returns a fixed result."""
    if progress is not None:
        progress(0.5)
    time.sleep(float(payload["machine"].get("sleepS", 0.05)))
    if payload["machine"].get("fail"):
        raise RuntimeError("solver blew up")
    return FIXED_RESULT


def ocp_body(n=10, key="serres-23518-41073", **machine):
    return {
        "key": key,
        "centerline": [[23.518 + i * 1e-4, 41.073] for i in range(n)],
        "leftM": [4.0] * n,
        "rightM": [4.0] * n,
        "machine": {"powerKw": 147, "massKg": 285, **machine},
        "tyre": {"mu": 1.33, "maxLeanDeg": 58},
    }


def make_queue(tmp_path, **kw):
    opts = dict(solver_ref=FAKE_SOLVER, data_dir=tmp_path / "ocp", ttl_s=3600, timeout_s=30)
    opts.update(kw)
    return JobQueue(**opts)


@pytest.fixture()
def ocp_client(tmp_path, monkeypatch):
    q = make_queue(tmp_path)
    monkeypatch.setattr(dda_lab_bridge, "OCP_QUEUE", q)
    monkeypatch.setattr(dda_lab_bridge, "CORRIDOR_TOKEN", "s3cret")
    yield TestClient(dda_lab_bridge.app)
    q.shutdown()


def post_job(client, body, token="s3cret"):
    headers = {"X-Corridor-Token": token} if token is not None else {}
    return client.post("/ocp/jobs", json=body, headers=headers)


def wait_status(client, job_id, wanted, timeout=20.0):
    t0 = time.monotonic()
    r = None
    while time.monotonic() - t0 < timeout:
        r = client.get(f"/ocp/jobs/{job_id}")
        if r.status_code == 200 and r.json()["status"] in wanted:
            return r.json()
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} never reached {wanted}: {r.status_code} {r.text}")


def test_ocp_post_returns_202_with_an_id(ocp_client):
    r = post_job(ocp_client, ocp_body())
    assert r.status_code == 202, r.text
    assert isinstance(r.json()["id"], str) and len(r.json()["id"]) >= 16


def test_ocp_job_runs_to_done_with_the_result(ocp_client):
    job_id = post_job(ocp_client, ocp_body()).json()["id"]
    first = ocp_client.get(f"/ocp/jobs/{job_id}").json()
    assert first["status"] in ("queued", "running", "done")
    done = wait_status(ocp_client, job_id, {"done"})
    assert done["result"] == FIXED_RESULT
    assert done["key"] == "serres-23518-41073"


def test_ocp_result_is_written_to_disk_and_survives_a_restart(ocp_client, tmp_path, monkeypatch):
    job_id = post_job(ocp_client, ocp_body()).json()["id"]
    wait_status(ocp_client, job_id, {"done"})
    assert (tmp_path / "ocp" / f"{job_id}.json").exists()
    # a fresh queue (bridge restart) still serves the stored result
    q2 = make_queue(tmp_path)
    monkeypatch.setattr(dda_lab_bridge, "OCP_QUEUE", q2)
    try:
        r = ocp_client.get(f"/ocp/jobs/{job_id}")
        assert r.status_code == 200
        assert r.json()["status"] == "done"
        assert r.json()["result"]["lapTimeS"] == 42.0
    finally:
        q2.shutdown()


def test_ocp_second_job_waits_behind_the_first(ocp_client):
    a = post_job(ocp_client, ocp_body(sleepS=1.5)).json()["id"]
    wait_status(ocp_client, a, {"running"})
    b = post_job(ocp_client, ocp_body()).json()["id"]
    assert ocp_client.get(f"/ocp/jobs/{b}").json()["status"] == "queued"
    wait_status(ocp_client, a, {"done"})
    wait_status(ocp_client, b, {"done"})


def test_ocp_unknown_id_is_404(ocp_client):
    assert ocp_client.get("/ocp/jobs/0123456789abcdef0123456789abcdef").status_code == 404
    # ids are a path component too: anything off the allowlist is 404, not a file read
    assert ocp_client.get("/ocp/jobs/..%2F..%2Fetc").status_code == 404


def test_ocp_rejects_mismatched_array_lengths(ocp_client):
    body = ocp_body()
    body["rightM"] = body["rightM"][:-1]
    assert post_job(ocp_client, body).status_code == 422


def test_ocp_rejects_too_many_points(ocp_client):
    assert post_job(ocp_client, ocp_body(n=20_001)).status_code == 422


@pytest.mark.parametrize("key", ["../etc", "UPPER", "-lead", "", "x" * 65, "a b"])
def test_ocp_rejects_keys_outside_the_allowlist(ocp_client, key):
    assert post_job(ocp_client, ocp_body(key=key)).status_code == 422


def test_ocp_post_needs_no_token(ocp_client, monkeypatch):
    # the solver only runs in a user's local bridge (owner decision 2026-10-11):
    # no token, even when the host has none configured
    monkeypatch.setattr(dda_lab_bridge, "CORRIDOR_TOKEN", "")
    assert post_job(ocp_client, ocp_body(), token=None).status_code == 202


def test_ocp_huge_body_without_token_is_413_not_parsed(ocp_client):
    r = ocp_client.post(
        "/ocp/jobs",
        content=b"x" * (dda_lab_bridge.OCP_MAX_BODY_BYTES + 1),
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 413


def test_ocp_oversized_body_with_token_is_413(ocp_client):
    huge = b"{" + b"x" * (5 * 1024 * 1024) + b"}"
    r = ocp_client.post(
        "/ocp/jobs",
        content=huge,
        headers={"Content-Type": "application/json", "X-Corridor-Token": "s3cret"},
    )
    assert r.status_code == 413


def test_ocp_get_is_public(ocp_client):
    job_id = post_job(ocp_client, ocp_body()).json()["id"]
    # no token header on the GET
    assert ocp_client.get(f"/ocp/jobs/{job_id}").status_code == 200


def test_ocp_old_jobs_are_purged(tmp_path, monkeypatch):
    q = make_queue(tmp_path, ttl_s=0.3)
    monkeypatch.setattr(dda_lab_bridge, "OCP_QUEUE", q)
    monkeypatch.setattr(dda_lab_bridge, "CORRIDOR_TOKEN", "s3cret")
    client = TestClient(dda_lab_bridge.app)
    try:
        job_id = post_job(client, ocp_body()).json()["id"]
        wait_status(client, job_id, {"done"})
        time.sleep(0.5)
        assert client.get(f"/ocp/jobs/{job_id}").status_code == 404
        assert not (tmp_path / "ocp" / f"{job_id}.json").exists()
    finally:
        q.shutdown()


def test_ocp_timeout_kills_a_long_job(tmp_path, monkeypatch):
    q = make_queue(tmp_path, timeout_s=0.5)
    monkeypatch.setattr(dda_lab_bridge, "OCP_QUEUE", q)
    monkeypatch.setattr(dda_lab_bridge, "CORRIDOR_TOKEN", "s3cret")
    client = TestClient(dda_lab_bridge.app)
    try:
        slow = post_job(client, ocp_body(sleepS=60)).json()["id"]
        t0 = time.monotonic()
        err = wait_status(client, slow, {"error", "done"}, timeout=15)
        assert err["status"] == "error"
        assert "timeout" in err["message"].lower()
        assert time.monotonic() - t0 < 10
        # the worker is free again: the next job completes
        nxt = post_job(client, ocp_body()).json()["id"]
        assert wait_status(client, nxt, {"done", "error"})["status"] == "done"
    finally:
        q.shutdown()


def test_ocp_solver_exception_becomes_error(ocp_client):
    job_id = post_job(ocp_client, ocp_body(fail=True)).json()["id"]
    err = wait_status(ocp_client, job_id, {"error", "done"})
    assert err["status"] == "error"
    assert "blew up" in err["message"]


def test_ocp_queue_is_bounded(tmp_path, monkeypatch):
    q = make_queue(tmp_path, max_pending=2)
    monkeypatch.setattr(dda_lab_bridge, "OCP_QUEUE", q)
    monkeypatch.setattr(dda_lab_bridge, "CORRIDOR_TOKEN", "s3cret")
    client = TestClient(dda_lab_bridge.app)
    try:
        codes = [post_job(client, ocp_body(sleepS=2)).status_code for _ in range(4)]
        assert codes[:2] == [202, 202]
        assert 429 in codes[2:]
    finally:
        q.shutdown()


def test_ocp_host_without_the_ocp_package_answers_503(monkeypatch):
    # deploy_lab.sh without --with-ocp: the bridge must still start and serve
    monkeypatch.setattr(dda_lab_bridge, "JobQueue", None)
    monkeypatch.setattr(dda_lab_bridge, "OCP_QUEUE", None)
    monkeypatch.setattr(dda_lab_bridge, "CORRIDOR_TOKEN", "s3cret")
    client = TestClient(dda_lab_bridge.app)
    assert post_job(client, ocp_body()).status_code == 503
    assert client.get("/ocp/jobs/0123456789abcdef0123456789abcdef").status_code == 503
    assert client.get("/health").status_code == 200


def test_ocp_default_timeout_is_fifteen_minutes():
    assert dda_lab_bridge.OCP_TIMEOUT_S == 900


# --- /api/stats (usage statistics) ------------------------------------------

from bridge import auth as _stats_auth, db as _stats_db, stats as _stats  # noqa: E402

_ADMIN = _stats_auth.User(id="u-admin", email="admin@example.com", name="Admin", role="admin")
_PLAIN = _stats_auth.User(id="u-1", email="rider@example.com", name="Rider", role="user")


@pytest.fixture()
def stats_client(monkeypatch, tmp_path):
    monkeypatch.setattr(_stats_db, "_db_path", tmp_path / "stats.db")
    _stats.reset_rate_limit()
    who = {"user": None}
    monkeypatch.setattr(_stats_auth, "current_user", lambda request: who["user"])
    c = TestClient(dda_lab_bridge.app)
    c.who = who  # type: ignore[attr-defined]
    yield c
    _stats.reset_rate_limit()


def _post(c, events, anon="anon-1", **kw):
    return c.post("/api/stats/events", json={"anonId": anon, "events": events}, **kw)


def test_stats_events_are_stored_with_session_key(stats_client):
    r = _post(stats_client, [{"event": "app_open", "props": {"viewport": "1600x1000"}}, {"event": "lap_select"}])
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "stored": 2}
    with _stats_db.connect() as con:
        rows = con.execute("SELECT * FROM usage_events ORDER BY id").fetchall()
    assert [r["event"] for r in rows] == ["app_open", "lap_select"]
    assert rows[0]["anon_id"] == "anon-1" and rows[0]["user_id"] is None
    assert rows[0]["session_key"] and rows[0]["session_key"] == rows[1]["session_key"]
    assert json.loads(rows[0]["props"]) == {"viewport": "1600x1000"}


def test_stats_events_attach_the_signed_in_user(stats_client):
    stats_client.who["user"] = _PLAIN
    assert _post(stats_client, [{"event": "file_open", "props": {"ext": "dda"}}]).json()["stored"] == 1
    with _stats_db.connect() as con:
        assert con.execute("SELECT user_id FROM usage_events").fetchone()[0] == "u-1"


def test_stats_events_accept_text_plain_beacons(stats_client):
    body = json.dumps({"anonId": "a", "events": [{"event": "app_open"}]})
    r = stats_client.post("/api/stats/events", content=body, headers={"content-type": "text/plain;charset=UTF-8"})
    assert r.status_code == 200 and r.json()["stored"] == 1


def test_stats_events_batch_is_capped_and_bad_rows_dropped(stats_client):
    evs = [{"event": "lap_select"} for _ in range(80)]
    assert _post(stats_client, evs).json()["stored"] == 50
    bad = [{"event": "has space"}, {"event": "ok", "props": {"x": "y" * 3000}}]
    assert _post(stats_client, bad).json()["stored"] == 1
    with _stats_db.connect() as con:
        assert con.execute("SELECT props FROM usage_events WHERE event='ok'").fetchone()[0] is None


def test_stats_events_reject_malformed_bodies(stats_client):
    assert stats_client.post("/api/stats/events", content=b"nope").status_code == 400
    assert _post(stats_client, [{"event": "x"}], anon="a" * 65).status_code == 400
    assert _post(stats_client, [{"event": "x" * 65}]).status_code == 400


def test_stats_events_rate_limited_per_anon_id(stats_client):
    total = 0
    for _ in range(14):
        total += _post(stats_client, [{"event": "lap_select"}] * 50).json()["stored"]
    assert total == _stats.RATE_LIMIT_EVENTS
    assert _post(stats_client, [{"event": "lap_select"}], anon="other").json()["stored"] == 1


def test_stats_events_storage_failure_still_answers_200(stats_client, monkeypatch):
    def boom():
        raise RuntimeError("disk gone")

    monkeypatch.setattr(_stats_db, "connect", boom)
    r = _post(stats_client, [{"event": "app_open"}])
    assert r.status_code == 200 and r.json() == {"ok": True, "stored": 0}


def test_stats_summary_needs_admin(stats_client):
    assert stats_client.get("/api/stats/summary").status_code == 401
    stats_client.who["user"] = _PLAIN
    assert stats_client.get("/api/stats/summary").status_code == 403


def test_stats_summary_shape_with_seeded_db(stats_client):
    with _stats_db.connect() as con:
        con.execute("INSERT INTO users(id, email, name, provider) VALUES ('u-1','rider@example.com','Rider','google')")
    stats_client.who["user"] = _PLAIN
    _post(stats_client, [
        {"event": "app_open"},
        {"event": "file_open", "props": {"ext": "dda", "laps": 12}},
        {"event": "file_open", "props": {"ext": "dda", "laps": 3}},
        {"event": "file_open", "props": {"ext": "csv", "laps": 1}},
    ], anon="anon-signed")
    stats_client.who["user"] = None
    _post(stats_client, [{"event": "app_open"}, {"event": "example_open", "props": {"name": "Serres"}}], anon="anon-x")
    _post(stats_client, [{"event": "sim_enable"}], anon="anon-y")

    stats_client.who["user"] = _ADMIN
    r = stats_client.get("/api/stats/summary?days=7")
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["totals"] == {"events": 7, "sessions": 3, "users": 1, "anonymous": 2}
    assert len(s["series"]) == 7 and s["series"][-1]["events"] == 7
    assert set(s["series"][0]) == {"day", "sessions", "events", "users"}
    assert s["topEvents"][0] == {"event": "file_open", "count": 3}
    assert s["files"] == [{"ext": "dda", "count": 2}, {"ext": "csv", "count": 1}]
    assert s["examples"] == [{"name": "Serres", "count": 1}]
    assert s["features"]["file_open"] == 3 and s["features"]["sim_enable"] == 1 and s["features"]["export"] == 0
    assert [u["email"] for u in s["users"]] == ["rider@example.com"]
    assert s["users"][0]["events"] == 4 and s["users"][0]["name"] == "Rider"


def test_stats_summary_days_is_bounded(stats_client):
    stats_client.who["user"] = _ADMIN
    assert stats_client.get("/api/stats/summary?days=0").status_code == 422
    assert len(stats_client.get("/api/stats/summary?days=90").json()["series"]) == 90


# --------------------------------------------------------------------------- #
# auth (bridge/auth.py)                                                       #
# --------------------------------------------------------------------------- #

from bridge import auth as bridge_auth, db as bridge_db  # noqa: E402

SECRET = "s" * 40


@pytest.fixture()
def auth_off(monkeypatch, tmp_path):
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.setattr(bridge_db, "_db_path", tmp_path / "auth.db")
    return TestClient(dda_lab_bridge.app)


@pytest.fixture()
def auth_on(monkeypatch, tmp_path):
    monkeypatch.setattr(bridge_db, "_db_path", None)
    bridge_db.configure(tmp_path / "auth.db")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "csecret")
    monkeypatch.setenv("SESSION_SECRET", SECRET)
    monkeypatch.setenv("APP_URL", "http://testserver")
    monkeypatch.setenv("ADMIN_EMAILS", "Boss@Example.com, other@example.com")
    monkeypatch.setenv("RESEND_API_KEY", "re_test")
    bridge_auth.rate_limiter.reset()
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(bridge_auth, "send_otp_email", lambda email, code: sent.append((email, code)))
    c = TestClient(dda_lab_bridge.app)
    c.sent = sent  # type: ignore[attr-defined]
    return c


def _otp_login(c, email):
    assert c.post("/api/auth/send-otp", json={"email": email}).status_code == 200
    code = c.sent[-1][1]
    return c.post("/api/auth/verify-otp", json={"email": email, "code": code})


def test_auth_disabled_me_is_local_admin(auth_off):
    j = auth_off.get("/api/auth/me").json()
    assert j["authEnabled"] is False
    assert j["user"]["id"] == "local" and j["user"]["role"] == "admin"


def test_auth_disabled_login_redirects_to_lab(auth_off):
    r = auth_off.get("/login", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/lab/"


def test_auth_enabled_me_has_no_user(auth_on):
    j = auth_on.get("/api/auth/me").json()
    assert j == {"user": None, "authEnabled": True}


@pytest.mark.parametrize("path", ["/lab/", "/lab/index.html", "/lab"])
def test_auth_enabled_lab_redirects_to_login(auth_on, path):
    r = auth_on.get(path, follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"].startswith("/login?redirect=")


def test_lab_gate_keeps_example_query(auth_on):
    r = auth_on.get("/lab/?example=serres", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/login?redirect=%2Flab%2F%3Fexample%3Dserres"


def test_health_and_api_stay_open_when_auth_enabled(auth_on):
    assert auth_on.get("/health").status_code == 200
    assert auth_on.get("/api/auth/me").status_code == 200


def test_login_page_serves_html(auth_on):
    for path in ("/login", "/login/"):
        r = auth_on.get(path + "?error=state")
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
        assert "MotoRace" in r.text and "Continue with Google" in r.text
        assert "never leave your browser" in r.text
        assert "expired" in r.text  # the error message is rendered


def test_login_page_escapes_unknown_errors(auth_on):
    r = auth_on.get("/login?error=<script>")
    assert "<script>alert" not in r.text and "Sign-in failed" in r.text


def test_google_start_sets_state_cookie_and_redirects(auth_on):
    r = auth_on.get("/api/auth/google?redirect=/lab/?example=x", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "client_id=cid.apps.googleusercontent.com" in loc
    assert "redirect_uri=http%3A%2F%2Ftestserver%2Fapi%2Fauth%2Fgoogle%2Fcallback" in loc
    assert "scope=openid+email+profile" in loc
    set_cookie = r.headers["set-cookie"]
    assert "oauth_state=" in set_cookie and "HttpOnly" in set_cookie and "Max-Age=600" in set_cookie


def test_google_callback_bad_state(auth_on):
    auth_on.get("/api/auth/google", follow_redirects=False)
    r = auth_on.get("/api/auth/google/callback?code=abc&state=wrong", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "http://testserver/login?error=state"


def test_google_callback_without_cookie(auth_on):
    r = auth_on.get("/api/auth/google/callback?code=abc&state=x", follow_redirects=False)
    assert r.headers["location"].endswith("/login?error=state")


def test_google_callback_success(auth_on, monkeypatch):
    from urllib.parse import parse_qs, urlparse

    monkeypatch.setattr(bridge_auth, "_google_exchange", lambda code, cb: {
        "email": "rider@gmail.com", "email_verified": True, "name": "Rider", "picture": "https://x/p.png"})
    r = auth_on.get("/api/auth/google?redirect=/lab/?example=serres", follow_redirects=False)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    r = auth_on.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "http://testserver/lab/?example=serres"
    u = auth_on.get("/api/auth/me").json()["user"]
    assert u["email"] == "rider@gmail.com" and u["name"] == "Rider" and u["role"] == "user"
    assert u["avatar_url"] == "https://x/p.png"


@pytest.mark.parametrize("bad", ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)"])
def test_redirect_must_be_same_origin(bad):
    assert bridge_auth.safe_redirect(bad) == "/lab/"


def test_otp_round_trip_admin_and_logout(auth_on):
    r = _otp_login(auth_on, "boss@example.com")
    assert r.status_code == 200
    assert "session=" in r.headers["set-cookie"] and "HttpOnly" in r.headers["set-cookie"]
    u = auth_on.get("/api/auth/me").json()["user"]
    assert u["email"] == "boss@example.com" and u["role"] == "admin"
    assert auth_on.get("/lab/", follow_redirects=False).status_code != 302
    assert auth_on.get("/login", follow_redirects=False).status_code == 302  # already signed in
    assert auth_on.post("/api/auth/logout").status_code == 200
    assert auth_on.get("/api/auth/me").json()["user"] is None


def test_logout_revokes_the_session_server_side(auth_on):
    _otp_login(auth_on, "a@example.com")
    stolen = auth_on.cookies.get("session")
    auth_on.post("/api/auth/logout")
    auth_on.cookies.set("session", stolen)
    assert auth_on.get("/api/auth/me").json()["user"] is None


def test_otp_non_admin_role(auth_on):
    _otp_login(auth_on, "Someone@Example.com")
    u = auth_on.get("/api/auth/me").json()["user"]
    assert u["email"] == "someone@example.com" and u["role"] == "user"


def test_otp_wrong_code_and_attempt_limit(auth_on):
    auth_on.post("/api/auth/send-otp", json={"email": "x@example.com"})
    good = auth_on.sent[-1][1]
    wrong = "000000" if good != "000000" else "111111"
    for _ in range(5):
        assert auth_on.post("/api/auth/verify-otp", json={"email": "x@example.com", "code": wrong}).status_code == 401
    r = auth_on.post("/api/auth/verify-otp", json={"email": "x@example.com", "code": good})
    assert r.status_code == 429


def test_otp_code_is_single_use(auth_on):
    auth_on.post("/api/auth/send-otp", json={"email": "y@example.com"})
    code = auth_on.sent[-1][1]
    assert auth_on.post("/api/auth/verify-otp", json={"email": "y@example.com", "code": code}).status_code == 200
    assert auth_on.post("/api/auth/verify-otp", json={"email": "y@example.com", "code": code}).status_code == 401


def test_otp_is_stored_hashed(auth_on):
    auth_on.post("/api/auth/send-otp", json={"email": "h@example.com"})
    code = auth_on.sent[-1][1]
    with bridge_db.connect() as con:
        row = con.execute("SELECT code_hash FROM otp_codes WHERE email = 'h@example.com'").fetchone()
    assert row["code_hash"] != code and len(row["code_hash"]) == 64


def test_send_otp_rate_limited(auth_on):
    for _ in range(3):
        assert auth_on.post("/api/auth/send-otp", json={"email": "r@example.com"}).status_code == 200
    assert auth_on.post("/api/auth/send-otp", json={"email": "r@example.com"}).status_code == 429


def test_send_otp_rejects_bad_email(auth_on):
    assert auth_on.post("/api/auth/send-otp", json={"email": "nope"}).status_code == 400


def test_send_otp_without_resend_key_is_503(auth_on, monkeypatch):
    monkeypatch.delenv("RESEND_API_KEY")
    r = auth_on.post("/api/auth/send-otp", json={"email": "z@example.com"})
    assert r.status_code == 503 and "RESEND_API_KEY" in r.json()["detail"]


def test_forged_session_cookie_is_ignored(auth_on):
    auth_on.cookies.set("session", "garbage.value.sig")
    assert auth_on.get("/api/auth/me").json()["user"] is None


def test_require_admin_dependency(auth_on):
    from fastapi import Depends, FastAPI

    mini = FastAPI()

    @mini.get("/x")
    def x(u=Depends(bridge_auth.require_admin)):
        return {"ok": u.email}

    mini.include_router(bridge_auth.router)
    c = TestClient(mini)
    c.sent = auth_on.sent  # type: ignore[attr-defined]
    assert c.get("/x").status_code == 401
    _otp_login(c, "plain@example.com")
    assert c.get("/x").status_code == 403
    c.post("/api/auth/logout")
    c.cookies.clear()
    _otp_login(c, "other@example.com")
    assert c.get("/x").json() == {"ok": "other@example.com"}
