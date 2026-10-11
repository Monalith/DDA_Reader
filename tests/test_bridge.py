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
