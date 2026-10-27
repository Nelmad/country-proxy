#!/usr/bin/env python3
"""List checks by default; execute only a reviewed exact contract digest."""

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import re
import select
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple


LOCALE_KEYS = ("LANG", "LC_ALL", "LC_CTYPE")
BASE_ENVIRONMENT_KEYS = ("PATH", "USER", "LOGNAME", "SHELL", "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC")
MAX_OUTPUT_BYTES = 64 * 1024
MAX_CONTRACT_BYTES = 1_000_000
SECURE_NOFOLLOW_OPEN = bool(getattr(os, "O_NOFOLLOW", 0))
MAX_TIMEOUT_SECONDS = 3600
MAX_CHECKS = 64
MAX_SELECTED_TIMEOUT_SECONDS = 14_400
TRANSIENT_PERMISSION_DELAYS = (0.05, 0.1, 0.2, 0.4, 0.8)
POLICY_MARKER = "<!-- personal-ai-workspace-code-policy:v1 -->"
EXPECTED_POLICY = {
    "policy_version": 1,
    "root_instructions": "AGENTS.md",
    "claude_entry": "CLAUDE.md",
    "checks": "project-checks.json",
    "live_trading_execution": "deny",
}
REDACTIONS = (
    re.compile(
        r"-----BEGIN (?P<private_label>(?:(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY|"
        r"PGP PRIVATE KEY BLOCK))-----[\s\S]*?-----END (?P=private_label)-----"
    ),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r"\b(?:gh[pousr]_|github_pat_|glpat-|sk-(?:ant-)?|xox[baprs]-)[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{30,}\b"),
    re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b"),
    re.compile(r"(?i)\b[A-Za-z][A-Za-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@"),
    re.compile(
        r"(?i)\b(?:authorization\s*:\s*)?(?:bearer|oauth|api[-_ ]?key)\s+"
        r"[A-Za-z0-9][A-Za-z0-9._~+/-]{15,}={0,2}"
    ),
    re.compile(
        r"(?i)\bauthorization\s*:\s*basic\s+"
        r"[A-Za-z0-9+/]{4,}={0,2}(?![A-Za-z0-9+/=])"
    ),
    re.compile(r"\b(?:y[01]|t[01])_[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bAQAD-[A-Za-z0-9_-]{20,}\b"),
    re.compile(
        r"(?i)\b(?:aws[_-]?)?secret[_-]?access[_-]?key\b\s*[:=]\s*"
        r"['\"]?[A-Za-z0-9/+=]{40,}"
    ),
)
CONTRACT_SECRET_PATTERNS = (
    re.compile(
        r"-----BEGIN (?:(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY|"
        r"PGP PRIVATE KEY BLOCK)-----"
    ),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r"\b(?:gh[pousr]_|github_pat_|glpat-|sk-(?:ant-)?|xox[baprs]-)[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{30,}\b"),
    re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b"),
    re.compile(r"(?i)\b[A-Za-z][A-Za-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@"),
    re.compile(
        r"(?i)\b(?:authorization\s*:\s*)?(?:bearer|oauth|api[-_ ]?key)\s+"
        r"[A-Za-z0-9][A-Za-z0-9._~+/-]{15,}={0,2}"
    ),
    re.compile(
        r"(?i)\bauthorization\s*:\s*basic\s+"
        r"[A-Za-z0-9+/]{4,}={0,2}(?![A-Za-z0-9+/=])"
    ),
    re.compile(r"\b(?:y[01]|t[01])_[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bAQAD-[A-Za-z0-9_-]{20,}\b"),
    re.compile(
        r"(?i)\b(?:aws[_-]?)?secret[_-]?access[_-]?key\b\s*[:=]\s*"
        r"['\"]?[A-Za-z0-9/+=]{40,}"
    ),
)


@lru_cache(maxsize=1)
def local_secret_scan():  # type: ignore
    """Load the reviewed detector shipped beside this standalone runner."""

    path = Path(__file__).with_name("secret_scan.py")
    spec = importlib.util.spec_from_file_location("_personal_ai_blueprint_secret_scan", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load the local secret detector")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except (OSError, ValueError) as exc:
        raise RuntimeError("Cannot load the local secret detector") from exc
    return module


class DuplicateKeyError(ValueError):
    pass


class ProcessContainmentError(RuntimeError):
    """The reviewed process group could not be stopped with proven ownership."""


def unique_object(pairs):  # type: ignore
    result = {}
    for key, value in pairs:
        if key in result:
            # A malicious JSON key may contain terminal controls or a secret.
            # The diagnostic intentionally reveals neither.
            raise DuplicateKeyError("duplicate JSON key")
        result[key] = value
    return result


def standalone_runtime_denial(
    system_name: Optional[str] = None,
    release_text: Optional[str] = None,
    version_text: Optional[str] = None,
    environment: Optional[Dict[str, str]] = None,
) -> Optional[str]:
    """Allow only native macOS/Linux before this runner reads or executes."""

    system = (platform.system() if system_name is None else system_name).casefold()
    release = platform.release() if release_text is None else release_text
    version = platform.version() if version_text is None else version_text
    current_environment = os.environ if environment is None else environment
    if system == "darwin":
        return None
    if system == "linux":
        kernel = "{} {}".format(release, version).casefold()
        is_wsl = (
            "microsoft" in kernel
            or bool(current_environment.get("WSL_DISTRO_NAME"))
            or bool(current_environment.get("WSL_INTEROP"))
        )
        if not is_wsl:
            return None
        return "Windows/WSL support is postponed; use native macOS or native Linux."
    return "This runtime is unsupported; use native macOS or native Linux."


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="list checks; this is also the default")
    parser.add_argument(
        "--execute-reviewed", metavar="SHA256",
        help="execute only when this digest matches the exact project-checks.json bytes",
    )
    parser.add_argument("--check", action="append", help="run only the named check; repeatable")
    parser.add_argument("--allow-network", action="store_true")
    parser.add_argument("--allow-writes", action="store_true")
    parser.add_argument("--allow-skips", action="store_true")
    args = parser.parse_args(argv)
    if args.list and args.execute_reviewed:
        parser.error("--list and --execute-reviewed are mutually exclusive")
    if not args.execute_reviewed and (args.check or args.allow_network or args.allow_writes or args.allow_skips):
        parser.error("execution selection and acknowledgements require --execute-reviewed")
    return args


def read_bounded_regular(path: Path, label: str, limit: int = MAX_CONTRACT_BYTES) -> bytes:
    runtime_denial = standalone_runtime_denial()
    if runtime_denial is not None:
        raise RuntimeError(runtime_denial)
    if not SECURE_NOFOLLOW_OPEN:
        raise RuntimeError("secure no-follow reads are unavailable")
    # O_NONBLOCK prevents a FIFO/device path from hanging before fstat can reject
    # it. The descriptor is validated before the first read, then consumed with
    # an explicit byte budget so a concurrently growing file cannot run forever.
    flags = (
        os.O_RDONLY
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
        | getattr(os, "O_NOCTTY", 0)
    )
    try:
        descriptor = os.open(str(path), flags)
    except OSError as exc:
        raise RuntimeError("Cannot open {} safely".format(label)) from exc
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise RuntimeError("{} must be a single-link regular file".format(label))
        if before.st_size > limit:
            raise RuntimeError("{} is too large".format(label))
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(descriptor)
        if len(data) > limit:
            raise RuntimeError("{} is too large".format(label))
        if (
            (
                before.st_dev,
                before.st_ino,
                before.st_mode,
                before.st_nlink,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            )
            != (
                after.st_dev,
                after.st_ino,
                after.st_mode,
                after.st_nlink,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            )
            or len(data) != before.st_size
        ):
            raise RuntimeError("{} changed while being read".format(label))
    except OSError as exc:
        raise RuntimeError("Cannot read {} safely".format(label)) from exc
    finally:
        _close_descriptor(descriptor)
    return data


def read_contract(path: Path) -> Tuple[bytes, str]:
    data = read_bounded_regular(path, "project-checks.json")
    return data, hashlib.sha256(data).hexdigest()


def secret_text_detected(text: str) -> bool:
    try:
        return (
            local_secret_scan().contains_bip39_mnemonic(text)
            or local_secret_scan().contains_secret_scalar(text)
            or local_secret_scan().contains_secret_token(text)
            or local_secret_scan().contains_netrc_credentials(text)
            or local_secret_scan().contains_putty_private_key(text)
            or local_secret_scan().contains_recovery_material(text)
            or local_secret_scan().string_has_recovery_path_material(text)
            or any(pattern.search(text) for pattern in CONTRACT_SECRET_PATTERNS)
        )
    except (OSError, ValueError) as exc:
        raise RuntimeError("The local secret detector is unavailable") from exc


def contract_has_secret(value: object) -> bool:
    if isinstance(value, dict):
        if (
            local_secret_scan().mapping_has_bip39_mnemonic(value)
            or local_secret_scan().mapping_has_populated_secret_keys(value)
        ):
            return True
        return any(
            secret_text_detected(str(key))
            or (
                local_secret_scan().is_recovery_label(key)
                and local_secret_scan().structured_value_is_populated(child)
            )
            or contract_has_secret(child)
            for key, child in value.items()
        )
    if isinstance(value, list):
        if (
            local_secret_scan().contains_bip39_mnemonic_sequence(value)
            or local_secret_scan().sequence_has_adjacent_secret_value(value)
            or local_secret_scan().sequence_has_recovery_material(value)
        ):
            return True
        return any(contract_has_secret(child) for child in value)
    return isinstance(value, str) and secret_text_detected(value)


def load_checks(data: bytes) -> List[Dict[str, object]]:
    try:
        text = data.decode("utf-8")
        if secret_text_detected(text):
            raise RuntimeError("project-checks.json contains secret-like material; move it to the approved secret runtime")
        payload = json.loads(text, object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, DuplicateKeyError) as exc:
        raise RuntimeError("Cannot parse project-checks.json: {}".format(exc))
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise RuntimeError("project-checks.json must be an object with schema_version=1")
    if contract_has_secret(payload):
        raise RuntimeError(
            "project-checks.json contains secret-like material; move it to the approved secret runtime"
        )
    raw_checks = payload.get("checks")
    if not isinstance(raw_checks, list):
        raise RuntimeError("project-checks.json checks must be a list")
    if len(raw_checks) > MAX_CHECKS:
        raise RuntimeError(
            "project-checks.json exceeds the {} check limit".format(MAX_CHECKS)
        )
    names = set()
    checks: List[Dict[str, object]] = []
    for index, item in enumerate(raw_checks, start=1):
        if not isinstance(item, dict):
            raise RuntimeError("Check {} must be an object".format(index))
        allowed_keys = {"name", "command", "mode", "requires_network", "timeout_seconds"}
        if set(item) - allowed_keys:
            raise RuntimeError("Check {} contains unknown fields".format(index))
        name = item.get("name")
        command = item.get("command")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name) or name in names:
            raise RuntimeError("Every check needs a unique safe name")
        if not isinstance(command, list) or not command or len(command) > 64:
            raise RuntimeError("Check '{}' command must be a bounded argv array".format(name))
        if not all(isinstance(part, str) and part and "\x00" not in part and len(part) <= 4096 for part in command):
            raise RuntimeError("Check '{}' command contains an invalid argv item".format(name))
        if item.get("mode", "read-only") not in {"read-only", "writes"}:
            raise RuntimeError("Check '{}' mode must be read-only or writes".format(name))
        network = item.get("requires_network", False)
        if not isinstance(network, bool):
            raise RuntimeError("Check '{}' requires_network must be boolean".format(name))
        timeout = item.get("timeout_seconds", 600)
        if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= MAX_TIMEOUT_SECONDS:
            raise RuntimeError("Check '{}' timeout must be 1..{} seconds".format(name, MAX_TIMEOUT_SECONDS))
        names.add(name)
        checks.append(item)
    return checks


def read_text_policy(path: Path, label: str) -> str:
    try:
        return read_bounded_regular(path, label).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeError("{} must be valid UTF-8".format(label)) from exc


def validate_repo_identity(root: Path) -> None:
    path = root / "repo-manifest.json"
    try:
        manifest_text = read_bounded_regular(path, "repo-manifest.json").decode("utf-8")
        payload = json.loads(manifest_text, object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, DuplicateKeyError) as exc:
        raise RuntimeError("Cannot read repo-manifest.json: {}".format(exc))
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise RuntimeError("repo-manifest.json must be an object with schema_version=1")
    if not isinstance(payload.get("repo_id"), str) or not re.fullmatch(r"REP-\d{3,}", payload["repo_id"]):
        raise RuntimeError("repo-manifest.json needs a concrete repo_id")
    repository_uuid = payload.get("repository_uuid")
    try:
        if not isinstance(repository_uuid, str) or str(uuid.UUID(repository_uuid)) != repository_uuid:
            raise ValueError
    except (ValueError, AttributeError):
        raise RuntimeError("repo-manifest.json needs a canonical lowercase repository_uuid")
    if not isinstance(payload.get("domain"), str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", payload["domain"]):
        raise RuntimeError("repo-manifest.json needs a concrete domain")
    product_id = payload.get("product_id")
    if "product_id" not in payload or not (
        product_id is None
        or (isinstance(product_id, str) and re.fullmatch(r"PROD-[0-9]{3,}", product_id))
    ):
        raise RuntimeError("repo-manifest.json product_id must be null or PROD-NNN")
    project_ids = payload.get("project_ids")
    if (
        not isinstance(project_ids, list)
        or any(
            not isinstance(project_id, str)
            or re.fullmatch(r"PRJ-[0-9]{3,}", project_id) is None
            for project_id in project_ids
        )
        or len(project_ids) != len(set(project_ids))
    ):
        raise RuntimeError("repo-manifest.json project_ids must be unique PRJ-NNN values")
    if payload.get("sensitivity") not in {"public", "ordinary", "sensitive"}:
        raise RuntimeError("code sensitivity must be public, ordinary or sensitive")
    if payload.get("ai_policy") != EXPECTED_POLICY:
        raise RuntimeError("repo-manifest.json ai_policy contract is missing or changed")
    if POLICY_MARKER not in read_text_policy(root / "AGENTS.md", "AGENTS.md"):
        raise RuntimeError("AGENTS.md lacks the workspace policy marker")
    if "@AGENTS.md" not in read_text_policy(root / "CLAUDE.md", "CLAUDE.md"):
        raise RuntimeError("CLAUDE.md must import @AGENTS.md")


def list_checks(checks: List[Dict[str, object]], digest: str) -> None:
    print("review_digest={}".format(digest))
    print("Execution is disabled until --execute-reviewed receives this exact digest.")
    if not checks:
        print("No checks configured. Replace project-checks.json during repo adoption.")
    for item in checks:
        flags = []
        if item.get("requires_network", False):
            flags.append("network")
        if item.get("mode", "read-only") == "writes":
            flags.append("writes")
        print("{}{}".format(item["name"], " [{}]".format(",".join(flags)) if flags else ""))


def minimal_environment(sandbox_root: Path) -> Dict[str, str]:
    environment = {key: os.environ[key] for key in BASE_ENVIRONMENT_KEYS if key in os.environ}
    for key in LOCALE_KEYS:
        if key in os.environ:
            environment[key] = os.environ[key]
    directories = {
        "HOME": sandbox_root / "home",
        "XDG_CONFIG_HOME": sandbox_root / "xdg-config",
        "XDG_CACHE_HOME": sandbox_root / "xdg-cache",
        "XDG_DATA_HOME": sandbox_root / "xdg-data",
        "XDG_STATE_HOME": sandbox_root / "xdg-state",
        "TMPDIR": sandbox_root / "tmp",
        "TEMP": sandbox_root / "tmp",
        "TMP": sandbox_root / "tmp",
    }
    for value in set(directories.values()):
        value.mkdir(mode=0o700, parents=True, exist_ok=True)
    environment.update({key: str(value) for key, value in directories.items()})
    return environment


def redact_output(data: bytes, truncated: bool) -> str:
    if truncated:
        # A credential can straddle the bounded capture edge, leaving too short
        # a prefix for a format matcher. No finite overlap proves that an
        # unbounded token/URI ends safely, so never print raw bytes from an
        # incomplete capture.
        return (
            "[CHECK OUTPUT] [OUTPUT TRUNCATED AT {} BYTES; "
            "CAPTURE REDACTED]\n".format(MAX_OUTPUT_BYTES)
        )
    text = data.decode("utf-8", errors="replace")
    try:
        text = local_secret_scan().redact_bip39_mnemonics(text)
        text = local_secret_scan().redact_secret_tokens(text)
        text = local_secret_scan().redact_secret_scalars(text)
        text = local_secret_scan().redact_recovery_material(text)
        text = local_secret_scan().redact_netrc_credentials(text)
        text = local_secret_scan().redact_putty_private_keys(text)
    except (OSError, ValueError):
        return "[CHECK OUTPUT] [CAPTURE REDACTED: SECRET DETECTOR UNAVAILABLE]\n"
    if local_secret_scan().string_has_recovery_path_material(text):
        text = "[REDACTED]"
    for pattern in REDACTIONS:
        text = pattern.sub("[REDACTED]", text)
    # Complete PEM blocks were removed by REDACTIONS. Any BEGIN marker that is
    # still present has no captured END (normally because output was truncated),
    # so redact through the end of the capture rather than exposing key material.
    unterminated_private_key = CONTRACT_SECRET_PATTERNS[0].search(text)
    if unterminated_private_key is not None:
        text = text[:unterminated_private_key.start()] + "[REDACTED]"
    safe = []
    for character in text:
        codepoint = ord(character)
        if character in {"\n", "\t"}:
            safe.append(character)
        elif unicodedata.category(character) in {"Cc", "Cf"}:
            safe.append("\\x{:02x}".format(codepoint) if codepoint <= 0xFF else "\\u{:04x}".format(codepoint))
        else:
            safe.append(character)
    text = "".join(safe)
    return "".join("[CHECK OUTPUT] " + line for line in text.splitlines(keepends=True))


def _reap_supervisor(supervisor: subprocess.Popen) -> None:
    """Reap the trusted supervisor only after all process-group signals."""

    while True:
        try:
            supervisor.wait()
            return
        except InterruptedError:
            continue


def _close_descriptor(descriptor: Optional[int]) -> None:
    if descriptor is None:
        return
    try:
        os.close(descriptor)
    except OSError:
        pass


def terminate_and_reap_supervisor(supervisor: subprocess.Popen) -> None:
    """Stop only the still-owned child handle, never a recycled numeric PGID."""

    try:
        supervisor.terminate()
    except ProcessLookupError:
        pass
    except OSError:
        # A stable child handle can still be reaped or killed below. Never turn
        # this into another killpg attempt against a numeric identifier.
        pass
    try:
        supervisor.wait(timeout=1)
        return
    except subprocess.TimeoutExpired:
        pass
    except OSError as exc:
        raise ProcessContainmentError(
            "POSIX supervisor cleanup failed safely"
        ) from exc
    try:
        supervisor.kill()
    except ProcessLookupError:
        pass
    except OSError as exc:
        raise ProcessContainmentError(
            "POSIX supervisor cleanup failed safely"
        ) from exc
    try:
        supervisor.wait(timeout=2)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProcessContainmentError(
            "POSIX supervisor cleanup failed safely"
        ) from exc


def fallback_stop_posix_process_group(supervisor: subprocess.Popen) -> None:
    """Fallback signal a group while its leader PID is unreaped/reserved."""

    supervisor_pid = supervisor.pid
    try:
        os.killpg(supervisor_pid, signal.SIGTERM)
    except ProcessLookupError:
        # No group exists. Reap the reserved supervisor PID and never signal
        # this numeric PGID again: a later process could otherwise reuse it.
        _reap_supervisor(supervisor)
        return
    except PermissionError:
        # Retrying the group signal cannot make ownership safer. Stop/reap only
        # through the still-owned Popen child handle, then report containment
        # failure without exposing the reviewed argv.
        terminate_and_reap_supervisor(supervisor)
        raise ProcessContainmentError(
            "POSIX process containment failed safely"
        )

    # The supervisor is intentionally not reaped during this grace interval,
    # so its PID cannot be reused as an unrelated process-group ID.
    time.sleep(0.2)
    try:
        os.killpg(supervisor_pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        terminate_and_reap_supervisor(supervisor)
        raise ProcessContainmentError(
            "POSIX process containment failed safely"
        )
    _reap_supervisor(supervisor)


def stop_posix_process_group(
    supervisor: subprocess.Popen, control_descriptor: int, ack_descriptor: int
) -> None:
    """Ask the unreaped group leader to terminate its own complete group."""

    control_sent = False
    try:
        control_sent = os.write(control_descriptor, b"S") == 1
    except OSError:
        control_sent = False
    finally:
        _close_descriptor(control_descriptor)

    acknowledged = False
    if control_sent:
        try:
            readable, _writable, _errors = select.select(
                [ack_descriptor], [], [], 2
            )
            acknowledged = bool(readable) and os.read(ack_descriptor, 1) == b"T"
        except (OSError, InterruptedError):
            acknowledged = False
    _close_descriptor(ack_descriptor)

    if acknowledged:
        try:
            supervisor.wait(timeout=3)
        except subprocess.TimeoutExpired:
            # The supervisor is deliberately still unreaped; external fallback
            # therefore cannot cross a PID/PGID reuse boundary.
            pass
        else:
            if supervisor.returncode == -signal.SIGKILL:
                return
            # Trusted code only exits normally on a failed self-stop. It is
            # already reaped here, so never signal the numeric PGID again.
            raise RuntimeError("POSIX supervisor failed to terminate its group")

    fallback_stop_posix_process_group(supervisor)


POSIX_SUPERVISOR_CODE = r'''
import json
import os
import signal
import subprocess
import sys
import threading
import time

status_fd = int(sys.argv[1])
control_fd = int(sys.argv[2])
ack_fd = int(sys.argv[3])

def stop_owned_group(acknowledge):
    # A caught SIGTERM disposition resets to default in the exec'd worker. The
    # supervisor alone handles a stable-handle terminate() by stopping its group.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        os.killpg(0, signal.SIGTERM)
        if acknowledge:
            os.write(ack_fd, b"T")
        time.sleep(0.2)
        os.killpg(0, signal.SIGKILL)
    except BaseException:
        if acknowledge:
            try:
                os.write(ack_fd, b"F")
            except OSError:
                pass
        while True:
            signal.pause()

def handle_parent_termination(_signal_value, _frame):
    stop_owned_group(False)

signal.signal(signal.SIGTERM, handle_parent_termination)
try:
    command = json.loads(sys.stdin.buffer.read(300001).decode("utf-8", errors="strict"))
    if (
        not isinstance(command, list)
        or not command
        or len(command) > 64
        or not all(
            isinstance(part, str)
            and part
            and "\x00" not in part
            and len(part) <= 4096
            for part in command
        )
    ):
        raise ValueError("invalid supervisor command")
    worker = None
    for attempt, delay in enumerate((0.05, 0.1, 0.2, 0.4, 0.8, None)):
        try:
            worker = subprocess.Popen(
                command,
                stdout=None,
                stderr=subprocess.STDOUT,
                close_fds=True,
            )
            break
        except PermissionError:
            if delay is None:
                raise
            time.sleep(delay)
    if worker is None:
        raise RuntimeError("worker unavailable")
except BaseException:
    worker = None

def report_worker_status():
    code = 125 if worker is None else worker.wait()
    try:
        os.write(status_fd, (str(code) + "\n").encode("ascii"))
    except OSError:
        pass
    try:
        os.close(status_fd)
    except OSError:
        pass

threading.Thread(target=report_worker_status, daemon=True).start()
try:
    stop_token = os.read(control_fd, 1)
except OSError:
    stop_token = b""
if stop_token == b"S":
    stop_owned_group(True)
os._exit(126)
'''


def start_posix_supervisor(
    command: List[str], root: Path, environment: Dict[str, str]
) -> Tuple[subprocess.Popen, object, int, int, int]:
    """Start an isolated-Python session leader for one reviewed worker group."""

    try:
        python = Path(sys.executable).resolve(strict=True)
        python_stat = os.stat(str(python), follow_symlinks=False)
    except (OSError, RuntimeError) as exc:
        raise RuntimeError("Cannot resolve the trusted supervisor Python") from exc
    if (
        not python.is_absolute()
        or not stat.S_ISREG(python_stat.st_mode)
        or not os.access(str(python), os.X_OK)
    ):
        raise RuntimeError("Cannot resolve the trusted supervisor Python")
    command_data = json.dumps(
        command, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8", errors="strict")
    if len(command_data) > 300_000:
        raise RuntimeError("Reviewed command exceeds the supervisor input limit")
    created_descriptors: List[int] = []
    try:
        status_read, status_write = os.pipe()
        created_descriptors.extend((status_read, status_write))
        control_read, control_write = os.pipe()
        created_descriptors.extend((control_read, control_write))
        ack_read, ack_write = os.pipe()
        created_descriptors.extend((ack_read, ack_write))
    except BaseException:
        for descriptor in created_descriptors:
            _close_descriptor(descriptor)
        raise
    supervisor = None
    try:
        for attempt in range(len(TRANSIENT_PERMISSION_DELAYS) + 1):
            try:
                supervisor = subprocess.Popen(
                    [
                        str(python),
                        "-I",
                        "-B",
                        "-c",
                        POSIX_SUPERVISOR_CODE,
                        str(status_write),
                        str(control_read),
                        str(ack_write),
                    ],
                    cwd=str(root),
                    env=environment,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    pass_fds=(status_write, control_read, ack_write),
                )
                break
            except PermissionError:
                if attempt == len(TRANSIENT_PERMISSION_DELAYS):
                    raise
                time.sleep(TRANSIENT_PERMISSION_DELAYS[attempt])
        if supervisor is None or supervisor.stdin is None:
            raise RuntimeError("POSIX supervisor did not expose its command pipe")
        supervisor.stdin.write(command_data)
        supervisor.stdin.close()
        if supervisor.stdout is None:
            raise RuntimeError("POSIX supervisor did not expose its output pipe")
        return (
            supervisor,
            supervisor.stdout,
            status_read,
            control_write,
            ack_read,
        )
    except BaseException:
        for descriptor in (status_read, control_write, ack_read):
            _close_descriptor(descriptor)
        if supervisor is not None:
            for stream in (supervisor.stdin, supervisor.stdout):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
            terminate_and_reap_supervisor(supervisor)
        raise
    finally:
        for descriptor in (status_write, control_read, ack_write):
            _close_descriptor(descriptor)


def read_supervisor_status(
    descriptor: int,
    timeout: int,
    output_limit_event: Optional[threading.Event] = None,
) -> Tuple[Optional[int], bool]:
    """Read status or stop promptly when the combined output cap is crossed."""

    deadline = time.monotonic() + timeout
    try:
        while True:
            if output_limit_event is not None and output_limit_event.is_set():
                return None, True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, False
            wait_seconds = (
                remaining
                if output_limit_event is None
                else min(remaining, 0.05)
            )
            try:
                readable, _writable, _errors = select.select(
                    [descriptor], [], [], wait_seconds
                )
            except InterruptedError:
                continue
            if not readable:
                if output_limit_event is None:
                    return None, False
                continue
            payload = os.read(descriptor, 64)
            if output_limit_event is not None and output_limit_event.is_set():
                return None, True
            if re.fullmatch(rb"-?[0-9]{1,10}\n", payload) is None:
                return 125, False
            return int(payload), False
    finally:
        os.close(descriptor)


def run_check(
    command: List[str], root: Path, timeout: int, environment: Dict[str, str]
) -> Tuple[int, str, bool, bool, bool]:
    supervisor = None
    status_descriptor = None
    control_descriptor = None
    ack_descriptor = None
    if os.name != "posix":
        raise RuntimeError("reviewed checks require native macOS or native Linux")
    (
        supervisor,
        output_stream,
        status_descriptor,
        control_descriptor,
        ack_descriptor,
    ) = start_posix_supervisor(command, root, environment)
    captured = bytearray()
    truncated = [False]
    output_limit_event = threading.Event()
    capture_incomplete_event = threading.Event()

    def drain() -> None:
        read_chunk = getattr(output_stream, "read1", output_stream.read)
        while True:
            try:
                # BufferedReader.read() waits to fill the requested size. read1()
                # returns currently available pipe bytes, so the first byte past
                # the cap triggers containment without waiting for child exit.
                chunk = read_chunk(8192)
            except (OSError, ValueError):
                truncated[0] = True
                capture_incomplete_event.set()
                break
            if not chunk:
                break
            available = MAX_OUTPUT_BYTES - len(captured)
            if available > 0:
                captured.extend(chunk[:available])
            if len(chunk) > available:
                truncated[0] = True
                output_limit_event.set()
                break

    reader = threading.Thread(target=drain, name="bounded-check-output", daemon=True)
    reader.start()
    timed_out = False
    return_code = 1
    operation_error: Optional[BaseException] = None
    try:
        if (
            supervisor is None
            or status_descriptor is None
            or control_descriptor is None
            or ack_descriptor is None
        ):
            raise RuntimeError("POSIX supervisor ownership state is incomplete")
        return_code, output_limited = read_supervisor_status(
            status_descriptor, timeout, output_limit_event
        )
        timed_out = return_code is None
        if output_limited:
            timed_out = False
        if return_code is None:
            return_code = 1
    except BaseException as exc:
        operation_error = exc
    finally:
        try:
            if os.name == "posix":
                if (
                    supervisor is not None
                    and control_descriptor is not None
                    and ack_descriptor is not None
                ):
                    stop_posix_process_group(
                        supervisor, control_descriptor, ack_descriptor
                    )
        except BaseException as exc:
            if operation_error is None or isinstance(exc, ProcessContainmentError):
                operation_error = exc
        reader.join(timeout=3)
        if reader.is_alive():
            truncated[0] = True
            capture_incomplete_event.set()
            try:
                output_stream.close()
            except OSError:
                pass
            reader.join(timeout=1)
        else:
            try:
                output_stream.close()
            except OSError:
                pass
    if operation_error is not None:
        raise operation_error
    output_limited = output_limit_event.is_set()
    capture_incomplete = capture_incomplete_event.is_set()
    if output_limited or capture_incomplete:
        return_code = 1
    if output_limited:
        timed_out = False
    return (
        return_code,
        redact_output(bytes(captured), truncated[0]),
        timed_out,
        output_limited,
        capture_incomplete,
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    runtime_denial = standalone_runtime_denial()
    if runtime_denial is not None:
        print("ERROR: {}".format(runtime_denial), file=sys.stderr)
        return 2
    args = parse_args(argv)
    root = Path(__file__).resolve().parent.parent
    try:
        contract, digest = read_contract(root / "project-checks.json")
        checks = load_checks(contract)
    except (OSError, RuntimeError) as exc:
        print("ERROR: {}".format(exc), file=sys.stderr)
        return 2
    if not args.execute_reviewed:
        list_checks(checks, digest)
        return 0
    if not re.fullmatch(r"[0-9a-f]{64}", args.execute_reviewed) or args.execute_reviewed != digest:
        print("ERROR: reviewed digest does not match exact project-checks.json bytes", file=sys.stderr)
        return 2
    if not checks:
        print("ERROR: no checks configured", file=sys.stderr)
        return 2
    try:
        validate_repo_identity(root)
    except RuntimeError as exc:
        print("ERROR: {}".format(exc), file=sys.stderr)
        return 2
    selected = set(args.check or [])
    unknown = selected - {str(item["name"]) for item in checks}
    if unknown:
        print("ERROR: unknown checks: {}".format(", ".join(sorted(unknown))), file=sys.stderr)
        return 2
    selected_checks = [
        item for item in checks if not selected or str(item["name"]) in selected
    ]
    selected_timeout_seconds = sum(
        int(item.get("timeout_seconds", 600)) for item in selected_checks
    )
    if selected_timeout_seconds > MAX_SELECTED_TIMEOUT_SECONDS:
        print(
            "ERROR: selected checks exceed the {} second aggregate timeout limit".format(
                MAX_SELECTED_TIMEOUT_SECONDS
            ),
            file=sys.stderr,
        )
        return 2
    print(
        "NOTICE: acknowledgements do not provide OS, container or network sandboxing; "
        "detached descendants are not contained."
    )
    failures = skipped = executed = 0
    with tempfile.TemporaryDirectory(prefix="personal-ai-check-") as temporary:
        environment = minimal_environment(Path(temporary))
        for item in checks:
            name = str(item["name"])
            if selected and name not in selected:
                continue
            if item.get("requires_network", False) and not args.allow_network:
                print("SKIP {}: requires --allow-network".format(name))
                skipped += 1
                continue
            if item.get("mode", "read-only") == "writes" and not args.allow_writes:
                print("SKIP {}: requires --allow-writes".format(name))
                skipped += 1
                continue
            print("RUN {}: argv hidden; reviewed contract digest={}".format(name, digest))
            executed += 1
            try:
                code, output, timed_out, output_limited, capture_incomplete = run_check(
                    [str(part) for part in item["command"]], root,
                    int(item.get("timeout_seconds", 600)), environment,
                )
            except ProcessContainmentError:
                print("FAIL {}: process containment failed safely".format(name))
                failures += 1
                break
            except (FileNotFoundError, OSError) as exc:
                print("FAIL {}: process could not start ({})".format(name, type(exc).__name__))
                failures += 1
                continue
            if output:
                print(output, end="" if output.endswith("\n") else "\n")
            if output_limited:
                print(
                    "FAIL {}: output limit exceeded; process group terminated; result incomplete".format(
                        name
                    )
                )
                failures += 1
            elif capture_incomplete:
                print(
                    "FAIL {}: output capture incomplete; process group terminated; result incomplete".format(
                        name
                    )
                )
                failures += 1
            elif timed_out:
                print("FAIL {}: timeout; process group terminated".format(name))
                failures += 1
            elif code:
                print("FAIL {}: exit {}".format(name, code))
                failures += 1
            else:
                print("PASS {}".format(name))
    print("SUMMARY: failures={} skipped={} executed={}".format(failures, skipped, executed))
    if executed == 0:
        print("INCOMPLETE: no selected checks executed", file=sys.stderr)
        return 1
    if skipped and not args.allow_skips:
        print("INCOMPLETE: selected checks were skipped", file=sys.stderr)
        return 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
