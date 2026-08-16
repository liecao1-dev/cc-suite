#!/usr/bin/env python3
"""TTY-preserving pre-send dispatcher selector for stock Codex and Claude CLIs."""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import subprocess
import sys
import termios
import tty
import uuid


HOSTS = {
    "codex": {"trigger": b"$claude", "target": "claude"},
    "claude": {"trigger": b"/codex", "target": "codex"},
}


class ComposerInput:
    """Track enough composer editing to recognize one exact local selection."""

    def __init__(self, trigger: bytes) -> None:
        self.trigger = trigger
        self.text = bytearray()
        self.cursor = 0
        self.escape = bytearray()
        # Stock Codex/Claude completion menus start on their first row. Keep a
        # small local mirror so a longer prefix match (for example
        # $claude-workflow-sync) is never mistaken for the exact dispatcher
        # after the user moves the highlight away from row zero.
        self.menu_index: int | None = 0

    def clear(self) -> None:
        self.text.clear()
        self.cursor = 0
        self.escape.clear()
        self.menu_index = 0

    def _escape_complete(self) -> bool:
        if len(self.escape) < 2:
            return False
        if self.escape[1] == ord("["):
            return len(self.escape) >= 3 and 0x40 <= self.escape[-1] <= 0x7E
        if self.escape[1] == ord("]"):
            return self.escape[-1] == 0x07 or self.escape.endswith(b"\x1b\\")
        return True

    def _apply_escape(self) -> None:
        value = bytes(self.escape)
        if value == b"\x1b[A" and bytes(self.text) == self.trigger:
            # Codex wraps Up from the first row to the last. The row count is
            # owned by the host and can change as other skills are installed,
            # so represent that position as unknown rather than risking a
            # false dispatch. One Down from the wrapped last row returns to 0.
            self.menu_index = None if self.menu_index == 0 else (
                self.menu_index - 1 if self.menu_index is not None else None
            )
        elif value == b"\x1b[B" and bytes(self.text) == self.trigger:
            self.menu_index = 0 if self.menu_index is None else self.menu_index + 1
        elif value == b"\x1b[D":
            self.cursor = max(0, self.cursor - 1)
        elif value == b"\x1b[C":
            self.cursor = min(len(self.text), self.cursor + 1)
        elif value in {b"\x1b[H", b"\x1b[1~"}:
            self.cursor = 0
        elif value in {b"\x1b[F", b"\x1b[4~"}:
            self.cursor = len(self.text)
        elif value == b"\x1b[3~" and self.cursor < len(self.text):
            del self.text[self.cursor]
        self.escape.clear()

    def _insert(self, value: int) -> None:
        self.text[self.cursor:self.cursor] = bytes([value])
        self.cursor += 1
        self.menu_index = 0
        if len(self.text) > 4096:
            self.clear()

    def feed(self, data: bytes) -> tuple[bytes, bool]:
        forwarded = bytearray()
        triggered = False
        for value in data:
            if self.escape:
                self.escape.append(value)
                forwarded.append(value)
                if self._escape_complete():
                    self._apply_escape()
                continue
            if value == 0x1B:
                self.escape.append(value)
                forwarded.append(value)
                continue
            if value in (0x0D, 0x0A, 0x09):
                if (
                    not triggered
                    and bytes(self.text) == self.trigger
                    and self.menu_index == 0
                ):
                    triggered = True
                    self.clear()
                    continue
                forwarded.append(value)
                if value in (0x0D, 0x0A):
                    self.clear()
                continue
            forwarded.append(value)
            if value in (0x7F, 0x08):
                if self.cursor:
                    self.cursor -= 1
                    del self.text[self.cursor]
                self.menu_index = 0
            elif value == 0x15:  # Ctrl-U
                self.clear()
            elif value == 0x17:  # Ctrl-W
                while self.cursor and self.text[self.cursor - 1:self.cursor] == b" ":
                    self.cursor -= 1
                    del self.text[self.cursor]
                while self.cursor and self.text[self.cursor - 1:self.cursor] != b" ":
                    self.cursor -= 1
                    del self.text[self.cursor]
                self.menu_index = 0
            elif value == 0x01:  # Ctrl-A
                self.cursor = 0
            elif value == 0x05:  # Ctrl-E
                self.cursor = len(self.text)
            elif value == 0x03:  # Ctrl-C
                self.clear()
            elif value >= 0x20:
                self._insert(value)
        return bytes(forwarded), triggered


def _inside(scope: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(scope)
        return True
    except ValueError:
        return False


def _copy_window_size(source_fd: int, target_fd: int) -> None:
    try:
        size = fcntl.ioctl(source_fd, termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(target_fd, termios.TIOCSWINSZ, size)
    except OSError:
        pass


def _signal_group(pid: int, sig: signal.Signals) -> None:
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def _effective_workspace(host: str, child_argv: list[str], launch_cwd: Path) -> Path:
    """Resolve the workspace selected by the host CLI before scope checks."""

    if host != "codex":
        return launch_cwd

    requested: str | None = None
    index = 0
    while index < len(child_argv):
        value = child_argv[index]
        if value == "--":
            break
        if value in {"-C", "--cd"}:
            if index + 1 < len(child_argv):
                requested = child_argv[index + 1]
                index += 2
                continue
        elif value.startswith("--cd="):
            requested = value.split("=", 1)[1]
        elif value.startswith("-C") and len(value) > 2:
            requested = value[2:]
        index += 1

    if not requested:
        return launch_cwd
    candidate = Path(requested).expanduser()
    if not candidate.is_absolute():
        candidate = launch_cwd / candidate
    return candidate.resolve()


def _selector_command(
    args: argparse.Namespace,
    session_id: str,
    workspace_cwd: Path,
) -> list[str]:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node not found on PATH")
    target = HOSTS[args.host]["target"]
    return [
        node,
        str(args.source / "scripts" / "dispatch-select.mjs"),
        "--host",
        args.host,
        "--target",
        target,
        "--cwd",
        str(workspace_cwd),
        "--session-id",
        session_id,
    ]


def _run_selector(
    args: argparse.Namespace,
    session_id: str,
    workspace_cwd: Path,
) -> tuple[dict | None, str | None]:
    env = os.environ.copy()
    env["CC_SUITE_COMPOSER_BYPASS"] = "1"
    completed = subprocess.run(
        _selector_command(args, session_id, workspace_cwd),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        message = completed.stderr.strip() or f"selector exited {completed.returncode}"
        return None, message
    try:
        line = next(line for line in reversed(completed.stdout.splitlines()) if line.strip())
        return json.loads(line), None
    except (StopIteration, json.JSONDecodeError) as error:
        return None, f"invalid selector result: {error}"


def _show_transient_error(message: str) -> None:
    safe = " ".join(message.splitlines())[:240]
    try:
        os.write(sys.stdout.fileno(), f"\x1b[2J\x1b[Hcc-suite 配置失败：{safe}\r\n".encode())
    except OSError:
        pass


def _wait_status(pid: int) -> int:
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        return 0
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


def _run_proxy(
    args: argparse.Namespace,
    child_argv: list[str],
    workspace_cwd: Path,
) -> int:
    session_id = uuid.uuid4().hex
    child_env = os.environ.copy()
    child_env["CC_SUITE_COMPOSER_SESSION"] = session_id
    child_env["CC_SUITE_COMPOSER_HOST"] = args.host
    child_env["CC_SUITE_COMPOSER_SCOPE"] = str(args.scope)

    pid, master_fd = pty.fork()
    if pid == 0:
        os.execve(str(args.real_binary), [str(args.real_binary), *child_argv], child_env)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    original_tty = termios.tcgetattr(stdin_fd)
    tracker = ComposerInput(HOSTS[args.host]["trigger"])
    stopping = False

    def resize(_signum=None, _frame=None) -> None:
        _copy_window_size(stdin_fd, master_fd)
        try:
            os.kill(pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    def terminate(signum, _frame) -> None:
        nonlocal stopping
        stopping = True
        _signal_group(pid, signal.Signals(signum))

    previous_winch = signal.signal(signal.SIGWINCH, resize)
    previous_term = signal.signal(signal.SIGTERM, terminate)
    previous_hup = signal.signal(signal.SIGHUP, terminate)
    resize()
    tty.setraw(stdin_fd)
    child_open = True
    try:
        while child_open and not stopping:
            readable, _, _ = select.select([stdin_fd, master_fd], [], [])
            if master_fd in readable:
                try:
                    output = os.read(master_fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        child_open = False
                        continue
                    raise
                if not output:
                    child_open = False
                else:
                    os.write(stdout_fd, output)
            if stdin_fd in readable and child_open:
                data = os.read(stdin_fd, 4096)
                if not data:
                    break
                forwarded, triggered = tracker.feed(data)
                if forwarded:
                    os.write(master_fd, forwarded)
                if not triggered:
                    continue

                _signal_group(pid, signal.SIGSTOP)
                result, error = _run_selector(args, session_id, workspace_cwd)
                try:
                    os.write(master_fd, b"\x7f" * len(HOSTS[args.host]["trigger"]))
                except OSError:
                    child_open = False
                tracker.clear()
                _signal_group(pid, signal.SIGCONT)
                resize()
                if error:
                    _show_transient_error(error)
                elif result and result.get("status") == "selected":
                    # The picker already showed the exact tuple. SIGWINCH asks the stock
                    # TUI to redraw its composer with the local trigger removed.
                    pass
    finally:
        termios.tcsetattr(stdin_fd, termios.TCSADRAIN, original_tty)
        signal.signal(signal.SIGWINCH, previous_winch)
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGHUP, previous_hup)
        try:
            os.close(master_fd)
        except OSError:
            pass
        if child_open:
            _signal_group(pid, signal.SIGTERM)
    return _wait_status(pid)


def _probe_input() -> int:
    payload = json.load(sys.stdin)
    host = payload["host"]
    tracker = ComposerInput(HOSTS[host]["trigger"])
    forwarded = []
    triggers = 0
    for chunk in payload.get("chunks", []):
        output, triggered = tracker.feed(chunk.encode("utf-8"))
        forwarded.append(output.decode("utf-8", errors="replace"))
        triggers += int(triggered)
    json.dump(
        {
            "forwarded": forwarded,
            "triggers": triggers,
            "buffer": bytes(tracker.text).decode("utf-8", errors="replace"),
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


def _probe_cwd() -> int:
    payload = json.load(sys.stdin)
    launch_cwd = Path(payload["cwd"]).expanduser().resolve()
    workspace = _effective_workspace(
        payload["host"],
        payload.get("argv", []),
        launch_cwd,
    )
    json.dump({"workspace": str(workspace)}, sys.stdout)
    sys.stdout.write("\n")
    return 0


def _parse_args(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--host", choices=sorted(HOSTS), required=True)
    parser.add_argument("--scope", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--real-binary", type=Path, required=True)
    parser.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    child_argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
    args.scope = args.scope.resolve(strict=True)
    args.source = args.source.resolve(strict=True)
    args.real_binary = args.real_binary.resolve(strict=True)
    return args, child_argv


def main(argv: list[str]) -> int:
    if argv == ["--probe-input"]:
        return _probe_input()
    if argv == ["--probe-cwd"]:
        return _probe_cwd()
    args, child_argv = _parse_args(argv)
    launch_cwd = Path.cwd().resolve()
    workspace_cwd = _effective_workspace(args.host, child_argv, launch_cwd)
    if (
        os.environ.get("CC_SUITE_COMPOSER_BYPASS") == "1"
        or not _inside(args.scope, workspace_cwd)
        or not sys.stdin.isatty()
        or not sys.stdout.isatty()
    ):
        os.execve(
            str(args.real_binary),
            [str(args.real_binary), *child_argv],
            os.environ.copy(),
        )
    return _run_proxy(args, child_argv, workspace_cwd)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, RuntimeError) as error:
        sys.stderr.write(f"cc-suite composer proxy: {error}\n")
        raise SystemExit(1)
