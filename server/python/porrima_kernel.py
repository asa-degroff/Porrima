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
import inspect
import io
import json
import linecache
import os
import select
import signal
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
    with _interrupt_lock:
        rid = _active["rid"]
        if rid is not None and (target is None or target == rid):
            _sigint_target = rid
        elif _finishing_rid is not None and (target is None or target == _finishing_rid):
            _sigint_target = _finishing_rid
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
    # L2: if the cell has not settled after the grace window, cancel its task
    # (delivered at the next suspension) and kill its tracked child groups
    # (which also unblocks sync waits).
    if target is not None:
        _schedule_escalation(target)


def _schedule_escalation(rid: str) -> None:
    def escalate() -> None:
        with _interrupt_lock:
            active = _active["rid"] == rid and _active["task"] is not None and not _active["task"].done()
            finishing = _finishing_rid == rid
        if not (active or finishing):
            return
        if _loop is not None:
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


async def _run_guarded(task: asyncio.Task[Any], rid: str) -> tuple[str, Any, dict[str, Any] | None]:
    with _interrupt_lock:
        _active["interrupted"] = False
        _active["rid"] = rid
        _active["task"] = task
        if _consume_pending_interrupt(rid):
            _active["interrupted"] = True
            task.cancel()
    try:
        value = await task
        return "ok", value, None
    except asyncio.CancelledError as exc:
        if _active["interrupted"]:
            return "error", None, _interrupt_event(rid, exc)
        return "error", None, _error_event(rid, exc)
    except BaseException as exc:  # noqa: BLE001 - every cell failure becomes an error event
        return "error", None, _error_event(rid, exc)
    finally:
        with _interrupt_lock:
            global _finishing_rid
            _finishing_rid = rid
            _active["task"] = None
            _active["rid"] = None


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
        status, value, error = await _run_guarded(task, cell_id)
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
# Reader thread and serve loop
# ---------------------------------------------------------------------------

_REQUIRED_STRING_FIELDS = {"execute": ("id", "code")}


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
        _protocol_error(f"unknown request type: {rtype!r}")
        return
    missing = [f for f in _REQUIRED_STRING_FIELDS["execute"] if not isinstance(req.get(f), str)]
    if missing:
        _protocol_error(f"execute request needs string fields: {', '.join(missing)}")
        return
    timeout_ms = req.get("timeout_ms")
    if timeout_ms is not None and (not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool)):
        _protocol_error("execute timeout_ms must be an integer")
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
            _kill_all_children()
            rid = req.get("id")
            if isinstance(rid, str):
                _send({"event": "done", "id": rid, "status": "ok", "duration_ms": 0})
            return
        if rtype == "execute":
            await _handle_execute(req, ns)
        else:
            _protocol_error(f"unknown request type: {rtype!r}")


def _make_namespace() -> dict[str, Any]:
    user_module = types.ModuleType("__main__")
    user_module.__dict__["__builtins__"] = builtins
    sys.modules["__main__"] = user_module
    return user_module.__dict__


def main() -> None:
    global _loop, _serve_task, _kernel_dir
    _kernel_dir = os.environ.get("PORRIMA_KERNEL_DIR") or None

    stdin_fd = _setup_fds()
    _install_popen_patch()
    _start_owner_watchdog()

    ns = _make_namespace()
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    signal.signal(signal.SIGINT, _sigint_handler)
    threading.Thread(target=_read_requests, args=(stdin_fd, queue), daemon=True).start()
    _send({"event": "ready", "protocol": PROTOCOL_VERSION, "python": sys.version.split()[0]})
    _serve_task = _loop.create_task(_serve(queue, ns))
    while not _serve_task.done():
        try:
            _loop.run_until_complete(_serve_task)
        except KeyboardInterrupt:
            continue
    os._exit(0)


if __name__ == "__main__":
    main()
