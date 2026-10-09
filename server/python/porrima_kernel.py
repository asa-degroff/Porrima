#!/usr/bin/env python3
"""Porrima session Python kernel.

A persistent REPL driven over newline-delimited JSON on stdio. One synthetic
``__main__`` namespace, one asyncio loop, top-level await, interrupt handling
that preserves the namespace, and a per-cell subprocess journal for orphan
reaping. See docs/design/session-python-kernel.md.

Wire (protocol 1):
  requests  {"type":"execute","id":str,"code":str,"timeout_ms"?:int}
            {"type":"interrupt","id"?:str}            (no reply)
            {"type":"shutdown","id"?:str}
  events    {"event":"ready","protocol":1,"python":str}
            {"event":"stdout"|"stderr","id":str|null,"text":str}
            {"event":"result","id":str,"text":str}
            {"event":"error","id":str|null,"ename":str,"evalue":str,"traceback":[str,...]}
            {"event":"parked_interrupt","for_id":str}
            {"event":"done","id":str,"status":"ok"|"error","duration_ms":int,"timed_out"?:true}

Protocol frames leave on a private dup of fd 1 made before any redirection;
fds 1/2 are captured into pipes and re-shipped with id:null (raw bytes are
never attributed to a cell). fd 0 is rebound to /dev/null after the reader
takes it, so user input() sees EOF.
"""

from __future__ import annotations

import ast
import asyncio
import builtins
import codecs
import contextvars
import hashlib
import inspect
import io
import json
import linecache
import os
import select
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import traceback
import types
import uuid
from datetime import datetime, timezone
from typing import Any

PROTOCOL_VERSION = 1
_STREAM_FRAME_TEXT_CAP = 64 * 1024
_RESULT_TEXT_CAP = 1_048_576
_PAYLOAD_CAP = 16 * 1024 * 1024
_TRUNCATION_MARKER = "\n... [truncated]"
_DEFAULT_L2_GRACE_MS = 5000
_CHILD_TERM_GRACE_S = 0.5
_CHILD_KILL_WAIT_S = 2.0
_MAX_TOTAL_BYTES = 64 * 1024 * 1024
_MAX_VARIABLE_BYTES = 16 * 1024 * 1024
_SNAPSHOT_MAGIC = b"PORRIMA-KERNEL-SNAPSHOT-V1\n"
# Never serialized/restored: runtime handles and IPython-style bookkeeping.
# `emit` is re-injected into the namespace at every kernel start, and its
# `__globals__` is the driver module dict — snapshotting it would drag driver
# internals into the user namespace on restore.
_SNAPSHOT_ALWAYS_SKIP = {"In", "Out", "get_ipython", "exit", "quit", "open", "emit"}

# ---------------------------------------------------------------------------
# Process-global state
# ---------------------------------------------------------------------------

_protocol_fd: int = -1
_write_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_serve_task: asyncio.Task[Any] | None = None
_pump_out: "_Pump"
_pump_err: "_Pump"

# Asyncio tasks copy the cell context at creation, so detached tasks keep
# their spawning cell's output attribution. Threads start with a fresh context.
_current_cell: contextvars.ContextVar[str | None] = contextvars.ContextVar("_current_cell", default=None)

_active: dict[str, Any] = {"task": None, "rid": None, "interrupted": False}
# Background jobs: job_id -> {"task": inner Task | None, "interrupted": bool}.
# Jobs run concurrently and never occupy _active, so their interrupt handling
# is separate from the foreground cell machine.
_jobs: dict[str, dict[str, Any]] = {}
_cell_counter = 0

_interrupt_lock = threading.Lock()
_inflight: set[str] = set()
_pending_interrupts: dict[str, Any] = {"ids": set(), "any": False}
_sigint_target: str | None = None
_finishing_rid: str | None = None
_handoff_interrupted = False
_timed_out: set[str] = set()

# Per-cell subprocess groups (L2 kill + shutdown), and the durable journal the
# startup sweep reads after a hard crash.
_cell_children: dict[str | None, list[dict[str, Any]]] = {}
_children_lock = threading.Lock()

_kernel_dir: str | None = None
_owner_pid: int = 0
# Last successful snapshot target, remembered so an EOF shutdown (server died
# without a graceful dispose) can flush the namespace before exit. None until
# a host-committed snapshot exists: an EOF before that must not write a payload
# the host never considered durable.
_last_snapshot_target: dict[str, Any] | None = None


def _env_int(name: str, fallback: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
        return value if value > 0 else fallback
    except ValueError:
        return fallback


_L2_GRACE_MS = _env_int("PORRIMA_KERNEL_L2_GRACE_MS", _DEFAULT_L2_GRACE_MS)


# ---------------------------------------------------------------------------
# Protocol writes
# ---------------------------------------------------------------------------


def _send(event: dict[str, Any]) -> None:
    """Write one protocol frame; the locked single write keeps frames atomic."""
    try:
        data = (json.dumps(event, separators=(",", ":"), allow_nan=False) + "\n").encode()
    except (TypeError, ValueError):
        # A non-serializable payload must never tear framing; report and drop.
        _send_raw({"event": "error", "id": None, "ename": "ProtocolError",
                   "evalue": "unserializable event payload", "traceback": []})
        return
    with _write_lock:
        view = memoryview(data)
        try:
            while view:
                view = view[os.write(_protocol_fd, view):]
        except OSError:
            pass


def _send_raw(event: dict[str, Any]) -> None:
    data = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    with _write_lock:
        view = memoryview(data)
        try:
            while view:
                view = view[os.write(_protocol_fd, view):]
        except OSError:
            pass


def _protocol_error(message: str) -> None:
    _send({"event": "error", "id": None, "ename": "ProtocolError", "evalue": message, "traceback": []})


def emit(data: dict[str, Any]) -> None:
    """Ship one display event carrying a dict of MIME type -> JSON payload.

    Thread-safe; tagged with the cell running at call time. A payload that is
    not JSON-serializable or exceeds the frame cap raises in the calling cell
    instead of tearing framing.
    """
    if not isinstance(data, dict) or not data or not all(isinstance(k, str) for k in data):
        raise TypeError("emit() requires a non-empty dict keyed by MIME type strings")
    try:
        encoded = json.dumps(data, allow_nan=False)
    except (TypeError, ValueError) as err:
        raise ValueError(f"emit payload is not JSON-serializable: {err}") from err
    if len(encoded) > _PAYLOAD_CAP:
        raise ValueError(f"emit payload exceeds the {_PAYLOAD_CAP}-character frame cap")
    _send({"event": "display", "id": _current_cell.get(), "data": data})


def _cap_text(text: str) -> str:
    if len(text) > _RESULT_TEXT_CAP:
        return text[:_RESULT_TEXT_CAP] + _TRUNCATION_MARKER
    return text


def _safe_str(exc: BaseException) -> str:
    try:
        return str(exc)
    except BaseException:  # noqa: BLE001
        return "<exception str() failed>"


def _cap_traceback_lines(lines: list[str]) -> list[str]:
    total = sum(len(line) for line in lines)
    if total <= _RESULT_TEXT_CAP:
        return lines
    kept: list[str] = []
    remaining = _RESULT_TEXT_CAP
    for line in reversed(lines):
        if len(line) > remaining:
            if not kept:
                kept.append(line)
            break
        kept.append(line)
        remaining -= len(line)
    kept.reverse()
    kept.insert(0, f"[... traceback truncated: kept the newest {len(kept)} of {len(lines)} entries ...]\n")
    return kept


# ---------------------------------------------------------------------------
# Output capture: private protocol fd, tagged writers, raw-fd pumps
# ---------------------------------------------------------------------------


class _TaggedBuffer(io.RawIOBase):
    """Binary proxy for _TaggedWriter.buffer; bytes ride the raw fd channel."""

    def __init__(self, fallback_fd: int) -> None:
        self._fallback_fd = fallback_fd

    def write(self, data: Any) -> int:
        view = memoryview(data).cast("B")
        total = len(view)
        while view:
            view = view[os.write(self._fallback_fd, view):]
        return total

    def flush(self) -> None:
        pass

    def fileno(self) -> int:
        return self._fallback_fd

    def writable(self) -> bool:
        return True


class _TaggedWriter(io.TextIOBase):
    """sys.stdout/sys.stderr replacement tagging writes with the cell id."""

    def __init__(self, stream: str, fallback_fd: int) -> None:
        self._stream = stream
        self._fallback_fd = fallback_fd
        self._frame_lock = threading.Lock()
        self._buffer = _TaggedBuffer(fallback_fd)

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        if text:
            cell_id = _current_cell.get()
            with self._frame_lock:
                for start in range(0, len(text), _STREAM_FRAME_TEXT_CAP):
                    _send({"event": self._stream, "id": cell_id,
                           "text": text[start:start + _STREAM_FRAME_TEXT_CAP]})
        return len(text)

    def flush(self) -> None:
        pass

    def fileno(self) -> int:
        return self._fallback_fd

    def writable(self) -> bool:
        return True

    @property
    def buffer(self) -> _TaggedBuffer:
        return self._buffer

    @property
    def encoding(self) -> str:
        return "utf-8"

    @property
    def errors(self) -> str:
        return "replace"


class _Pump:
    """Reads one captured-output pipe and ships its bytes as stream events."""

    def __init__(self, read_fd: int, write_fd: int, stream: str) -> None:
        self._read_fd = read_fd
        self._token_fd = os.dup(write_fd)  # private: cells cannot hijack drain tokens
        self._stream = stream
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._lock = threading.Lock()
        self._watch: tuple[bytes, threading.Event] | None = None
        self._buf = b""
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def drain(self) -> None:
        """Block until every byte written to the fd so far has been shipped."""
        token = b"\xff<drain:" + uuid.uuid4().hex.encode() + b">\xff"
        seen = threading.Event()
        with self._lock:
            self._watch = (token, seen)
        try:
            os.write(self._token_fd, token)
            while not seen.wait(0.1):
                if not self._thread.is_alive():
                    return
        except OSError:
            return
        finally:
            with self._lock:
                self._watch = None

    def _run(self) -> None:
        while True:
            try:
                chunk = os.read(self._read_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self._feed(chunk)

    def _feed(self, chunk: bytes) -> None:
        data = self._buf + chunk
        self._buf = b""
        with self._lock:
            watch = self._watch
        if watch is None:
            self._emit(data)
            return
        token, seen = watch
        while True:
            index = data.find(token)
            if index == -1:
                break
            self._emit(data[:index])
            self._finish_decode()
            seen.set()
            data = data[index + len(token):]
        hold = 0
        for size in range(min(len(data), len(token) - 1), 0, -1):
            if data.endswith(token[:size]):
                hold = size
                break
        if hold:
            self._buf = data[len(data) - hold:]
            data = data[:len(data) - hold]
        self._emit(data)

    def _emit(self, data: bytes) -> None:
        if not data:
            return
        text = self._decoder.decode(data)
        if text:
            # Raw fd bytes have no provable owner: never credit a cell.
            _send({"event": self._stream, "id": None, "text": text})

    def _finish_decode(self) -> None:
        text = self._decoder.decode(b"", final=True)
        if text:
            _send({"event": self._stream, "id": None, "text": text})


def _setup_fds() -> int:
    """Reserve stdout for the protocol; route fds 1/2 through captured pipes."""
    global _protocol_fd, _pump_out, _pump_err
    _protocol_fd = os.dup(1)
    os.set_inheritable(_protocol_fd, False)
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    os.dup2(out_w, 1)
    os.dup2(err_w, 2)
    os.close(out_w)
    os.close(err_w)
    sys.stdout = _TaggedWriter("stdout", fallback_fd=os.dup(1))
    sys.stderr = _TaggedWriter("stderr", fallback_fd=os.dup(2))
    stdin_fd = os.dup(0)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdin = open(os.devnull, "r")
    _pump_out = _Pump(out_r, 1, "stdout")
    _pump_err = _Pump(err_r, 2, "stderr")
    return stdin_fd


def _drain_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except (OSError, ValueError, AttributeError):
            pass
    _pump_out.drain()
    _pump_err.drain()


# ---------------------------------------------------------------------------
# Interrupts
# ---------------------------------------------------------------------------


def _consume_task_exception(task: asyncio.Task[Any]) -> None:
    if not task.cancelled():
        task.exception()


def _sigint_handler(signum: int, frame: types.FrameType | None) -> None:
    global _handoff_interrupted
    target = _sigint_target
    if target is not None and target in _jobs:
        # Job target: raise into the job's own step when the main thread is
        # executing it, otherwise cancel its task (delivered at the next
        # suspension). A foreground cell running concurrently is untouched.
        job = _jobs[target]
        job_task = job.get("task")
        if job_task is not None and not job_task.done():
            job["interrupted"] = True
            running = asyncio.current_task(_loop) if _loop is not None else None
            if running is job_task:
                raise KeyboardInterrupt
            job_task.cancel()
        return
    task = _active["task"]
    if task is None or task.done() or _active["rid"] != _sigint_target:
        if _sigint_target is not None and _sigint_target == _active["rid"]:
            # Done-task handoff: the task is done but _run_guarded's finally has
            # not run; record it and let the finishing phase consume it.
            _handoff_interrupted = True
            return
        if _sigint_target is not None and _sigint_target == _finishing_rid:
            raise KeyboardInterrupt
        return
    _active["interrupted"] = True
    running = asyncio.current_task(_loop) if _loop is not None else None
    if running is task:
        raise KeyboardInterrupt
    task.cancel()
    if running is not None and running is not _serve_task:
        running.add_done_callback(_consume_task_exception)
        raise KeyboardInterrupt


def _request_interrupt(target: str | None) -> None:
    """Deliver an interrupt now, or park it for the request it targets."""
    global _sigint_target
    deliver = False
    with _interrupt_lock:
        if target is not None and target in _jobs:
            job_task = _jobs[target].get("task")
            if job_task is not None and not job_task.done():
                _sigint_target = target
                deliver = True
        if not deliver:
            rid = _active["rid"]
            if rid is not None and (target is None or target == rid):
                _sigint_target = rid
                deliver = True
            elif _finishing_rid is not None and (target is None or target == _finishing_rid):
                _sigint_target = _finishing_rid
                deliver = True
            elif target is not None:
                if target in _inflight:
                    _pending_interrupts["ids"].add(target)
                    _send({"event": "parked_interrupt", "for_id": target})
                return
            elif _inflight:
                _pending_interrupts["any"] = True
                return
            else:
                return
    if hasattr(signal, "pthread_kill"):
        signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
        if _loop is not None:
            _loop.call_soon_threadsafe(lambda: None)
    elif _loop is not None:
        def cancel_active() -> None:
            current = _active["task"]
            if current is not None and not current.done():
                _active["interrupted"] = True
                current.cancel()
        _loop.call_soon_threadsafe(cancel_active)
    # L2: if the cell/job has not settled after the grace window, cancel its
    # task (delivered at the next suspension) and kill its tracked child groups
    # (which also unblocks sync waits).
    if target is not None:
        _schedule_escalation(target)


def _schedule_escalation(rid: str) -> None:
    def escalate() -> None:
        with _interrupt_lock:
            job = _jobs.get(rid)
            active = _active["rid"] == rid and _active["task"] is not None and not _active["task"].done()
            finishing = _finishing_rid == rid
        if job is None and not (active or finishing):
            return
        if _loop is not None:
            if job is not None:
                def cancel_job() -> None:
                    entry = _jobs.get(rid)
                    if entry is None:
                        return
                    task = entry.get("task")
                    if task is not None and not task.done():
                        entry["interrupted"] = True
                        task.cancel()
                _loop.call_soon_threadsafe(cancel_job)
            else:
                def cancel_task() -> None:
                    current = _active["task"]
                    if _active["rid"] == rid and current is not None and not current.done():
                        _active["interrupted"] = True
                        current.cancel()
                _loop.call_soon_threadsafe(cancel_task)
        _kill_cell_children(rid)

    timer = threading.Timer(_L2_GRACE_MS / 1000.0, escalate)
    timer.daemon = True
    timer.start()


def _consume_pending_interrupt(rid: str) -> bool:
    pending = _pending_interrupts["any"] or rid in _pending_interrupts["ids"]
    _pending_interrupts["any"] = False
    _pending_interrupts["ids"].discard(rid)
    return pending


def _consume_handoff_interrupt() -> bool:
    global _handoff_interrupted
    with _interrupt_lock:
        pending = _handoff_interrupted
        _handoff_interrupted = False
        return pending


def _finish_locked(rid: str) -> None:
    global _finishing_rid, _handoff_interrupted, _sigint_target
    if _finishing_rid == rid:
        _finishing_rid = None
        _handoff_interrupted = False
    if _sigint_target == rid:
        _sigint_target = None
    _inflight.discard(rid)
    _pending_interrupts["ids"].discard(rid)
    if not _inflight:
        _pending_interrupts["any"] = False


def _finish_request(rid: str) -> None:
    with _interrupt_lock:
        _finish_locked(rid)


# ---------------------------------------------------------------------------
# Cell execution
# ---------------------------------------------------------------------------

_RUNTIME_FILE = __file__


def _cell_stack(stack: traceback.StackSummary) -> traceback.StackSummary | None:
    start = next((i for i, f in enumerate(stack) if f.filename.startswith("<porrima-cell-")), None)
    if start is None:
        return None
    return traceback.StackSummary.from_list([f for f in stack[start:] if f.filename != _RUNTIME_FILE])


def _error_event(cell_id: str, exc: BaseException) -> dict[str, Any]:
    te = traceback.TracebackException.from_exception(exc)
    stack = _cell_stack(te.stack)
    if stack is None:
        lines = traceback.format_exception_only(type(exc), exc)
    else:
        te.stack = stack
        lines = list(te.format())
    return {
        "event": "error",
        "id": cell_id,
        "ename": type(exc).__name__,
        "evalue": _cap_text(_safe_str(exc)),
        "traceback": _cap_traceback_lines([_cap_text(line) for line in lines]),
    }


def _interrupt_event(cell_id: str, exc: BaseException) -> dict[str, Any]:
    stack = _cell_stack(traceback.extract_tb(exc.__traceback__))
    lines: list[str] = []
    if stack:
        lines = ["Traceback (most recent call last):\n"]
        lines.extend(stack.format())
    lines.append("KeyboardInterrupt\n")
    return {"event": "error", "id": cell_id, "ename": "KeyboardInterrupt", "evalue": "", "traceback": lines}


def _compile_cell(code: str, filename: str) -> tuple[list[types.CodeType], bool]:
    linecache.cache[filename] = (len(code), None, code.splitlines(keepends=True), filename)
    tree = ast.parse(code, filename)
    trailing: ast.Expression | None = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        trailing = ast.Expression(tree.body.pop().value)
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    codes: list[types.CodeType] = []
    if tree.body:
        codes.append(compile(tree, filename, "exec", flags=flags, dont_inherit=True))
    if trailing is not None:
        codes.append(compile(trailing, filename, "eval", flags=flags, dont_inherit=True))
    return codes, trailing is not None


async def _run_codes(codes: list[types.CodeType], ns: dict[str, Any]) -> Any:
    value: Any = None
    for code_obj in codes:
        value = eval(code_obj, ns)  # noqa: S307 - executing the model's cell is the job
        if code_obj.co_flags & inspect.CO_COROUTINE:
            value = await value
    return value


async def _run_guarded(task: asyncio.Task[Any], rid: str) -> tuple[str, Any, dict[str, Any] | None, bool]:
    """Await a request task; returns (status, value, error event or None,
    interrupted_by_task)."""
    with _interrupt_lock:
        _active["interrupted"] = False
        _active["rid"] = rid
        _active["task"] = task
        if _consume_pending_interrupt(rid):
            _active["interrupted"] = True
            task.cancel()
    try:
        value = await task
        return "ok", value, None, False
    except asyncio.CancelledError as exc:
        if _active["interrupted"]:
            return "error", None, _interrupt_event(rid, exc), True
        return "error", None, _error_event(rid, exc), False
    except BaseException as exc:  # noqa: BLE001 - every cell failure becomes an error event
        # Only an interrupt-driven KeyboardInterrupt counts: a user-raised one
        # (with no pending interrupt) must not trigger child reaping.
        interrupted = bool(_active["interrupted"]) and isinstance(exc, KeyboardInterrupt)
        return "error", None, _error_event(rid, exc), interrupted
    finally:
        with _interrupt_lock:
            global _finishing_rid
            _finishing_rid = rid
            _active["task"] = None
            _active["rid"] = None


async def _run_job_guarded(
    task: asyncio.Task[Any], job_id: str
) -> tuple[str, Any, dict[str, Any] | None, bool]:
    """Job twin of _run_guarded: jobs never occupy _active, so this only
    awaits and classifies; interrupt bookkeeping lives in _jobs."""
    try:
        value = await task
        return "ok", value, None, False
    except asyncio.CancelledError as exc:
        if _jobs.get(job_id, {}).get("interrupted"):
            return "error", None, _interrupt_event(job_id, exc), True
        return "error", None, _error_event(job_id, exc), False
    except BaseException as exc:  # noqa: BLE001
        interrupted = bool(_jobs.get(job_id, {}).get("interrupted")) and isinstance(exc, KeyboardInterrupt)
        return "error", None, _error_event(job_id, exc), interrupted


def _start_job(job_id: str, req: dict[str, Any], ns: dict[str, Any]) -> None:
    """Schedule a job whose ack already went out on the reader thread.

    The outer task is deliberately NOT registered as the interrupt target: an
    interrupt arriving before the inner cell task exists must park (the job id
    is already in _inflight) and be consumed by _run_job, or a SIGINT in that
    window would kill the outer task without ever emitting job_done."""
    assert _loop is not None
    _loop.create_task(_run_job(job_id, req, ns))


async def _run_job(job_id: str, req: dict[str, Any], ns: dict[str, Any]) -> None:
    global _cell_counter
    started = time.monotonic()
    _cell_counter += 1
    filename = f"<porrima-cell-{_cell_counter}>"
    cell_token = _current_cell.set(job_id)
    timeout_handle: threading.Timer | None = None
    status = "ok"
    try:
        timeout_ms = req.get("timeout_ms")
        if isinstance(timeout_ms, int) and not isinstance(timeout_ms, bool) and timeout_ms > 0:
            def on_timeout() -> None:
                _timed_out.add(job_id)
                _request_interrupt(job_id)
            timeout_handle = threading.Timer(timeout_ms / 1000.0, on_timeout)
            timeout_handle.daemon = True
            timeout_handle.start()

        codes, has_trailing = _compile_cell(req["code"], filename)
        assert _loop is not None
        inner = _loop.create_task(_run_codes(codes, ns))
        with _interrupt_lock:
            entry = _jobs.get(job_id)
            if entry is not None:
                entry["task"] = inner
            if _consume_pending_interrupt(job_id):
                # Kill parked before the job started: cancel before its first step.
                if entry is not None:
                    entry["interrupted"] = True
                inner.cancel()
        status, value, error, interrupted_by_task = await _run_job_guarded(inner, job_id)
        result_text: str | None = None
        if status == "ok" and has_trailing and value is not None:
            try:
                ns["_"] = value
                result_text = repr(value)
            except BaseException as exc:  # noqa: BLE001
                status, error = "error", _error_event(job_id, exc)
        if result_text is not None:
            result_text = _cap_text(result_text)
        _drain_output()
        if result_text is not None:
            _send({"event": "result", "id": job_id, "text": result_text})
        if error is not None:
            _send(error)
        duration_ms = int((time.monotonic() - started) * 1000)
        done: dict[str, Any] = {
            "event": "job_done", "job_id": job_id, "status": status, "duration_ms": duration_ms,
        }
        if job_id in _timed_out:
            _timed_out.discard(job_id)
            done["timed_out"] = True
        _send(done)
        if interrupted_by_task and status == "error":
            # Same rule as foreground cells: a job that died to the interrupt
            # never ran its cleanup, so reap the child groups it left behind.
            _kill_cell_children(job_id)
    finally:
        if timeout_handle is not None:
            timeout_handle.cancel()
        _finish_request(job_id)
        with _interrupt_lock:
            _jobs.pop(job_id, None)
        _current_cell.reset(cell_token)


async def _handle_execute(req: dict[str, Any], ns: dict[str, Any]) -> None:
    global _cell_counter
    cell_id = req["id"]
    started = time.monotonic()
    _cell_counter += 1
    filename = f"<porrima-cell-{_cell_counter}>"
    cell_token = _current_cell.set(cell_id)
    timeout_handle: threading.Timer | None = None
    try:
        timeout_ms = req.get("timeout_ms")
        if isinstance(timeout_ms, int) and not isinstance(timeout_ms, bool) and timeout_ms > 0:
            # A threading.Timer, not loop.call_later: a sync cell blocks the
            # loop, so a loop-scheduled timeout would never fire. The timer
            # thread interrupts through the same pthread_kill path as a host
            # interrupt, which reaches a blocked cell.
            def on_timeout() -> None:
                _timed_out.add(cell_id)
                _request_interrupt(cell_id)
            timeout_handle = threading.Timer(timeout_ms / 1000.0, on_timeout)
            timeout_handle.daemon = True
            timeout_handle.start()

        codes, has_trailing = _compile_cell(req["code"], filename)
        assert _loop is not None
        task = _loop.create_task(_run_codes(codes, ns))
        status, value, error, interrupted_by_task = await _run_guarded(task, cell_id)
        result_text: str | None = None
        try:
            if _consume_handoff_interrupt() and status == "ok":
                status, error = "error", _error_event(cell_id, KeyboardInterrupt())
            if status == "ok" and has_trailing and value is not None:
                try:
                    ns["_"] = value
                    result_text = repr(value)
                except BaseException as exc:  # noqa: BLE001
                    status, error = "error", _error_event(cell_id, exc)
            if result_text is not None:
                result_text = _cap_text(result_text)
            _drain_output()
        finally:
            # Close the interrupt window before the sends so a handler-raised
            # KeyboardInterrupt can never tear a frame mid-write.
            _finish_request(cell_id)
        if result_text is not None:
            _send({"event": "result", "id": cell_id, "text": result_text})
        if error is not None:
            _send(error)
        duration_ms = int((time.monotonic() - started) * 1000)
        done: dict[str, Any] = {"event": "done", "id": cell_id, "status": status, "duration_ms": duration_ms}
        if cell_id in _timed_out:
            _timed_out.discard(cell_id)
            done["timed_out"] = True
        _send(done)
        if interrupted_by_task and status == "error":
            # The cell died to the interrupt, so its cleanup never ran: reap
            # the child groups it left behind. A cell that handled the
            # interrupt and completed keeps its children (cooperative case),
            # and the L2 escalation still reaps them if it runs past the
            # grace window.
            _kill_cell_children(cell_id)
    finally:
        if timeout_handle is not None:
            timeout_handle.cancel()
        _current_cell.reset(cell_token)


# ---------------------------------------------------------------------------
# Per-cell subprocess journal
# ---------------------------------------------------------------------------


def _process_start_id(pid: int) -> str | None:
    try:
        with open(f"/proc/{pid}/stat", "r") as fh:
            stat = fh.read()
        fields = stat[stat.rindex(")") + 2:].split(" ")
        if len(fields) > 19 and fields[19]:
            return f"proc:{fields[19]}"
    except (OSError, ValueError):
        pass
    return None


def _journal_path() -> str | None:
    if not _kernel_dir:
        return None
    return os.path.join(_kernel_dir, "children.jsonl")


def _append_journal(record: dict[str, Any]) -> None:
    path = _journal_path()
    if path is None:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            data = (json.dumps(record) + "\n").encode()
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


def _register_child(pid: int) -> None:
    cell = _current_cell.get()
    entry = {"pid": pid, "pgid": pid, "start_id": _process_start_id(pid)}
    with _children_lock:
        _cell_children.setdefault(cell, []).append(entry)
    _append_journal({
        "version": 1, "pid": pid, "pgid": pid,
        "startId": entry["start_id"], "cell": cell, "active": True,
        "recordedAt": datetime.now(timezone.utc).isoformat(),
    })


def _signal_group(pgid: int, sig: int) -> bool:
    try:
        os.killpg(pgid, sig)
        return True
    except ProcessLookupError:
        return True
    except OSError:
        return False


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True


def _reap_child(pid: int) -> None:
    """Reap a direct child if it has exited; zombies keep killpg(…, 0) 'alive'."""
    try:
        os.waitpid(pid, os.WNOHANG)
    except (ChildProcessError, OSError):
        pass


def _kill_children(entries: list[dict[str, Any]]) -> None:
    """TERM, short grace, KILL; mark the journal inactive on confirmed death."""
    for entry in entries:
        pgid = entry["pgid"]
        pid = entry["pid"]
        if not _group_alive(pgid):
            _reap_child(pid)
            continue
        _signal_group(pgid, signal.SIGTERM)
        deadline = time.monotonic() + _CHILD_TERM_GRACE_S
        while time.monotonic() < deadline and _group_alive(pgid):
            _reap_child(pid)
            time.sleep(0.02)
        if _group_alive(pgid):
            _signal_group(pgid, signal.SIGKILL)
            kill_deadline = time.monotonic() + _CHILD_KILL_WAIT_S
            while time.monotonic() < kill_deadline and _group_alive(pgid):
                _reap_child(pid)
                time.sleep(0.02)
        _reap_child(pid)
        if not _group_alive(pgid):
            _append_journal({
                "version": 1, "pid": entry["pid"], "pgid": pgid,
                "startId": entry.get("start_id"), "cell": None, "active": False,
                "recordedAt": datetime.now(timezone.utc).isoformat(),
            })


def _kill_cell_children(cell_id: str) -> None:
    with _children_lock:
        entries = list(_cell_children.get(cell_id, []))
        _cell_children.pop(cell_id, None)
    if entries:
        threading.Thread(target=_kill_children, args=(entries,), daemon=True).start()


def _kill_all_children() -> None:
    with _children_lock:
        entries = [entry for group in _cell_children.values() for entry in group]
        _cell_children.clear()
    _kill_children(entries)


# ---------------------------------------------------------------------------
# Boot self-heal (remote-python-kernel.md §4.4)
#
# The Node manager's startup sweep can only reach this box's filesystem, and
# an SSH kernel's state lives on the host. So the cleanup belongs to the
# driver: it runs in the kernel directory before `ready` and is idempotent.
# Local kernels get the same protection (defense in depth against the owner
# watchdog missing a case); nothing here may block the kernel from starting.
# ---------------------------------------------------------------------------

_PIDFILE = "kernel.pid"
_STATE_TTL_S = 14 * 24 * 3600  # mirrors KERNEL_STATE_TTL_MS in python-kernel.ts


def _driver_hash() -> str:
    """Content hash reported in `ready` so the manager can spot a stale or
    externally-mutated staged driver on this host (§4.3). Hashed from the
    file that is actually running."""
    try:
        with open(__file__, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()[:16]
    except OSError:
        return ""


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def _signal_direct(pid: int, sig: int) -> None:
    try:
        os.kill(pid, sig)
    except OSError:
        pass


def _kill_predecessor(kernel_dir: str) -> None:
    """If a previous kernel for this state dir is still alive, take it down
    before we write anything into the dir it owns."""
    try:
        with open(os.path.join(kernel_dir, _PIDFILE)) as fh:
            pid = int(fh.read().strip())
    except (OSError, ValueError):
        return
    if pid <= 0 or pid == os.getpid() or not _pid_alive(pid):
        return
    # Targeted kill, NOT a group kill: over ssh the predecessor shares the
    # session process group with sshd plumbing, and this driver is about to
    # join the same group. Its journaled children are handled by the stale
    # journal sweep below.
    _signal_direct(pid, signal.SIGTERM)
    deadline = time.monotonic() + _CHILD_TERM_GRACE_S
    while time.monotonic() < deadline and _pid_alive(pid):
        time.sleep(0.02)
    if _pid_alive(pid):
        _signal_direct(pid, signal.SIGKILL)
        deadline = time.monotonic() + _CHILD_KILL_WAIT_S
        while time.monotonic() < deadline and _pid_alive(pid):
            time.sleep(0.02)


def _sweep_stale_journal(kernel_dir: str) -> None:
    """Reap setsid children a crashed predecessor left running, then truncate.
    Same identity rule as the manager's startup sweep (§4.11): a record is
    skipped only when its pid is ALIVE with a different start time — pid
    recycled, not our family."""
    path = os.path.join(kernel_dir, "children.jsonl")
    try:
        with open(path) as fh:
            lines = fh.readlines()
    except OSError:
        return
    entries: list[dict[str, Any]] = []
    for raw in lines:
        try:
            record = json.loads(raw)
        except ValueError:
            continue  # torn tail line: tolerate (§4.15)
        if not isinstance(record, dict) or not record.get("active"):
            continue
        pid = record.get("pid")
        if not isinstance(pid, int) or pid <= 0:
            continue
        recorded_start = record.get("startId")
        if recorded_start is not None:
            current_start = _process_start_id(pid)
            if current_start is not None and current_start != recorded_start:
                continue  # pid recycled — leave the stranger alone
        entries.append({
            "pid": pid,
            "pgid": record.get("pgid") or pid,
            "start_id": recorded_start,
        })
    if entries:
        _kill_children(entries)
    try:
        with open(path, "w"):
            pass
    except OSError:
        pass


def _prune_expired_state(kernel_dir: str) -> None:
    """Drop sibling chat state dirs past the TTL, skipping any with a live
    kernel (dir mtime only moves when files change — an idle-but-live chat
    must never be pruned out from under itself)."""
    parent = os.path.dirname(kernel_dir)
    own = os.path.basename(kernel_dir)
    try:
        names = os.listdir(parent)
    except OSError:
        return
    now = time.time()
    for name in names:
        if name == own:
            continue
        full = os.path.join(parent, name)
        if not os.path.isdir(full):
            continue
        try:
            with open(os.path.join(full, _PIDFILE)) as fh:
                pid = int(fh.read().strip())
            if _pid_alive(pid):
                continue
        except (OSError, ValueError):
            pass
        try:
            if now - os.stat(full).st_mtime < _STATE_TTL_S:
                continue
        except OSError:
            continue
        shutil.rmtree(full, ignore_errors=True)


def _boot_self_heal() -> None:
    if not _kernel_dir:
        return
    try:
        os.makedirs(_kernel_dir, mode=0o700, exist_ok=True)
    except OSError:
        return
    for step in (_kill_predecessor, _sweep_stale_journal, _prune_expired_state):
        try:
            step(_kernel_dir)
        except BaseException as err:  # noqa: BLE001 — self-heal never blocks startup
            _protocol_error(f"boot self-heal ({step.__name__}) failed: {type(err).__name__}: {err}")
    try:
        with open(os.path.join(_kernel_dir, _PIDFILE), "w") as fh:
            fh.write(str(os.getpid()))
    except OSError:
        pass


def _install_popen_patch() -> None:
    """Give ordinary Popen children their own session and journal them.

    Calls that already set `preexec_fn`/`start_new_session` are left alone;
    children that stay in the kernel's process group are reaped with it.
    """
    original = subprocess.Popen

    class JournaledPopen(original):  # type: ignore[misc, valid-type]
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            if "preexec_fn" not in kwargs and not kwargs.get("start_new_session"):
                kwargs["start_new_session"] = True
            super().__init__(*args, **kwargs)
            if self.pid:
                try:
                    _register_child(self.pid)
                except BaseException:  # noqa: BLE001 - tracking must never fail a spawn
                    pass

    subprocess.Popen = JournaledPopen  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Owner watchdog
# ---------------------------------------------------------------------------


def _owner_alive(owner: int, initial_ppid: int) -> bool:
    if initial_ppid == owner and os.getppid() != initial_ppid:
        return False
    try:
        os.kill(owner, 0)
    except ProcessLookupError:
        return False
    except OSError:
        pass
    return True


def _wait_owner(owner: int, initial_ppid: int) -> None:
    try:
        if hasattr(select, "kqueue"):
            kq = select.kqueue()
            kq.control(
                [select.kevent(owner, select.KQ_FILTER_PROC, select.KQ_EV_ADD, select.KQ_NOTE_EXIT)],
                0, 0,
            )
            wait_for_exit = lambda: kq.control(None, 1)
        else:
            poller = select.poll()
            poller.register(os.pidfd_open(owner), select.POLLIN)
            wait_for_exit = lambda: poller.poll()
    except ProcessLookupError:
        return
    except (AttributeError, OSError):
        while _owner_alive(owner, initial_ppid):
            time.sleep(30.0)
        return
    if _owner_alive(owner, initial_ppid):
        wait_for_exit()


def _owner_watchdog(owner: int, initial_ppid: int) -> None:
    _wait_owner(owner, initial_ppid)
    # Event-loop-independent by design: a sync cell monopolizes the loop, so a
    # queued EOF shutdown can never run; hard-exit from here.
    try:
        _kill_all_children()
    except BaseException:  # noqa: BLE001
        pass
    os._exit(1)


def _start_owner_watchdog() -> None:
    global _owner_pid
    try:
        _owner_pid = int(os.environ.get("PORRIMA_KERNEL_OWNER_PID", ""))
    except ValueError:
        _owner_pid = 0
    if _owner_pid <= 0:
        _owner_pid = os.getppid()
    threading.Thread(target=_owner_watchdog, args=(_owner_pid, os.getppid()), daemon=True).start()


# ---------------------------------------------------------------------------
# Snapshot / restore
# ---------------------------------------------------------------------------


class _SizeLimitExceeded(Exception):
    pass


class _CappedWriter(io.BytesIO):
    """BytesIO that raises once the per-variable cap is crossed mid-dump."""

    def __init__(self, limit: int) -> None:
        super().__init__()
        self._limit = limit
        self._size = 0

    def write(self, data: Any) -> int:
        view = memoryview(data)
        self._size += len(view)
        if self._size > self._limit:
            raise _SizeLimitExceeded()
        return super().write(view)


def _dumps_capped(value: Any, limit: int) -> bytes:
    buf = _CappedWriter(limit)
    try:
        import dill  # type: ignore

        dill.settings["recurse"] = True
        dill.dump(value, buf, recurse=True)
    except ImportError:
        import pickle

        pickle.dump(value, buf)
    return buf.getvalue()


def _loads(blob: bytes) -> Any:
    try:
        import dill  # type: ignore

        return dill.loads(blob)
    except ImportError:
        import pickle

        return pickle.loads(blob)


def _revive_with_live_globals(
    value: Any, live_ns: dict[str, Any], seen: dict[int, Any] | None = None
) -> Any:
    """Rebind restored `__main__` callables onto the live namespace.

    Restored functions carry the snapshot's frozen globals; without this a
    function would mutate a stale copy of module state. Containers are revived
    in place with cycle memoization; functions get live globals plus a backfill
    of globals the live namespace lacks. Closures/defaults keep their restored
    values (documented limitation; dill-recurse already captures what they use).
    """
    if seen is None:
        seen = {}
    identity = id(value)
    if identity in seen:
        return seen[identity]
    if isinstance(value, types.FunctionType):
        if value.__globals__ is globals():
            # A driver-module function (e.g. a user stashed a reference to
            # `emit` inside a container): rebinding it to the user namespace
            # would break its driver globals, and backfilling its globals
            # would leak driver internals into the user namespace. Prefer the
            # live same-named driver function when it exists.
            live = globals().get(value.__name__)
            return live if isinstance(live, types.FunctionType) else value
        for key, item in value.__globals__.items():
            if key not in live_ns and not key.startswith("_") and key not in _SNAPSHOT_ALWAYS_SKIP:
                live_ns[key] = item
        revived = types.FunctionType(value.__code__, live_ns, value.__name__, value.__defaults__, value.__closure__)
        revived.__dict__.update(value.__dict__)
        revived.__module__ = "__main__"
        seen[identity] = revived
        return revived
    if isinstance(value, list):
        seen[identity] = value
        for index, item in enumerate(value):
            value[index] = _revive_with_live_globals(item, live_ns, seen)
        return value
    if isinstance(value, dict):
        seen[identity] = value
        for key in list(value.keys()):
            value[key] = _revive_with_live_globals(value[key], live_ns, seen)
        return value
    if isinstance(value, set):
        seen[identity] = value
        items = list(value)
        value.clear()
        for item in items:
            value.add(_revive_with_live_globals(item, live_ns, seen))
        return value
    return value


def _snapshot_state(
    ns: dict[str, Any],
    path: str,
    manifest_path: str,
    max_bytes: int,
    max_variable_bytes: int,
    prune_oversized: bool,
    committed: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    try:
        if os.path.realpath(path) == os.path.realpath(manifest_path):
            return {"error": "path and manifest_path must differ"}
    except OSError:
        pass
    saved: list[str] = []
    skipped: list[dict[str, str]] = []
    oversized: set[str] = set()
    total = 0
    payload_tmp = f"{path}.tmp-{uuid.uuid4().hex}"
    manifest_tmp = f"{manifest_path}.tmp-{uuid.uuid4().hex}"
    try:
        with open(payload_tmp, "wb") as fh:
            fh.write(_SNAPSHOT_MAGIC)
            for name in sorted(ns):
                if name.startswith("_") or name in _SNAPSHOT_ALWAYS_SKIP:
                    continue
                try:
                    blob = _dumps_capped(ns[name], max_variable_bytes)
                except _SizeLimitExceeded:
                    oversized.add(name)
                    skipped.append({"name": name, "reason": f"serialized size exceeds {max_variable_bytes} bytes"})
                    continue
                except BaseException as exc:  # noqa: BLE001
                    skipped.append({"name": name, "reason": f"{type(exc).__name__}: {_safe_str(exc)}"})
                    continue
                encoded_name = name.encode("utf-8")
                overhead = 4 + len(encoded_name) + 8
                if total + overhead + len(blob) > max_bytes:
                    skipped.append({"name": name, "reason": f"total cap {max_bytes} bytes reached"})
                    continue
                fh.write(struct.pack("<I", len(encoded_name)))
                fh.write(encoded_name)
                fh.write(struct.pack("<Q", len(blob)))
                fh.write(blob)
                total += overhead + len(blob)
                saved.append(name)
        pruned = sorted(name for name in oversized if name in ns) if prune_oversized else []
        manifest = {
            "version": 1,
            "savedNames": saved,
            "skipped": skipped,
            "pruned": pruned,
            "bytes": total,
            "pythonVersion": sys.version.split()[0],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        with open(manifest_tmp, "w") as fh:
            json.dump(manifest, fh)
        # Commit: park SIGINT for the destructive replaces and consume it. The
        # snapshot succeeded, so re-raising would make the host treat it as
        # failed and discard the only copy of pruned names.
        parked: list[int] = []
        previous = signal.signal(signal.SIGINT, lambda signum, frame: parked.append(signum))
        try:
            os.replace(payload_tmp, path)
            try:
                os.replace(manifest_tmp, manifest_path)
            except OSError as err:
                return {"error": f"manifest write failed: {err}"}
        finally:
            signal.signal(signal.SIGINT, previous)
        for name in pruned:
            ns.pop(name, None)
        result = {"saved": saved, "skipped": skipped, "pruned": pruned, "bytes": total}
        if committed is not None:
            committed.append(result)
        return result
    except BaseException as exc:  # noqa: BLE001
        if not isinstance(exc, Exception):
            raise
        return {"error": f"snapshot failed: {exc}"}
    finally:
        for temporary in (payload_tmp, manifest_tmp):
            try:
                os.unlink(temporary)
            except OSError:
                pass


def _read_snapshot_records(path: str, max_bytes: int, max_variable_bytes: int) -> list[tuple[str, bytes]]:
    """Read per-name records with the same caps enforced before allocating."""
    records: list[tuple[str, bytes]] = []
    total = 0
    with open(path, "rb") as fh:
        if fh.read(len(_SNAPSHOT_MAGIC)) != _SNAPSHOT_MAGIC:
            raise ValueError("unrecognized snapshot format")
        while True:
            header = fh.read(4)
            if not header:
                break
            if len(header) < 4:
                raise ValueError("truncated record header")
            name_len = struct.unpack("<I", header)[0]
            if name_len > max_bytes:
                raise ValueError("record name exceeds the total cap")
            name = fh.read(name_len).decode("utf-8")
            length_bytes = fh.read(8)
            if len(length_bytes) < 8:
                raise ValueError("truncated record length")
            blob_len = struct.unpack("<Q", length_bytes)[0]
            if blob_len > max_variable_bytes:
                raise ValueError("record exceeds the per-variable cap")
            total += name_len + blob_len
            if total > max_bytes:
                raise ValueError("records exceed the total cap")
            blob = fh.read(blob_len)
            if len(blob) < blob_len:
                raise ValueError("truncated record blob")
            records.append((name, blob))
    return records


def _dill_available() -> bool:
    try:
        import dill  # type: ignore  # noqa: F401

        return True
    except ImportError:
        return False


def _restore_state(ns: dict[str, Any], path: str) -> dict[str, Any]:
    if not os.path.exists(path):
        return {"restored": [], "failed": [], "reason": "snapshot not found"}
    try:
        records = _read_snapshot_records(path, _MAX_TOTAL_BYTES, _MAX_VARIABLE_BYTES)
    except (OSError, ValueError) as err:
        return {"error": f"snapshot read failed: {err}"}
    staged: dict[str, Any] = {}
    failed: list[dict[str, str]] = []
    for name, blob in records:
        if name.startswith("_") or name in _SNAPSHOT_ALWAYS_SKIP:
            continue
        try:
            staged[name] = _loads(blob)
        except BaseException as exc:  # noqa: BLE001
            failed.append({"name": name, "reason": f"{type(exc).__name__}: {_safe_str(exc)}"})
    restored: list[str] = []
    for name, value in staged.items():
        try:
            ns[name] = _revive_with_live_globals(value, ns)
            restored.append(name)
        except BaseException as exc:  # noqa: BLE001
            failed.append({"name": name, "reason": f"{type(exc).__name__}: {_safe_str(exc)}"})
    return {
        "restored": sorted(restored),
        "failed": failed,
        "engine": "dill" if _dill_available() else "pickle",
    }


def _flush_final_snapshot(ns: dict[str, Any]) -> None:
    """EOF-only best-effort flush to the last host-committed target."""
    target = _last_snapshot_target
    if target is None:
        return
    try:
        _snapshot_state(
            ns,
            target["path"],
            target["manifest_path"],
            target["max_bytes"],
            target["max_variable_bytes"],
            False,
            None,
        )
    except BaseException:  # noqa: BLE001 - never block or crash the shutdown path
        pass


def _positive_int(value: Any, fallback: int) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else fallback


async def _handle_snapshot(req: dict[str, Any], ns: dict[str, Any]) -> None:
    global _last_snapshot_target
    rid = req["id"]
    started = time.monotonic()
    max_bytes = _positive_int(req.get("max_bytes"), _MAX_TOTAL_BYTES)
    max_variable_bytes = _positive_int(req.get("max_variable_bytes"), _MAX_VARIABLE_BYTES)
    committed: list[dict[str, Any]] = []
    try:
        outcome = _snapshot_state(
            ns, req["path"], req["manifest_path"], max_bytes, max_variable_bytes,
            req.get("prune_oversized") is True, committed,
        )
    finally:
        _finish_request(rid)
    duration = int((time.monotonic() - started) * 1000)
    if committed:
        _last_snapshot_target = {
            "path": req["path"],
            "manifest_path": req["manifest_path"],
            "max_bytes": max_bytes,
            "max_variable_bytes": max_variable_bytes,
        }
        _send({"event": "done", "id": rid, "status": "ok", "duration_ms": duration, **committed[0]})
    else:
        _send({
            "event": "done", "id": rid, "status": "error", "duration_ms": duration,
            "reason": outcome.get("error", "snapshot failed"),
        })


async def _handle_restore(req: dict[str, Any], ns: dict[str, Any]) -> None:
    rid = req["id"]
    started = time.monotonic()
    try:
        outcome = _restore_state(ns, req["path"])
    finally:
        _finish_request(rid)
    duration = int((time.monotonic() - started) * 1000)
    if "error" in outcome:
        _send({"event": "done", "id": rid, "status": "error", "duration_ms": duration, "reason": outcome["error"]})
    else:
        _send({"event": "done", "id": rid, "status": "ok", "duration_ms": duration, **outcome})


async def _handle_list_names(req: dict[str, Any], ns: dict[str, Any]) -> None:
    rid = req["id"]
    names = sorted(n for n in ns if not n.startswith("_") and n not in _SNAPSHOT_ALWAYS_SKIP)
    _finish_request(rid)
    _send({"event": "done", "id": rid, "status": "ok", "duration_ms": 0, "names": names})


# ---------------------------------------------------------------------------
# Reader thread and serve loop
# ---------------------------------------------------------------------------

_REQUIRED_STRING_FIELDS = {
    "execute": ("id", "code"),
    "snapshot": ("id", "path", "manifest_path"),
    "restore": ("id", "path"),
    "list_names": ("id",),
}


def _handle_request_line(raw: bytes, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    req = json.loads(raw)
    if not isinstance(req, dict):
        raise ValueError("request is not a JSON object")
    rtype = req.get("type")
    if rtype == "interrupt":
        if "id" in req and not isinstance(req["id"], str):
            _protocol_error("interrupt request id must be a string")
            return
        _request_interrupt(req.get("id"))
        return
    if rtype == "shutdown":
        if "id" in req and not isinstance(req["id"], str):
            _protocol_error("shutdown request id must be a string")
            return
        _loop.call_soon_threadsafe(queue.put_nowait, req)
        return
    if rtype != "execute":
        required = _REQUIRED_STRING_FIELDS.get(rtype)
        if required is None:
            _protocol_error(f"unknown request type: {rtype!r}")
            return
        missing = [f for f in required if not isinstance(req.get(f), str)]
        if missing:
            _protocol_error(f"{rtype} request needs string fields: {', '.join(missing)}")
            return
        if rtype == "snapshot":
            for field in ("max_bytes", "max_variable_bytes"):
                value = req.get(field)
                if value is not None and (not isinstance(value, int) or isinstance(value, bool) or value <= 0):
                    _protocol_error(f"snapshot {field} must be a positive integer")
                    return
            if "prune_oversized" in req and not isinstance(req["prune_oversized"], bool):
                _protocol_error("snapshot prune_oversized must be a boolean")
                return
        if rtype in ("snapshot", "restore"):
            with _interrupt_lock:
                duplicate = req["id"] in _inflight
                if not duplicate:
                    _inflight.add(req["id"])
            if duplicate:
                _protocol_error(f"duplicate in-flight request id: {req['id']!r}")
                return
        _loop.call_soon_threadsafe(queue.put_nowait, req)
        return
    missing = [f for f in _REQUIRED_STRING_FIELDS["execute"] if not isinstance(req.get(f), str)]
    if missing:
        _protocol_error(f"execute request needs string fields: {', '.join(missing)}")
        return
    timeout_ms = req.get("timeout_ms")
    if timeout_ms is not None and (not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool)):
        _protocol_error("execute timeout_ms must be an integer")
        return
    background = req.get("background")
    if background is not None and not isinstance(background, bool):
        _protocol_error("execute background must be a boolean")
        return
    if background is True:
        # Ack on the reader thread so the job id reaches the host even while
        # the loop is busy running a synchronous job or cell. The job itself
        # starts when the loop reaches this queued request.
        job_id = uuid.uuid4().hex
        with _interrupt_lock:
            _inflight.add(job_id)
            _jobs[job_id] = {"task": None, "interrupted": False}
        _send({"event": "done", "id": req["id"], "status": "ok", "duration_ms": 0, "job_id": job_id})
        req["job_id"] = job_id
        _loop.call_soon_threadsafe(queue.put_nowait, req)
        return
    with _interrupt_lock:
        duplicate = req["id"] in _inflight
        if not duplicate:
            _inflight.add(req["id"])
    if duplicate:
        _protocol_error(f"duplicate in-flight request id: {req['id']!r}")
        return
    _loop.call_soon_threadsafe(queue.put_nowait, req)


def _read_requests(stdin_fd: int, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    with os.fdopen(stdin_fd, "rb") as stream:
        for raw in stream:
            raw = raw.strip()
            if not raw:
                continue
            try:
                _handle_request_line(raw, queue)
            except BaseException as err:  # noqa: BLE001
                _protocol_error(f"{type(err).__name__}: {_safe_str(err)}")
    # Host closed stdin: shut down. The driver exits with the server (the owner
    # watchdog covers a server SIGKILL); no snapshot exists in P1.
    _loop.call_soon_threadsafe(queue.put_nowait, {"type": "shutdown", "eof": True})


async def _serve(queue: asyncio.Queue[dict[str, Any]], ns: dict[str, Any]) -> None:
    while True:
        req = await queue.get()
        rtype = req.get("type")
        if rtype == "shutdown":
            if req.get("eof") and _last_snapshot_target is not None:
                # The server died without a graceful dispose; flush the
                # namespace to the last committed target before exit.
                _flush_final_snapshot(ns)
            _kill_all_children()
            rid = req.get("id")
            if isinstance(rid, str):
                _send({"event": "done", "id": rid, "status": "ok", "duration_ms": 0})
            return
        if rtype == "execute":
            job_id = req.get("job_id")
            if isinstance(job_id, str):
                _start_job(job_id, req, ns)
            else:
                await _handle_execute(req, ns)
        elif rtype == "snapshot":
            await _handle_snapshot(req, ns)
        elif rtype == "restore":
            await _handle_restore(req, ns)
        elif rtype == "list_names":
            await _handle_list_names(req, ns)
        else:
            _protocol_error(f"unknown request type: {rtype!r}")


def _make_namespace() -> dict[str, Any]:
    user_module = types.ModuleType("__main__")
    user_module.__dict__["__builtins__"] = builtins
    user_module.__dict__["emit"] = emit
    sys.modules["__main__"] = user_module
    return user_module.__dict__


def main() -> None:
    global _loop, _serve_task, _kernel_dir
    _kernel_dir = os.environ.get("PORRIMA_KERNEL_DIR") or None

    stdin_fd = _setup_fds()
    _install_popen_patch()
    _boot_self_heal()
    _start_owner_watchdog()

    ns = _make_namespace()
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    signal.signal(signal.SIGINT, _sigint_handler)
    threading.Thread(target=_read_requests, args=(stdin_fd, queue), daemon=True).start()
    _send({"event": "ready", "protocol": PROTOCOL_VERSION, "python": sys.version.split()[0], "driver": _driver_hash()})
    _serve_task = _loop.create_task(_serve(queue, ns))
    while not _serve_task.done():
        try:
            _loop.run_until_complete(_serve_task)
        except KeyboardInterrupt:
            continue
    os._exit(0)


if __name__ == "__main__":
    main()
