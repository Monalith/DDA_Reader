"""Single-worker background queue for OCP jobs (spec v2 §2.10, plan W5 Task 5.1).

Design
    * ONE worker thread drains a ``queue.Queue``; jobs never run concurrently, which
      is what the 512 MB droplet can afford (one IPOPT solve at a time).
    * Each job runs in a **spawned child process**: a timeout can really kill it
      (a thread cannot be killed), an IPOPT/MUMPS crash cannot take the bridge
      down, and CasADi is never imported into the long-lived bridge process, so
      its ~100 MB of shared libraries are released after every solve.
    * The solver is named by a ``"module:function"`` reference and imported in the
      child. Signature: ``fn(payload: dict, progress: Callable[[float], None]) -> dict``.
    * State lives in memory; finished jobs are also written atomically to
      ``data_dir/<id>.json`` so a result survives a bridge restart. Finished jobs
      older than ``ttl_s`` are purged from both.

This module must not import CasADi or numpy.
"""
from __future__ import annotations

import importlib
import inspect
import json
import multiprocessing as mp
import os
import queue
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")

QUEUED, RUNNING, DONE, ERROR = "queued", "running", "done", "error"


def _child_main(solver_ref: str, payload: dict, conn, timeout_s: float) -> None:  # pragma: no cover - runs in the child
    """Child-process entry: import the solver, run it, report over the pipe."""
    try:
        mod_name, fn_name = solver_ref.split(":", 1)
        fn = getattr(importlib.import_module(mod_name), fn_name)

        def progress(frac: float) -> None:
            try:
                conn.send(("progress", float(frac)))
            except Exception:
                pass

        # the wall-time budget is passed on only to solvers that take it (test
        # fakes do not); the parent enforces the deadline either way
        if "timeout_s" in inspect.signature(fn).parameters:
            result = fn(payload, progress=progress, timeout_s=timeout_s)
        else:
            result = fn(payload, progress=progress)
        conn.send(("done", result))
    except BaseException as exc:  # noqa: BLE001 - everything goes back to the parent
        try:
            conn.send(("error", f"{type(exc).__name__}: {exc}"[:500]))
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".json.tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


class QueueFull(RuntimeError):
    """Too many jobs are already waiting."""


class JobQueue:
    def __init__(
        self,
        solver_ref: str,
        data_dir: Path,
        ttl_s: float = 7 * 24 * 3600,
        timeout_s: float = 900,
        max_pending: int = 8,
    ) -> None:
        self.solver_ref = solver_ref
        self.data_dir = Path(data_dir)
        self.ttl_s = float(ttl_s)
        self.timeout_s = float(timeout_s)
        self.max_pending = int(max_pending)
        self._jobs: dict[str, dict[str, Any]] = {}
        self._payloads: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._q: "queue.Queue[Optional[str]]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._proc: Optional[mp.process.BaseProcess] = None
        self._ctx = mp.get_context("spawn")

    # ------------------------------------------------------------------ API --

    def submit(self, payload: dict) -> str:
        self.purge()
        with self._lock:
            pending = sum(1 for j in self._jobs.values() if j["status"] in (QUEUED, RUNNING))
            if pending >= self.max_pending:
                raise QueueFull(f"{pending} jobs pending")
            job_id = uuid.uuid4().hex
            self._jobs[job_id] = {
                "id": job_id,
                "key": payload.get("key"),
                "status": QUEUED,
                "progress": 0.0,
                "createdAt": time.time(),
            }
            self._payloads[job_id] = payload
            self._ensure_worker()
        self._q.put(job_id)
        return job_id

    def get(self, job_id: str) -> Optional[dict]:
        if not JOB_ID_RE.match(job_id or ""):
            return None
        self.purge()
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                return dict(job)
        path = self.data_dir / f"{job_id}.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError, UnicodeDecodeError):
            path.unlink(missing_ok=True)
            return None
        return data if isinstance(data, dict) else None

    def purge(self) -> None:
        now = time.time()
        cutoff = now - self.ttl_s
        with self._lock:
            for job_id in [
                k for k, j in self._jobs.items()
                if j["status"] in (DONE, ERROR) and j.get("finishedAt", now) < cutoff
            ]:
                del self._jobs[job_id]
        if self.data_dir.is_dir():
            for p in self.data_dir.glob("*.json"):
                try:
                    if p.stat().st_mtime < cutoff:
                        p.unlink(missing_ok=True)
                except OSError:
                    pass

    def shutdown(self, wait: float = 5.0) -> None:
        self._stop.set()
        proc = self._proc
        if proc is not None and proc.is_alive():
            proc.kill()
        self._q.put(None)
        if self._thread is not None:
            self._thread.join(wait)

    # -------------------------------------------------------------- worker --

    def _ensure_worker(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._worker, name="ocp-worker", daemon=True)
            self._thread.start()

    def _update(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                job.update(fields)

    def _finish(self, job_id: str, **fields: Any) -> None:
        fields["finishedAt"] = time.time()
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.update(fields)
            snapshot = dict(job)
            self._payloads.pop(job_id, None)
        try:
            _atomic_write_json(self.data_dir / f"{job_id}.json", snapshot)
        except OSError:
            pass  # the in-memory copy still serves it until the bridge restarts

    def _worker(self) -> None:
        while not self._stop.is_set():
            job_id = self._q.get()
            if job_id is None:
                break
            with self._lock:
                payload = self._payloads.get(job_id)
            if payload is None:
                continue
            self._run(job_id, payload)

    def _run(self, job_id: str, payload: dict) -> None:
        self._update(job_id, status=RUNNING, startedAt=time.time())
        parent, child = self._ctx.Pipe(duplex=False)
        proc = self._ctx.Process(
            target=_child_main,
            args=(self.solver_ref, payload, child, self.timeout_s),
            daemon=True,
        )
        self._proc = proc
        proc.start()
        child.close()
        deadline = time.monotonic() + self.timeout_s
        outcome: Optional[tuple] = None
        try:
            while outcome is None:
                if self._stop.is_set():
                    outcome = ("error", "bridge shutting down")
                    break
                if time.monotonic() > deadline:
                    outcome = ("error", f"timeout after {self.timeout_s:g} s")
                    break
                try:
                    ready = parent.poll(0.1)
                except (OSError, EOFError):
                    ready = False
                if ready:
                    try:
                        msg = parent.recv()
                    except (EOFError, OSError):
                        outcome = ("error", f"solver process died (exit code {proc.exitcode})")
                        break
                    if msg[0] == "progress":
                        self._update(job_id, progress=max(0.0, min(1.0, float(msg[1]))))
                    else:
                        outcome = msg
                elif not proc.is_alive():
                    # drain a message that raced the exit
                    if parent.poll(0):
                        continue
                    outcome = ("error", f"solver process died (exit code {proc.exitcode})")
        finally:
            if proc.is_alive():
                proc.kill()
            proc.join(5)
            parent.close()
            self._proc = None
        if outcome[0] == "done":
            self._finish(job_id, status=DONE, progress=1.0, result=outcome[1])
        else:
            self._finish(job_id, status=ERROR, message=str(outcome[1]))
