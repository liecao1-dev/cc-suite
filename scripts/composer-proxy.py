#!/usr/bin/env python3
"""TTY-preserving pre-send dispatcher selector for stock Codex and Claude CLIs."""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import secrets
import shutil
import signal
import subprocess
import sys
import termios
import time
import tty
import uuid


HOSTS = {
    "codex": {"trigger": b"$claude", "target": "claude"},
    "claude": {"trigger": b"/codex", "target": "codex"},
}

CONTROL_PROMPT = re.compile(r"^[/\$][A-Za-z][A-Za-z0-9_-]*(?:\s|$)")
HOOK_STATE_TABLE = re.compile(
    r'^\[hooks\.state\.("(?:[^"\\]|\\.)*")\]\s*(?:#.*)?$'
)
TOML_ASSIGNMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*(?:#.*)?$")
DEFAULT_HOOK_TIMEOUT_SEC = 600
DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2500
MAX_DIRECT_INFERENCE_BYTES = 64 * 1024 * 1024
MANAGED_CODEX_SKILL_MARKER = re.compile(
    r"^<!-- cc-suite-managed-codex-skill sha256=([0-9a-f]{64}) -->$",
    re.MULTILINE,
)


def _source_plugin_name(source_root: Path) -> str | None:
    """Read the namespace Codex may add to an installed plugin skill."""

    for relative in (
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        "package.json",
    ):
        try:
            payload = json.loads((source_root / relative).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, AttributeError):
            continue
        name = payload.get("name") if isinstance(payload, dict) else None
        if isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name):
            return name
    return None


def _host_triggers(host: str, source_root: Path) -> tuple[bytes, ...]:
    canonical = HOSTS[host]["trigger"]
    triggers = [canonical]
    if host == "codex":
        plugin_name = _source_plugin_name(source_root)
        if plugin_name:
            # Newer Codex releases render plugin skills with their namespace.
            # Derive it from the installed source instead of a CLI version or
            # a hard-coded cc-suite name so package renames remain compatible.
            triggers.append(f"${plugin_name}:claude".encode("utf-8"))
    return tuple(dict.fromkeys(triggers))


class ComposerInput:
    """Track enough composer editing to recognize one exact local selection."""

    def __init__(self, triggers: tuple[bytes, ...]) -> None:
        self.triggers = triggers
        self.text = bytearray()
        self.cursor = 0
        self.escape = bytearray()
        self.submissions: list[bytes] = []
        self.pending_prefix: bytes | None = None
        self.prefix_visible = False
        # Stock Codex/Claude completion menus start on their first row. Keep a
        # small local mirror so a longer prefix match (for example
        # $claude-workflow-sync) is never mistaken for the exact dispatcher
        # after the user moves the highlight away from row zero.
        self.menu_index: int | None = 0

    def _matched_trigger(self) -> bytes | None:
        value = bytes(self.text)
        return value if value in self.triggers else None

    def clear(self) -> None:
        self.text.clear()
        self.cursor = 0
        self.escape.clear()
        self.menu_index = 0

    def arm_prefix(self, value: str) -> bytes:
        """Arm a visual prefix that lives in the host composer only.

        The proxy never adds this prefix to ``text``. On submission it clears
        the host composer and replays only ``text``, so hooks and models receive
        the user's task without the UI marker.
        """

        self.clear()
        self.pending_prefix = value.encode("utf-8")
        self.prefix_visible = True
        return self.pending_prefix

    def disarm_prefix(self) -> None:
        self.pending_prefix = None
        self.prefix_visible = False

    def _restore_prefix(self) -> bytes:
        if not self.pending_prefix:
            return b""
        self.prefix_visible = True
        return self.pending_prefix

    def _previous_character(self, cursor: int | None = None) -> int:
        index = self.cursor if cursor is None else cursor
        if index <= 0:
            return 0
        index -= 1
        while index > 0 and self.text[index] & 0xC0 == 0x80:
            index -= 1
        return index

    def _next_character(self, cursor: int | None = None) -> int:
        index = self.cursor if cursor is None else cursor
        if index >= len(self.text):
            return len(self.text)
        index += 1
        while index < len(self.text) and self.text[index] & 0xC0 == 0x80:
            index += 1
        return index

    def _escape_complete(self) -> bool:
        if len(self.escape) < 2:
            return False
        if self.escape[1] == ord("["):
            return len(self.escape) >= 3 and 0x40 <= self.escape[-1] <= 0x7E
        if self.escape[1] == ord("]"):
            return self.escape[-1] == 0x07 or self.escape.endswith(b"\x1b\\")
        return True

    def _apply_escape(self) -> bytes:
        value = bytes(self.escape)
        forwarded = value
        if value == b"\x1b[A" and self._matched_trigger() is not None:
            # Codex wraps Up from the first row to the last. The row count is
            # owned by the host and can change as other skills are installed,
            # so represent that position as unknown rather than risking a
            # false dispatch. One Down from the wrapped last row returns to 0.
            self.menu_index = None if self.menu_index == 0 else (
                self.menu_index - 1 if self.menu_index is not None else None
            )
        elif value == b"\x1b[B" and self._matched_trigger() is not None:
            self.menu_index = 0 if self.menu_index is None else self.menu_index + 1
        elif value == b"\x1b[D":
            if self.pending_prefix and self.prefix_visible and self.cursor == 0:
                forwarded = b""
            else:
                self.cursor = self._previous_character()
        elif value == b"\x1b[C":
            self.cursor = self._next_character()
        elif value in {b"\x1b[H", b"\x1b[1~"}:
            self.cursor = 0
            if self.pending_prefix and self.prefix_visible:
                prefix_characters = len(self.pending_prefix.decode("utf-8", errors="replace"))
                forwarded = b"\x01" + (b"\x1b[C" * prefix_characters)
        elif value in {b"\x1b[F", b"\x1b[4~"}:
            self.cursor = len(self.text)
        elif value == b"\x1b[3~" and self.cursor < len(self.text):
            del self.text[self.cursor:self._next_character()]
        elif value in {b"\x1b[A", b"\x1b[B"} and self.pending_prefix and self.prefix_visible:
            # History replacement would erase or duplicate the protected UI
            # marker. Control commands temporarily hide the marker first, so
            # their own menus still receive Up/Down normally.
            forwarded = b""
        self.escape.clear()
        return forwarded

    def flush_escape(self) -> bytes:
        """Forward a standalone Esc after the short sequence wait expires."""

        value = bytes(self.escape)
        self.escape.clear()
        return value

    def _insert(self, value: int) -> None:
        self.text[self.cursor:self.cursor] = bytes([value])
        self.cursor += 1
        self.menu_index = 0
        if len(self.text) > 4096:
            self.clear()

    def feed(self, data: bytes) -> tuple[bytes, bytes | None]:
        forwarded = bytearray()
        triggered: bytes | None = None
        self.submissions = []
        for value in data:
            if self.escape:
                self.escape.append(value)
                if self._escape_complete():
                    forwarded.extend(self._apply_escape())
                continue
            if value == 0x1B:
                self.escape.append(value)
                continue
            if value in (0x0D, 0x0A, 0x09):
                matched_trigger = self._matched_trigger()
                if not triggered and matched_trigger and self.menu_index == 0:
                    triggered = matched_trigger
                    self.disarm_prefix()
                    self.clear()
                    continue
                if value in (0x0D, 0x0A):
                    submission = bytes(self.text)
                    self.submissions.append(submission)
                    if self.pending_prefix:
                        # Clear the visual prefix and any host-side editing,
                        # replay only the tracked task, then submit exactly once.
                        forwarded.extend(b"\x15")
                        forwarded.extend(submission)
                        self.prefix_visible = False
                    forwarded.append(value)
                    self.clear()
                else:
                    forwarded.append(value)
                continue
            if value in (0x7F, 0x08):
                if self.cursor:
                    start = self._previous_character()
                    del self.text[start:self.cursor]
                    self.cursor = start
                    forwarded.append(value)
                    if (
                        self.pending_prefix
                        and not self.prefix_visible
                        and not self.text
                    ):
                        forwarded.extend(self._restore_prefix())
                elif not (self.pending_prefix and self.prefix_visible):
                    forwarded.append(value)
                self.menu_index = 0
            elif value == 0x15:  # Ctrl-U
                self.clear()
                forwarded.append(value)
                if self.pending_prefix:
                    forwarded.extend(self._restore_prefix())
            elif value == 0x17:  # Ctrl-W
                if self.cursor:
                    while self.cursor and self.text[self._previous_character():self.cursor] == b" ":
                        start = self._previous_character()
                        del self.text[start:self.cursor]
                        self.cursor = start
                    while self.cursor and self.text[self._previous_character():self.cursor] != b" ":
                        start = self._previous_character()
                        del self.text[start:self.cursor]
                        self.cursor = start
                    forwarded.append(value)
                    if (
                        self.pending_prefix
                        and not self.prefix_visible
                        and not self.text
                    ):
                        forwarded.extend(self._restore_prefix())
                elif not (self.pending_prefix and self.prefix_visible):
                    forwarded.append(value)
                self.menu_index = 0
            elif value == 0x01:  # Ctrl-A
                self.cursor = 0
                if self.pending_prefix and self.prefix_visible:
                    prefix_characters = len(self.pending_prefix.decode("utf-8", errors="replace"))
                    forwarded.extend(b"\x01" + (b"\x1b[C" * prefix_characters))
                else:
                    forwarded.append(value)
            elif value == 0x05:  # Ctrl-E
                self.cursor = len(self.text)
                forwarded.append(value)
            elif value == 0x03:  # Ctrl-C
                self.clear()
                if self.pending_prefix:
                    forwarded.extend(b"\x15")
                    forwarded.extend(self._restore_prefix())
                else:
                    forwarded.append(value)
            elif value >= 0x20:
                if self.pending_prefix and not self.text:
                    if self.prefix_visible and value in (ord("/"), ord("$")):
                        # Let native command/skill completion see its sigil in
                        # column zero. The pending selection remains armed and
                        # returns when ordinary typing resumes.
                        forwarded.append(0x15)
                        self.prefix_visible = False
                    elif not self.prefix_visible and value not in (ord("/"), ord("$")):
                        forwarded.extend(self._restore_prefix())
                forwarded.append(value)
                self._insert(value)
        return bytes(forwarded), triggered


def _inside(scope: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(scope)
        return True
    except ValueError:
        return False


def _submission_write_plan(
    forwarded: bytes,
    *,
    has_submission: bool,
    pending_prefix: bool,
) -> list[bytes]:
    """Keep a replayed task and its submit key in separate PTY writes.

    Stock Codex can treat ``Ctrl-U + task + Enter`` received in one PTY read as
    an edit whose trailing Enter is lost. The tiny separation below lets the
    composer commit the replayed task before it receives the real submit key.
    """

    if (
        has_submission
        and pending_prefix
        and forwarded[-1:] in {b"\r", b"\n"}
    ):
        return [forwarded[:-1], forwarded[-1:]]
    return [forwarded] if forwarded else []


def _active_project_root(scope: Path, workspace_cwd: Path) -> Path:
    """Resolve the project used only for local selector discovery artifacts."""
    completed = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=workspace_cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if completed.returncode == 0 and completed.stdout.strip():
        candidate = Path(completed.stdout.strip()).resolve()
        if _inside(scope, candidate):
            return candidate
    return workspace_cwd


def _managed_codex_skill_ready(skill_file: Path) -> bool:
    try:
        text = skill_file.read_text(encoding="utf-8")
    except OSError:
        return False
    match = MANAGED_CODEX_SKILL_MARKER.search(text)
    if match is None:
        return False
    marker_end = match.end()
    if text[marker_end:marker_end + 1] == "\n":
        marker_end += 1
    body = text[:match.start()] + text[marker_end:]
    return hashlib.sha256(body.encode("utf-8")).hexdigest() == match.group(1)


def _workspace_dispatch_ready(project_root: Path, source_root: Path) -> bool:
    claude_skill = project_root / ".agents" / "skills" / "claude"
    codex_skill = project_root / ".claude" / "skills" / "codex" / "SKILL.md"
    try:
        return (
            claude_skill.is_symlink()
            and claude_skill.resolve(strict=True)
            == (source_root / "skills" / "cc-suite" / "claude").resolve(strict=True)
            and codex_skill.is_file()
            and _managed_codex_skill_ready(codex_skill)
        )
    except OSError:
        return False


def _with_runtime_access(args: argparse.Namespace, child_argv: list[str]) -> list[str]:
    """Grant an in-scope interactive host access only to centralized state."""

    runtime_path = args.scope / ".cc-suite" / "runtime"
    for candidate in (runtime_path.parent, runtime_path):
        stat = candidate.lstat()
        if candidate.is_symlink() or not candidate.is_dir():
            raise RuntimeError(f"{candidate} is not a real cc-suite directory")
    resolved_runtime = runtime_path.resolve(strict=True)
    if not _inside(args.scope, resolved_runtime):
        raise RuntimeError("cc-suite runtime resolves outside the configured scope")
    runtime = str(resolved_runtime)
    for index, value in enumerate(child_argv):
        if value == "--add-dir" and index + 1 < len(child_argv):
            try:
                if str(Path(child_argv[index + 1]).expanduser().resolve(strict=True)) == runtime:
                    return child_argv
            except OSError:
                pass
        elif value.startswith("--add-dir="):
            try:
                if str(Path(value.split("=", 1)[1]).expanduser().resolve(strict=True)) == runtime:
                    return child_argv
            except OSError:
                pass
    # Codex defines --add-dir as a root option, so it must precede `exec`,
    # `resume`, `login`, and every other subcommand. Claude accepts it with the
    # rest of its top-level options before the prompt delimiter.
    insertion = 0 if args.host == "codex" else (
        child_argv.index("--") if "--" in child_argv else len(child_argv)
    )
    return [
        *child_argv[:insertion],
        "--add-dir",
        runtime,
        *child_argv[insertion:],
    ]


def _ensure_workspace_dispatch(
    args: argparse.Namespace,
    workspace_cwd: Path,
) -> str | None:
    project_root = _active_project_root(args.scope, workspace_cwd)
    if _workspace_dispatch_ready(project_root, args.source):
        return None
    node = shutil.which("node")
    if not node:
        return "node not found on PATH; current workspace dispatch files could not be prepared"
    env = os.environ.copy()
    env["CC_SUITE_COMPOSER_BYPASS"] = "1"
    env["CC_SUITE_SCOPE_ROOT"] = str(args.scope)
    env["CC_SUITE_WORKSPACE_ROOT"] = str(project_root)
    env["CLAUDE_PLUGIN_DATA"] = str(args.scope / ".cc-suite" / "runtime")
    completed = subprocess.run(
        [
            node,
            str(args.source / "scripts" / "sync-projects.mjs"),
            "sync",
            "--scope", str(args.scope),
            "--project", str(project_root),
            "--source", str(args.source),
            "--json",
        ],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode == 0 and _workspace_dispatch_ready(project_root, args.source):
        return None
    detail = completed.stderr.strip()
    if not detail:
        try:
            payload = json.loads(completed.stdout)
            conflicts = [
                conflict
                for result in payload.get("results", [])
                for conflict in result.get("conflicts", [])
                if isinstance(result, dict)
            ]
            detail = "; ".join(conflicts)
        except (json.JSONDecodeError, AttributeError):
            detail = completed.stdout.strip()
    detail = " ".join(detail.splitlines())[:240] or "project sync did not create the selector discovery files"
    return f"current workspace dispatch setup failed: {detail}"


def _codex_profile_name(child_argv: list[str]) -> str | None:
    profile: str | None = None
    index = 0
    while index < len(child_argv):
        value = child_argv[index]
        if value == "--":
            break
        if value in {"--profile", "-p"}:
            if index + 1 < len(child_argv):
                profile = child_argv[index + 1]
                index += 2
                continue
        elif value.startswith("--profile="):
            profile = value.split("=", 1)[1]
        elif value.startswith("-p") and len(value) > 2:
            profile = value[2:]
        index += 1
    if profile and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", profile):
        return profile
    return None


def _codex_config_files(child_argv: list[str], codex_home: Path | None = None) -> list[Path]:
    if codex_home is None:
        configured = os.environ.get("CODEX_HOME")
        codex_home = Path(configured).expanduser() if configured else Path.home() / ".codex"
    files = [codex_home / "config.toml"]
    profile = _codex_profile_name(child_argv)
    if profile:
        files.append(codex_home / f"{profile}.config.toml")
    return files


def _canonical_sha256(value: object) -> str:
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(serialized).hexdigest()}"


def _normalized_codex_command_handler(handler: dict) -> dict | None:
    command = handler.get("command")
    if handler.get("type") != "command" or not isinstance(command, str) or not command.strip():
        return None
    timeout = handler.get("timeout")
    if not isinstance(timeout, int) or isinstance(timeout, bool):
        timeout = DEFAULT_HOOK_TIMEOUT_SEC
    normalized: dict[str, object] = {
        "type": "command",
        "command": command,
        "timeout": max(1, timeout),
        "async": bool(handler.get("async", False)),
    }
    status_message = handler.get("statusMessage")
    if isinstance(status_message, str):
        normalized["statusMessage"] = status_message
    context_limit = handler.get("additionalContextLimit")
    if (
        isinstance(context_limit, int)
        and not isinstance(context_limit, bool)
        and context_limit != DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT
    ):
        normalized["additionalContextLimit"] = max(0, context_limit)
    return normalized


def _codex_dispatch_hook_identity(
    scope_root: Path,
    codex_home: Path | None = None,
) -> tuple[str, str] | None:
    if codex_home is None:
        configured = os.environ.get("CODEX_HOME")
        codex_home = Path(configured).expanduser() if configured else Path.home() / ".codex"
    hook_file = (codex_home / "hooks.json").resolve()
    try:
        payload = json.loads(hook_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, AttributeError):
        return None
    groups = payload.get("hooks", {}).get("UserPromptSubmit", [])
    if not isinstance(groups, list):
        return None
    stable_launcher = str((scope_root / ".cc-suite" / "bin" / "cc-suite-dispatch-hook").resolve())
    expected_command = (
        "'" + stable_launcher.replace("'", "'\"'\"'") + "' --host codex --target claude"
    )
    for group_index, group in enumerate(groups):
        if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
            continue
        for handler_index, handler in enumerate(group["hooks"]):
            if not isinstance(handler, dict):
                continue
            command = handler.get("command")
            if (
                not isinstance(command, str)
                or command != expected_command
            ):
                continue
            normalized = _normalized_codex_command_handler(handler)
            if not normalized:
                return None
            identity = {
                "event_name": "user_prompt_submit",
                "hooks": [normalized],
            }
            key = f"{hook_file}:user_prompt_submit:{group_index}:{handler_index}"
            return key, _canonical_sha256(identity)
    return None


def _decode_toml_string(value: str) -> str | None:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, str) else None


def _hook_state_from_toml(text: str, wanted_key: str) -> dict[str, object]:
    state: dict[str, object] = {}
    active = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        table = HOOK_STATE_TABLE.match(line)
        if table:
            active = _decode_toml_string(table.group(1)) == wanted_key
            continue
        if line.startswith("["):
            active = False
            continue
        if not active:
            continue
        assignment = TOML_ASSIGNMENT.match(line)
        if not assignment:
            continue
        name, raw_value = assignment.groups()
        if name == "trusted_hash":
            decoded = _decode_toml_string(raw_value)
            if decoded is not None:
                state[name] = decoded
        elif name == "enabled" and raw_value in {"true", "false"}:
            state[name] = raw_value == "true"
    return state


def _codex_dispatch_hook_ready(
    scope_root: Path,
    child_argv: list[str],
    codex_home: Path | None = None,
) -> tuple[bool, str]:
    identity = _codex_dispatch_hook_identity(scope_root, codex_home)
    if not identity:
        return False, "user-level Codex dispatch hook is missing or malformed"
    key, current_hash = identity
    state: dict[str, object] = {}
    for config_file in _codex_config_files(child_argv, codex_home):
        try:
            state.update(_hook_state_from_toml(
                config_file.read_text(encoding="utf-8"),
                key,
            ))
        except OSError:
            continue
    if state.get("enabled") is False:
        return False, "user-level Codex dispatch hook is disabled in /hooks"
    if state.get("trusted_hash") != current_hash:
        return False, (
            "user-level Codex dispatch hook is not trusted for its fixed definition; "
            "open /hooks, review it, and press t to trust only that hook"
        )
    return True, ""


def _copy_window_size(source_fd: int, target_fd: int) -> None:
    try:
        size = fcntl.ioctl(source_fd, termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(target_fd, termios.TIOCSWINSZ, size)
    except OSError:
        pass


def _one_line(value: object) -> str:
    return " ".join(
        "".join(character if ord(character) >= 0x20 and ord(character) != 0x7F else " "
                for character in str(value)).split()
    )


def _pending_composer_prefix(result: dict) -> str:
    target = "Codex" if result.get("target") == "codex" else "Claude"
    description = _one_line(result.get("description", ""))
    if not description:
        config = result.get("config") if isinstance(result.get("config"), dict) else {}
        values = [
            config.get("model"),
            config.get("effort"),
            config.get("access"),
            config.get("approval"),
        ]
        description = " · ".join(_one_line(value) for value in values if value)
    return f"[{target} · {description}] "


def _is_control_submission(value: bytes) -> bool:
    text = value.decode("utf-8", errors="replace").strip()
    return not text or CONTROL_PROMPT.match(text) is not None


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
    env["CC_SUITE_SCOPE_ROOT"] = str(args.scope)
    env["CC_SUITE_WORKSPACE_ROOT"] = str(_active_project_root(args.scope, workspace_cwd))
    env["CLAUDE_PLUGIN_DATA"] = str(args.scope / ".cc-suite" / "runtime")
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


def _claude_oauth_status(args: argparse.Namespace, timeout: float = 10) -> tuple[dict | None, str | None]:
    command = getattr(args, "oauth_probe_command", None)
    if not command:
        node = shutil.which("node")
        if not node:
            return None, "node not found on PATH; 无法检查 Claude 登录"
        command = [
            node,
            str(args.source / "scripts" / "claude-oauth-refresh.mjs"),
            "--scope",
            str(args.scope),
        ]
    env = os.environ.copy()
    env["CC_SUITE_COMPOSER_BYPASS"] = "1"
    env["CC_SUITE_SCOPE_ROOT"] = str(args.scope)
    env["CLAUDE_PLUGIN_DATA"] = str(args.scope / ".cc-suite" / "runtime")
    try:
        completed = subprocess.run(
            command,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, "Claude 登录预检查超时，本次配置未启用"
    try:
        line = next(line for line in reversed(completed.stdout.splitlines()) if line.strip())
        result = json.loads(line)
    except (StopIteration, json.JSONDecodeError):
        return None, "Claude 登录预检查返回了无效结果，本次配置未启用"
    if completed.returncode == 0 and result.get("status") in {"ready", "skipped"}:
        return result, None
    return None, _one_line(result.get("error") or "Claude 登录预检查失败，本次配置未启用")


def _preflight_claude_oauth(args: argparse.Namespace) -> str | None:
    """Reject only logins the real Claude CLI cannot refresh itself."""

    _status, error = _claude_oauth_status(args)
    return error


def _preflight_selected_target(args: argparse.Namespace) -> str | None:
    """Check Claude credentials only when Claude is the selected target."""

    if HOSTS[args.host]["target"] != "claude":
        return None
    return _preflight_claude_oauth(args)


def _is_claude_print_call(host: str, child_argv: list[str]) -> bool:
    """Return whether a noninteractive invocation can start Claude inference."""

    if host != "claude":
        return False
    for value in child_argv:
        if value == "--":
            break
        if value in {"-p", "--print"}:
            return True
    return False


def _is_codex_exec_call(host: str, child_argv: list[str]) -> bool:
    """Return whether a noninteractive invocation can start Codex inference."""

    if host != "codex":
        return False
    # The compatibility adapter performs the authoritative argv validation.
    # This lightweight classifier intentionally recognizes only the ordinary
    # public form; unusual global-option layouts fail closed at the adapter
    # instead of being granted a broker path accidentally.
    for value in child_argv:
        if value == "--":
            return False
        if value in {"exec", "e"}:
            return True
    return False


def _is_inference_call(host: str, child_argv: list[str]) -> bool:
    return _is_claude_print_call(host, child_argv) or _is_codex_exec_call(host, child_argv)


def _nested_dispatch_workspace(
    args: argparse.Namespace,
    effective_cwd: Path,
) -> tuple[Path | None, str | None]:
    """Recognize an existing broker session without trusting ambient host."""

    broker_values = {
        "socket": os.environ.get("CC_SUITE_DISPATCH_BROKER_SOCKET"),
        "secret": os.environ.get("CC_SUITE_DISPATCH_BROKER_SECRET"),
        "session": os.environ.get("CC_SUITE_COMPOSER_SESSION"),
        "workspace": os.environ.get("CC_SUITE_WORKSPACE_ROOT"),
    }
    present = [bool(value) for value in broker_values.values()]
    parent_host = os.environ.get("CC_SUITE_COMPOSER_HOST")
    if not any(present):
        if parent_host in HOSTS:
            return None, "当前 cc-suite 宿主会话缺少安全代理"
        return None, None
    if not all(present):
        return None, "当前 cc-suite 安全代理身份不完整"
    if not re.fullmatch(r"[a-fA-F0-9]{32}", broker_values["session"] or ""):
        return None, "当前 cc-suite 安全代理会话无效"
    if not re.fullmatch(r"[a-fA-F0-9]{64}", broker_values["secret"] or ""):
        return None, "当前 cc-suite 安全代理凭据无效"
    configured = os.environ.get("CC_SUITE_WORKSPACE_ROOT")
    try:
        workspace = Path(configured).expanduser().resolve(strict=True)
        selected_cwd = effective_cwd.resolve(strict=True)
    except OSError as error:
        return None, f"当前 cc-suite 工作区不可读：{error}"
    if not workspace.is_dir() or not _inside(args.scope, workspace):
        return None, "当前 cc-suite 工作区不在已配置范围内"
    if not selected_cwd.is_dir() or not _inside(workspace, selected_cwd):
        return None, "目标模型的工作目录不在当前 cc-suite 工作区内"
    return workspace, None


def _run_direct_inference_request(
    args: argparse.Namespace,
    child_argv: list[str],
    launch_cwd: Path,
    workspace_root: Path,
) -> int:
    """Map a nested target CLI call onto the fixed programmatic dispatcher."""

    socket_path = os.environ.get("CC_SUITE_DISPATCH_BROKER_SOCKET")
    secret = os.environ.get("CC_SUITE_DISPATCH_BROKER_SECRET")
    if not socket_path or not secret:
        sys.stderr.write(
            "cc-suite 程序化调用失败：当前宿主会话没有可用的安全代理；未在外层沙盒内直接启动目标模型。\n"
        )
        return 1
    adapter = args.source / "scripts" / "direct-inference-request.mjs"
    node = shutil.which("node")
    if not node or not adapter.is_file():
        sys.stderr.write("cc-suite 程序化调用失败：统一入口组件缺失。\n")
        return 1
    payload = sys.stdin.buffer.read(MAX_DIRECT_INFERENCE_BYTES + 1)
    if len(payload) > MAX_DIRECT_INFERENCE_BYTES:
        sys.stderr.write("cc-suite 程序化调用失败：输入超过 64 MiB 限制。\n")
        return 1
    env = os.environ.copy()
    env["CC_SUITE_SCOPE_ROOT"] = str(args.scope)
    env["CC_SUITE_WORKSPACE_ROOT"] = str(workspace_root)
    env["CLAUDE_PLUGIN_DATA"] = str(args.scope / ".cc-suite" / "runtime")
    configured_request_id = os.environ.get("CC_SUITE_REQUEST_ID", "")
    request_id = (
        configured_request_id
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", configured_request_id)
        else uuid.uuid4().hex
    )
    completed = subprocess.run(
        [
            node,
            str(adapter),
            "--target", args.host,
            "--request-id", request_id,
            "--",
            *child_argv,
        ],
        # Preserve the process's original cwd. The adapter applies Codex -C
        # exactly once and passes the resulting subdirectory to the executor.
        cwd=launch_cwd,
        env=env,
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.stderr:
        sys.stderr.buffer.write(completed.stderr)
        sys.stderr.buffer.flush()
    try:
        lines = [line for line in completed.stdout.decode("utf-8").splitlines() if line.strip()]
        result = json.loads(lines[-1])
    except (UnicodeDecodeError, IndexError, json.JSONDecodeError):
        sys.stderr.write(
            f"cc-suite 程序化调用失败：统一入口返回了无效结果，请求状态未知"
            f"（request-id: {request_id}；重试必须复用同一个 CC_SUITE_REQUEST_ID）。\n"
        )
        return completed.returncode or 1
    if completed.returncode != 0 or result.get("status") != "completed":
        status = result.get("status")
        if status == "busy":
            reason = _one_line(result.get("reason") or "request is busy")
            active = _one_line(result.get("activeStatus") or "")
            message = f"请求忙：{reason}" + (f"（当前状态 {active}）" if active else "")
        elif status == "in_progress":
            message = "同一请求仍在执行中；不会重复启动"
        else:
            message = _one_line(result.get("error") or f"统一入口退出 {completed.returncode}")
        returned_id = _one_line(result.get("requestId") or request_id)
        if status == "in_progress":
            retry = "；请求状态仍在执行，查询或重试必须复用同一个 CC_SUITE_REQUEST_ID"
        elif status == "failed" and re.search(
            r"(?:401|oauth|authenticate|认证|登录)", message, re.IGNORECASE
        ):
            retry = "；认证修复后必须使用新的 CC_SUITE_REQUEST_ID，原 id 只会重放本次失败"
        else:
            retry = ""
        sys.stderr.write(f"cc-suite 程序化调用失败：{message}（request-id: {returned_id}{retry}）\n")
        return completed.returncode or 1
    raw_output = result.get("rawOutput")
    if not isinstance(raw_output, str):
        sys.stderr.write("cc-suite 程序化调用失败：目标模型没有返回原始文字。\n")
        return 1
    sys.stdout.buffer.write(raw_output.encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0


def _run_noninteractive_host(
    args: argparse.Namespace,
    child_argv: list[str],
    workspace_cwd: Path,
) -> int:
    """Run one top-level noninteractive host with its private broker alive."""

    session_id = uuid.uuid4().hex
    workspace_root = _active_project_root(args.scope, workspace_cwd)
    broker_process, broker_socket, broker_secret, broker_error = _start_dispatch_broker(
        args,
        session_id,
        workspace_cwd,
    )
    if broker_error or broker_socket is None or broker_secret is None:
        detail = _one_line(broker_error or "dispatch broker unavailable")
        sys.stderr.write(f"cc-suite 程序化入口未能启动：{detail}\n")
        return 1
    child_env = os.environ.copy()
    child_env["CC_SUITE_COMPOSER_SESSION"] = session_id
    child_env["CC_SUITE_COMPOSER_HOST"] = args.host
    child_env["CC_SUITE_COMPOSER_SCOPE"] = str(args.scope)
    child_env["CC_SUITE_SCOPE_ROOT"] = str(args.scope)
    child_env["CC_SUITE_WORKSPACE_ROOT"] = str(workspace_root)
    child_env["CLAUDE_PLUGIN_DATA"] = str(args.scope / ".cc-suite" / "runtime")
    child_env["CC_SUITE_DISPATCH_BROKER_SOCKET"] = str(broker_socket)
    child_env["CC_SUITE_DISPATCH_BROKER_SECRET"] = broker_secret
    scoped_child_argv = _with_runtime_access(args, child_argv)
    try:
        child = subprocess.Popen(
            [str(args.real_binary), *scoped_child_argv],
            env=child_env,
        )
        return child.wait()
    finally:
        _stop_dispatch_broker(broker_process, broker_socket)


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


def _start_dispatch_broker(
    args: argparse.Namespace,
    session_id: str,
    workspace_cwd: Path,
) -> tuple[subprocess.Popen[str] | None, Path | None, str | None, str | None]:
    """Start one fixed-purpose runner broker outside the host tool sandbox."""

    node = shutil.which("node")
    if not node:
        return None, None, None, "node not found on PATH; dispatch broker could not start"
    broker_script = args.source / "scripts" / "dispatch-broker.mjs"
    if not broker_script.is_file():
        return None, None, None, "dispatch broker implementation is missing"
    workspace_root = _active_project_root(args.scope, workspace_cwd)
    runtime_directory = args.scope / ".cc-suite" / "runtime"
    for candidate in (runtime_directory.parent, runtime_directory):
        try:
            stat = candidate.lstat()
        except OSError as error:
            return None, None, None, f"cc-suite runtime is unavailable: {error}"
        if candidate.is_symlink() or not candidate.is_dir():
            return None, None, None, f"{candidate} is not a real cc-suite directory"
    if not _inside(args.scope, runtime_directory.resolve(strict=True)):
        return None, None, None, "cc-suite runtime resolves outside the configured scope"
    broker_directory = runtime_directory / "brokers"
    try:
        broker_directory.mkdir(mode=0o700)
    except FileExistsError:
        pass
    if broker_directory.is_symlink() or not broker_directory.is_dir():
        return None, None, None, "cc-suite broker path is not a real directory"
    if not _inside(args.scope, broker_directory.resolve(strict=True)):
        return None, None, None, "cc-suite broker path resolves outside the configured scope"
    os.chmod(broker_directory, 0o700)
    socket_path = broker_directory / f"{session_id}.sock"
    if len(os.fsencode(socket_path)) >= 104:
        return None, None, None, "cc-suite broker socket path exceeds the macOS limit"
    secret = secrets.token_hex(32)
    env = os.environ.copy()
    env["CC_SUITE_COMPOSER_BYPASS"] = "1"
    env["CC_SUITE_SCOPE_ROOT"] = str(args.scope)
    env["CC_SUITE_WORKSPACE_ROOT"] = str(workspace_root)
    env["CLAUDE_PLUGIN_DATA"] = str(args.scope / ".cc-suite" / "runtime")
    process = subprocess.Popen(
        [
            node,
            str(broker_script),
            "--socket", str(socket_path),
            "--secret", secret,
            "--scope", str(args.scope),
            "--workspace", str(workspace_root),
            "--source", str(args.source),
            "--parent-pid", str(os.getpid()),
            "--host", args.host,
            "--session-id", session_id,
        ],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if process.poll() is not None:
            detail = (process.stderr.read() if process.stderr else "").strip()
            return None, None, None, _one_line(detail or "dispatch broker exited during startup")
        if socket_path.exists():
            return process, socket_path, secret, None
        time.sleep(0.02)
    process.terminate()
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    return None, None, None, "dispatch broker did not become ready"


def _stop_dispatch_broker(
    process: subprocess.Popen[str] | None,
    socket_path: Path | None,
) -> None:
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=6.0)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    if process is not None and process.stderr is not None:
        process.stderr.close()
    if socket_path is not None:
        try:
            if socket_path.is_socket():
                socket_path.unlink()
        except OSError:
            pass


def _run_proxy(
    args: argparse.Namespace,
    child_argv: list[str],
    workspace_cwd: Path,
    setup_error: str | None = None,
) -> int:
    session_id = uuid.uuid4().hex
    workspace_root = _active_project_root(args.scope, workspace_cwd)
    broker_process, broker_socket, broker_secret, broker_error = _start_dispatch_broker(
        args,
        session_id,
        workspace_cwd,
    )
    if broker_error:
        setup_error = "; ".join(value for value in (setup_error, broker_error) if value)
    child_env = os.environ.copy()
    child_env["CC_SUITE_COMPOSER_SESSION"] = session_id
    child_env["CC_SUITE_COMPOSER_HOST"] = args.host
    child_env["CC_SUITE_COMPOSER_SCOPE"] = str(args.scope)
    child_env["CC_SUITE_SCOPE_ROOT"] = str(args.scope)
    child_env["CC_SUITE_WORKSPACE_ROOT"] = str(workspace_root)
    child_env["CLAUDE_PLUGIN_DATA"] = str(args.scope / ".cc-suite" / "runtime")
    if broker_socket is not None and broker_secret is not None:
        child_env["CC_SUITE_DISPATCH_BROKER_SOCKET"] = str(broker_socket)
        child_env["CC_SUITE_DISPATCH_BROKER_SECRET"] = broker_secret
    scoped_child_argv = _with_runtime_access(args, child_argv)

    try:
        pid, master_fd = pty.fork()
    except BaseException:
        _stop_dispatch_broker(broker_process, broker_socket)
        raise
    if pid == 0:
        os.execve(str(args.real_binary), [str(args.real_binary), *scoped_child_argv], child_env)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    original_tty = termios.tcgetattr(stdin_fd)
    tracker = ComposerInput(_host_triggers(args.host, args.source))
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
            readable, _, _ = select.select(
                [stdin_fd, master_fd],
                [],
                [],
                0.05 if tracker.escape else None,
            )
            if not readable and tracker.escape:
                escaped = tracker.flush_escape()
                if escaped:
                    os.write(master_fd, escaped)
                continue
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
                ordinary_submission = any(
                    not _is_control_submission(value) for value in tracker.submissions
                )
                write_plan = _submission_write_plan(
                    forwarded,
                    has_submission=bool(tracker.submissions),
                    pending_prefix=tracker.pending_prefix is not None,
                )
                for write_index, chunk in enumerate(write_plan):
                    if write_index:
                        time.sleep(0.03)
                    if chunk:
                        os.write(master_fd, chunk)
                if ordinary_submission:
                    # ``feed`` already replayed only the real task. Stop showing
                    # or restoring the one-shot prefix after this submit key.
                    tracker.disarm_prefix()
                if not triggered:
                    continue

                if setup_error:
                    try:
                        os.write(master_fd, b"\x7f" * len(triggered))
                    except OSError:
                        child_open = False
                    tracker.clear()
                    resize()
                    _show_transient_error(setup_error)
                    continue

                if args.host == "codex":
                    hook_ready, hook_error = _codex_dispatch_hook_ready(
                        args.scope,
                        child_argv,
                    )
                    if not hook_ready:
                        try:
                            os.write(master_fd, b"\x7f" * len(triggered))
                        except OSError:
                            child_open = False
                        tracker.clear()
                        resize()
                        _show_transient_error(hook_error)
                        continue

                _signal_group(pid, signal.SIGSTOP)
                # Only Codex -> Claude depends on Claude's credential. Running
                # Claude -> Codex must never be blocked by an unrelated Claude
                # refresh state; Claude is already the active authenticated host.
                auth_error = _preflight_selected_target(args)
                if auth_error:
                    try:
                        os.write(master_fd, b"\x7f" * len(triggered))
                    except OSError:
                        child_open = False
                    tracker.clear()
                    _signal_group(pid, signal.SIGCONT)
                    resize()
                    _show_transient_error(auth_error)
                    continue
                result, error = _run_selector(args, session_id, workspace_cwd)
                try:
                    os.write(master_fd, b"\x7f" * len(triggered))
                except OSError:
                    child_open = False
                tracker.clear()
                prefix = b""
                if not error and result and result.get("status") == "selected":
                    prefix = tracker.arm_prefix(_pending_composer_prefix(result))
                if prefix:
                    try:
                        os.write(master_fd, prefix)
                    except OSError:
                        child_open = False
                _signal_group(pid, signal.SIGCONT)
                resize()
                if error:
                    _show_transient_error(error)
                # Backspaces remove the local selector; the next queued bytes
                # insert the protected tuple directly into the stock composer.
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
        _stop_dispatch_broker(broker_process, broker_socket)
    return _wait_status(pid)


def _probe_input() -> int:
    payload = json.load(sys.stdin)
    host = payload["host"]
    source_root = Path(
        payload.get("sourceRoot", Path(__file__).resolve().parent.parent)
    ).expanduser().resolve()
    tracker = ComposerInput(_host_triggers(host, source_root))
    forwarded = []
    triggers = 0
    for chunk in payload.get("chunks", []):
        output, triggered = tracker.feed(chunk.encode("utf-8"))
        forwarded.append(output.decode("utf-8", errors="replace"))
        triggers += int(triggered is not None)
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


def _probe_prefix() -> int:
    payload = json.load(sys.stdin)
    host = payload.get("host", "codex")
    source_root = Path(
        payload.get("sourceRoot", Path(__file__).resolve().parent.parent)
    ).expanduser().resolve()
    tracker = ComposerInput(_host_triggers(host, source_root))
    result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
    prefix = _pending_composer_prefix(result)
    initial = tracker.arm_prefix(prefix)
    forwarded: list[str] = []
    write_plans: list[list[str]] = []
    submissions: list[str] = []
    for chunk in payload.get("chunks", []):
        output, _ = tracker.feed(str(chunk).encode("utf-8"))
        forwarded.append(output.decode("utf-8", errors="replace"))
        ordinary_submission = any(
            not _is_control_submission(value) for value in tracker.submissions
        )
        write_plans.append(
            [
                value.decode("utf-8", errors="replace")
                for value in _submission_write_plan(
                    output,
                    has_submission=bool(tracker.submissions),
                    pending_prefix=tracker.pending_prefix is not None,
                )
            ]
        )
        submissions.extend(
            value.decode("utf-8", errors="replace") for value in tracker.submissions
        )
        if any(not _is_control_submission(value) for value in tracker.submissions):
            tracker.disarm_prefix()
    json.dump(
        {
            "prefix": prefix,
            "initial": initial.decode("utf-8"),
            "forwarded": forwarded,
            "writePlans": write_plans,
            "submissions": submissions,
            "buffer": bytes(tracker.text).decode("utf-8", errors="replace"),
            "armed": tracker.pending_prefix is not None,
            "visible": tracker.prefix_visible,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
    return 0


def _probe_control() -> int:
    payload = json.load(sys.stdin)
    values = payload.get("values", [])
    json.dump(
        [_is_control_submission(str(value).encode("utf-8")) for value in values],
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


def _probe_project_root() -> int:
    payload = json.load(sys.stdin)
    scope = Path(payload["scope"]).expanduser().resolve(strict=True)
    cwd = Path(payload["cwd"]).expanduser().resolve(strict=True)
    json.dump({"root": str(_active_project_root(scope, cwd))}, sys.stdout)
    sys.stdout.write("\n")
    return 0


def _probe_workspace_ready() -> int:
    payload = json.load(sys.stdin)
    project_root = Path(payload["projectRoot"]).expanduser().resolve(strict=True)
    source_root = Path(payload["sourceRoot"]).expanduser().resolve(strict=True)
    json.dump(
        {"ready": _workspace_dispatch_ready(project_root, source_root)},
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


def _probe_runtime_argv() -> int:
    payload = json.load(sys.stdin)
    scope = Path(payload["scope"]).expanduser().resolve(strict=True)
    args = argparse.Namespace(scope=scope, host=payload.get("host", "codex"))
    json.dump(
        {"argv": _with_runtime_access(args, [str(value) for value in payload.get("argv", [])])},
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


def _probe_oauth_preflight() -> int:
    payload = json.load(sys.stdin)
    scope = Path(payload["scope"]).expanduser().resolve(strict=True)
    source = Path(payload.get("sourceRoot", Path(__file__).resolve().parent.parent)).resolve(strict=True)
    status_command = [str(value) for value in payload["statusCommand"]]
    args = argparse.Namespace(
        host="codex",
        scope=scope,
        source=source,
        oauth_probe_command=status_command,
    )
    error = _preflight_claude_oauth(args)
    status, status_error = _claude_oauth_status(args)
    json.dump(
        {
            "error": error,
            "statusError": status_error,
            "refreshNeeded": status.get("refreshNeeded") if status else None,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
    return 0


def _probe_selection_auth() -> int:
    payload = json.load(sys.stdin)
    scope = Path(payload["scope"]).expanduser().resolve(strict=True)
    source = Path(payload.get("sourceRoot", Path(__file__).resolve().parent.parent)).resolve(strict=True)
    args = argparse.Namespace(
        host=str(payload["host"]),
        scope=scope,
        source=source,
        oauth_probe_command=[str(value) for value in payload["statusCommand"]],
    )
    json.dump({"error": _preflight_selected_target(args)}, sys.stdout)
    sys.stdout.write("\n")
    return 0


def _probe_hook_trust() -> int:
    payload = json.load(sys.stdin)
    scope_root = Path(payload.get("scopeRoot", payload.get("projectRoot"))).expanduser().resolve(strict=True)
    codex_home = Path(payload["codexHome"]).expanduser().resolve(strict=True)
    ready, error = _codex_dispatch_hook_ready(
        scope_root,
        payload.get("argv", []),
        codex_home,
    )
    identity = _codex_dispatch_hook_identity(scope_root, codex_home)
    json.dump(
        {
            "ready": ready,
            "error": error,
            "key": identity[0] if identity else None,
            "currentHash": identity[1] if identity else None,
        },
        sys.stdout,
        ensure_ascii=False,
    )
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
    if argv == ["--probe-prefix"]:
        return _probe_prefix()
    if argv == ["--probe-control"]:
        return _probe_control()
    if argv == ["--probe-project-root"]:
        return _probe_project_root()
    if argv == ["--probe-workspace-ready"]:
        return _probe_workspace_ready()
    if argv == ["--probe-runtime-argv"]:
        return _probe_runtime_argv()
    if argv == ["--probe-oauth-preflight"]:
        return _probe_oauth_preflight()
    if argv == ["--probe-selection-auth"]:
        return _probe_selection_auth()
    if argv == ["--probe-hook-trust"]:
        return _probe_hook_trust()
    args, child_argv = _parse_args(argv)
    launch_cwd = Path.cwd().resolve()
    workspace_cwd = _effective_workspace(args.host, child_argv, launch_cwd)
    if os.environ.get("CC_SUITE_COMPOSER_BYPASS") == "1":
        os.execve(
            str(args.real_binary),
            [str(args.real_binary), *child_argv],
            os.environ.copy(),
        )

    inference_call = _is_inference_call(args.host, child_argv)
    nested_workspace, nested_error = _nested_dispatch_workspace(args, workspace_cwd)
    if nested_error and inference_call:
        sys.stderr.write(f"cc-suite 程序化调用失败：{_one_line(nested_error)}。\n")
        return 1
    if nested_workspace is not None and inference_call:
        if sys.stdin.isatty() or sys.stdout.isatty():
            sys.stderr.write("cc-suite 程序化调用失败：嵌套模型调用必须使用完整的非 TTY 输入输出。\n")
            return 1
        return _run_direct_inference_request(
            args,
            child_argv,
            launch_cwd,
            nested_workspace,
        )

    if not _inside(args.scope, workspace_cwd):
        os.execve(
            str(args.real_binary),
            [str(args.real_binary), *child_argv],
            os.environ.copy(),
        )
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        if inference_call:
            if args.host == "claude":
                auth_error = _preflight_claude_oauth(args)
                if auth_error:
                    sys.stderr.write(
                        f"cc-suite Claude 登录检查失败：{_one_line(auth_error)}\n"
                    )
                    return 1
            return _run_noninteractive_host(args, child_argv, workspace_cwd)
        os.execve(
            str(args.real_binary),
            [str(args.real_binary), *child_argv],
            os.environ.copy(),
        )
    setup_error = _ensure_workspace_dispatch(args, workspace_cwd)
    return _run_proxy(args, child_argv, workspace_cwd, setup_error)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, RuntimeError) as error:
        sys.stderr.write(f"cc-suite composer proxy: {error}\n")
        raise SystemExit(1)
