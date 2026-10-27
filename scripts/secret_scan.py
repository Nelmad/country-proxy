#!/usr/bin/env python3
"""High-precision secret detectors shared by Workspace safety gates.

The BIP39 detector validates both the English word list and the mnemonic
checksum. This avoids treating an arbitrary sentence made from common words as
a seed phrase while still enforcing the portable no-secrets invariant.
"""

import hashlib
import os
import re
import stat
import unicodedata
from collections import deque
from functools import lru_cache
from html.entities import html5 as HTML5_ENTITIES
from pathlib import Path
from typing import Deque, Dict, List, Optional, Sequence, Tuple


BIP39_WORDLIST_PATH = Path(__file__).resolve().parents[1] / "config" / "bip39-english.txt"
BIP39_WORDLIST_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
BIP39_WORDLIST_PORTABLE_PATHS = {
    "config/bip39-english.txt",
    "blueprints/code-repo/scripts/bip39-english.txt",
}
BIP39_WORD_COUNTS = (12, 15, 18, 21, 24)
MAX_WORDLIST_BYTES = 32_768
MAX_UNIQUE_CANDIDATES = 100_000
ASCII_WORD_RE = re.compile(r"[A-Za-z]+")
HTML_TOKEN_START_RE = re.compile(r"[<&]")
HTML_LINE_BREAK_TAGS = {
    "article", "blockquote", "br", "div", "footer", "header", "hr", "li",
    "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
}
MAX_HTML_TOKEN_CHARS = 4096
MAX_HTML_ENTITY_CHARS = 64
MAX_LABELLED_VALUE_CHARS = 16_384
MAX_LABEL_GAP_CHARS = 256
MAX_ANSI_SEQUENCE_CHARS = 256
LABELLED_SECRET_RE = re.compile(
    r"(?i)\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|"
    r"client[-_ ]?secret|private[-_ ]?key|password|passwd|credential|token|secret)\b"
)
LABELLED_SECRET_FULL_RE = re.compile(
    r"(?i)^(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|"
    r"client[-_ ]?secret|private[-_ ]?key|password|passwd|credential|token|secret)$"
)
BENIGN_SECRET_GUIDANCE_RE = re.compile(
    r"(?ix)^(?:"
    r"(?:ask|contact)\s+(?:the\s+)?(?:owner|administrator)"
    r"(?:\s+before\s+(?:use|deployment|running|sharing))?|"
    r"(?:not|never|do\s+not|don't)\s+(?:store|stored|include|included|commit|save)(?:\s+.*)?|"
    r"(?:read|load|fetch|retrieve|get|obtain|inject|provide|provided|set|stored|managed)"
    r"(?:\s+.*)?\s+(?:environment|env|runtime|strongbox|secret\s+manager|owner)"
    r"(?:\s+(?:variable|variables|var|vars|configuration|config|entry|reference|value))?|"
    r"(?:use|see)\s+(?:the\s+)?(?:environment|env|runtime|strongbox|secret\s+manager)"
    r"(?:\s+(?:variable|variables|var|vars|configuration|config|entry|reference|value))?|"
    r"(?:redacted|disabled|unset|none|null|deny|denied|not\s+configured)"
    r")[.!]?$"
)
INLINE_RECOVERY_FILENAME_LABEL_RE = re.compile(
    r"(?i)(?:^|[-_. ])(?:recovery|backup)[-_ ]?codes?(?=$|[-_. ])"
)
BENIGN_RECOVERY_FILENAME_PAYLOAD_RE = re.compile(
    r"(?i)^(?:disabled|unset|none|null|template|example|guide|instructions?|"
    r"not[-_. ]?stored(?:[-_. ]?here)?|"
    r"retrieve[-_. ]?from[-_. ]?strongbox)$"
)
RECOVERY_FILENAME_EXTENSIONS = {
    "bak", "cfg", "conf", "csv", "htm", "html", "ini", "js", "json", "log",
    "markdown", "md", "old", "py", "rb", "sh", "text", "ts", "tsv", "txt",
    "xml", "yaml", "yml",
}
SAFE_SECRET_REFERENCE_RE = re.compile(
    r"^(?:(?:os\.getenv|os\.environ\.get|System\.getenv|ENV\.fetch|Deno\.env\.get)"
    r"\([\"'][A-Za-z_][A-Za-z0-9_./:-]{0,127}[\"']"
    r"(?:,\s*(?:None|null|nil|[\"'][\"']))?\)|"
    r"(?:os\.environ|ENV|process\.env)\[[\"'][A-Za-z_][A-Za-z0-9_./:-]{0,127}[\"']\]|"
    r"process\.env\.[A-Za-z_][A-Za-z0-9_]*|"
    r"(?:strongbox\.get|secret_manager\.get|classes\.get)"
    r"\([\"'][A-Za-z0-9_./:-]{1,128}[\"']\))$"
)
SAFE_TEMPLATE_SECRET_REFERENCE_RE = re.compile(
    r"^(?:\$\{\{\s*(?:secrets|env)\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}|"
    r"\$env:[A-Za-z_][A-Za-z0-9_]*)$",
    re.IGNORECASE,
)
TOML_DOTTED_KEY_PREFIX_RE = re.compile(
    r"^\s*(?:[A-Za-z0-9_-]+|\"[^\"\r\n]+\"|'[^'\r\n]+')"
    r"(?:\s*\.\s*(?:[A-Za-z0-9_-]+|\"[^\"\r\n]+\"|'[^'\r\n]+'))*\s*\.\s*$"
)
PRIVATE_RECOVERY_BASENAME_PREFIXES = (
    ".abandoned-transaction-",
    ".bridge-",
    ".committed-prestate-",
    ".discarded-empty-parent-",
    ".discarded-owned-file-",
    ".discarded-poststate-",
    ".domain-",
    ".domains-",
    ".personal-ai-package-",
    ".personal-ai-package-prior-",
    ".retained-original-",
    ".retained-public-file-",
    ".rollback-directory-",
    ".rollback-discard-",
    ".rollback-poststate-",
    ".personal-ai-bootstrap-",
    ".personal-ai-workspace-abandoned-",
    ".personal-ai-workspace-bridge-",
    ".personal-ai-workspace-cleaned-",
    ".personal-ai-workspace-cleanup-",
    ".personal-ai-workspace-git-discard-",
    ".personal-ai-workspace-git-recovery-",
    ".personal-ai-workspace-git-stage-",
    ".personal-ai-workspace-parent-probe",
    ".personal-ai-workspace-published-",
    ".personal-ai-workspace-quarantine-",
    ".personal-ai-workspace-retained-public-",
    ".personal-ai-workspace-rollback-",
    ".personal-ai-workspace-root-probe",
    ".personal-ai-workspace-write-",
    ".portable-restore-stage-",
    ".transaction-",
    ".transaction-directory-",
)
RECOVERY_LABEL_RE = re.compile(
    r"(?i)^(?:--?)?(?:recovery|backup)[-_ ]?codes?$"
)
RECOVERY_LABEL_TEXT_RE = re.compile(
    r"(?i)\b(?:recovery|backup)[-_ ]?codes?\b"
)
NETRC_MACRO_END_RE = re.compile(r"(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)")
NETRC_FIELD_KEYWORDS = frozenset({"login", "user", "account", "password"})
RECOVERY_CODE_RE = re.compile(
    r"^(?:[A-Za-z0-9][A-Za-z0-9_-]{5,}|"
    r"[A-Za-z0-9]{3,8}(?:[ -][A-Za-z0-9]{3,8})+)$"
)
POSITIONAL_MNEMONIC_RE = re.compile(
    r"(?im)(?<![A-Za-z0-9_])(?P<family>w|word|seed[_-]?word|mnemonic[_-]?word)"
    r"[_-]?(?P<number>[1-9]|1[0-9]|2[0-4])[\"']?[ \t]*(?::|=)[ \t]*"
    r"[\"']?(?P<value>[a-z]+)"
)
POSITIONAL_MNEMONIC_KEY_RE = re.compile(
    r"(?i)^(?P<family>w|word|seed[_-]?word|mnemonic[_-]?word)"
    r"[_-]?(?P<number>[1-9]|1[0-9]|2[0-4])$"
)
PUTTY_HEADER_RE = re.compile(r"(?im)^[ \t]*PuTTY-User-Key-File-[23]:[^\r\n]*$")
PUTTY_PRIVATE_FIELD_RE = re.compile(r"(?im)^[ \t]*Private-(?:Lines|MAC):[^\r\n]*$")
PRIVATE_KEY_BEGIN_TOKEN_RE = re.compile(
    r"-----BEGIN (?P<label>(?:(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY|"
    r"PGP PRIVATE KEY BLOCK))-----"
)
SECRET_TOKEN_PATTERNS = (
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{30,255}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,255}\b"),
    re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{30,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
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


class SecretScanConfigurationError(ValueError):
    """A detector dependency is missing or cannot be trusted."""


def _read_bounded_regular_file(path: Path, maximum_bytes: int) -> bytes:
    if os.name == "nt":
        raise SecretScanConfigurationError(
            "Windows support is postponed; use native macOS or native Linux"
        )
    if not getattr(os, "O_NOFOLLOW", 0) or os.open not in getattr(os, "supports_dir_fd", set()):
        raise SecretScanConfigurationError("secure BIP39 word-list reads are unavailable")
    parent_flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    try:
        parent_descriptor = os.open(str(path.parent), parent_flags)
    except OSError as exc:
        raise SecretScanConfigurationError("BIP39 word-list directory cannot be opened safely") from exc
    try:
        parent_stat = os.fstat(parent_descriptor)
        if not stat.S_ISDIR(parent_stat.st_mode):
            raise SecretScanConfigurationError("BIP39 word-list parent must be a directory")
        try:
            descriptor = os.open(path.name, flags, dir_fd=parent_descriptor)
        except OSError as exc:
            raise SecretScanConfigurationError("BIP39 word list cannot be opened safely") from exc
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise SecretScanConfigurationError("BIP39 word list must be a single-link regular file")
            if before.st_size > maximum_bytes:
                raise SecretScanConfigurationError("BIP39 word list exceeds its size limit")
            chunks: List[bytes] = []
            remaining = maximum_bytes + 1
            while remaining > 0:
                chunk = os.read(descriptor, min(65_536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            after = os.fstat(descriptor)
            stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
            if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
                raise SecretScanConfigurationError("BIP39 word list changed while it was read")
            if len(data) > maximum_bytes or len(data) != after.st_size:
                raise SecretScanConfigurationError("BIP39 word list could not be read completely")
            return data
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_descriptor)


@lru_cache(maxsize=1)
def bip39_word_index() -> Dict[str, int]:
    data = _read_bounded_regular_file(BIP39_WORDLIST_PATH, MAX_WORDLIST_BYTES)
    if hashlib.sha256(data).hexdigest() != BIP39_WORDLIST_SHA256:
        raise SecretScanConfigurationError("BIP39 word list digest does not match the reviewed source")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SecretScanConfigurationError("BIP39 word list is not valid UTF-8") from exc
    words = text.splitlines()
    if (
        len(words) != 2048
        or words != sorted(words)
        or len(set(words)) != 2048
        or any(not re.fullmatch(r"[a-z]+", word) for word in words)
    ):
        raise SecretScanConfigurationError("BIP39 word list structure is invalid")
    return {word: index for index, word in enumerate(words)}


def is_reviewed_bip39_wordlist(relative_path: str, data: bytes) -> bool:
    """Allow only the exact reviewed detector corpus at its canonical paths."""

    return (
        relative_path in BIP39_WORDLIST_PORTABLE_PATHS
        and hashlib.sha256(data).hexdigest() == BIP39_WORDLIST_SHA256
    )


def _valid_bip39_checksum(indices: Sequence[int]) -> bool:
    checksum_bits = len(indices) // 3
    entropy_bits = len(indices) * 11 - checksum_bits
    packed = 0
    for index in indices:
        packed = (packed << 11) | index
    supplied_checksum = packed & ((1 << checksum_bits) - 1)
    entropy = (packed >> checksum_bits).to_bytes(entropy_bits // 8, "big")
    expected_checksum = hashlib.sha256(entropy).digest()[0] >> (8 - checksum_bits)
    return supplied_checksum == expected_checksum


def _valid_display_separator(value: str) -> bool:
    """Allow common reversible seed displays without accepting prose punctuation."""

    # Tokenization already visits every ASCII word and resets the candidate run
    # when that word is not in BIP39. Between two candidate words, accept any
    # non-letter framing (JSON quotes, slashes, bullets, numbering, punctuation)
    # so a reversible display format cannot bypass the checksum gate. A real
    # intervening word in any script still breaks the phrase.
    return bool(value) and not any(character.isalpha() for character in value)


def _html_tag_end(text: str, start: int) -> Tuple[int, str]:
    """Return the bounded end/name of one syntactically closed HTML tag."""

    limit = min(len(text), start + MAX_HTML_TOKEN_CHARS)
    cursor = start + 1
    if text.startswith("<!--", start):
        if text.find("<!--", start + 4, limit) >= 0:
            return start, ""
        end = text.find("-->", cursor + 3, limit)
        return ((end + 3, "") if end >= 0 else (start, ""))
    if cursor < limit and text[cursor] == "/":
        cursor += 1
    while cursor < limit and text[cursor].isspace():
        cursor += 1
    name_start = cursor
    if cursor < limit and text[cursor] in "!?":
        cursor += 1
        name = ""
    else:
        if cursor >= limit or not text[cursor].isalpha():
            return start, ""
        cursor += 1
        while cursor < limit and (text[cursor].isalnum() or text[cursor] in "_:-"):
            cursor += 1
        name = text[name_start:cursor].casefold()

    quote = ""
    while cursor < limit:
        character = text[cursor]
        if quote:
            if character == quote:
                quote = ""
        elif character in "\"'":
            quote = character
        elif character == "<":
            return start, ""
        elif character == ">":
            return cursor + 1, name
        cursor += 1
    return start, ""


def _html_entity_end(text: str, start: int) -> int:
    """Return the bounded end of one named or numeric HTML entity."""

    limit = min(len(text), start + MAX_HTML_ENTITY_CHARS)
    cursor = start + 1
    if cursor < limit and text[cursor] == "#":
        cursor += 1
        hexadecimal = cursor < limit and text[cursor] in "xX"
        if hexadecimal:
            cursor += 1
        digit_start = cursor
        valid_digits = "0123456789abcdefABCDEF" if hexadecimal else "0123456789"
        maximum_digits = 6 if hexadecimal else 7
        while (
            cursor < limit
            and cursor - digit_start < maximum_digits
            and text[cursor] in valid_digits
        ):
            cursor += 1
        if cursor == digit_start:
            return start
        return cursor + 1 if cursor < len(text) and text[cursor] == ";" else cursor

    name_start = cursor
    while cursor < limit and cursor - name_start < 32 and text[cursor].isalnum():
        cursor += 1
    if cursor == name_start:
        return start
    if cursor < len(text) and text[cursor] == ";":
        return cursor + 1
    # HTML5 retains a small reviewed set of legacy named references that may
    # omit the semicolon. Match only names recognized by the standard library
    # so ordinary ampersand prose does not become a separator.
    name = text[name_start:cursor]
    for length in range(len(name), 0, -1):
        if name[:length] in HTML5_ENTITIES:
            return name_start + length
    return start


def _mask_common_html_layout(text: str, line_breaks: bool) -> str:
    """Mask HTML tags/entities with equal-width separators.

    The tokenizer recognizes every ordinary tag name and every named/numeric
    entity instead of maintaining a bypass-prone whitelist. Lookahead for a
    single token is capped, and the equal-width replacement keeps source spans
    valid for redacting the original text.
    """

    chunks: List[str] = []
    cursor = 0
    for match in HTML_TOKEN_START_RE.finditer(text):
        start = match.start()
        if start < cursor:
            continue
        name = ""
        if text[start] == "<":
            end, name = _html_tag_end(text, start)
        else:
            end = _html_entity_end(text, start)
        if end <= start:
            continue
        chunks.append(text[cursor:start])
        if line_breaks and name in HTML_LINE_BREAK_TAGS:
            chunks.append("\n" + (" " * (end - start - 1)))
        else:
            chunks.append(" " * (end - start))
        cursor = end
    if not chunks:
        return text
    chunks.append(text[cursor:])
    return "".join(chunks)


def _positional_mnemonic_spans(
    text: str, word_index: Dict[str, int]
) -> List[Tuple[int, int]]:
    spans: List[Tuple[int, int]] = []
    clusters: Dict[str, List[List[Tuple[int, int, int, int]]]] = {}
    for match in POSITIONAL_MNEMONIC_RE.finditer(text):
        family = re.sub(r"[-_]", "", match.group("family").casefold())
        number = int(match.group("number"))
        index = word_index.get(match.group("value").casefold())
        if index is None:
            continue
        family_clusters = clusters.setdefault(family, [[]])
        cluster = family_clusters[-1]
        duplicate = any(item[2] == number for item in cluster)
        too_far = bool(cluster) and match.start() - cluster[-1][1] > 512
        if duplicate or too_far:
            cluster = []
            family_clusters.append(cluster)
        cluster.append((match.start(), match.end(), number, index))
    for family_clusters in clusters.values():
        for cluster in family_clusters:
            numbered = {item[2]: item for item in cluster}
            for word_count in BIP39_WORD_COUNTS:
                if not all(number in numbered for number in range(1, word_count + 1)):
                    continue
                selected = [numbered[number] for number in range(1, word_count + 1)]
                if _valid_bip39_checksum(tuple(item[3] for item in selected)):
                    spans.append(
                        (min(item[0] for item in selected), max(item[1] for item in selected))
                    )
    return spans


def bip39_mnemonic_spans(text: str) -> List[Tuple[int, int]]:
    """Return merged spans of checksum-valid English BIP39 mnemonics."""

    word_index = bip39_word_index()
    scan_text = _mask_common_html_layout(text, line_breaks=False)
    run: List[Tuple[int, int, int]] = []
    spans: List[Tuple[int, int]] = []
    checksum_cache: Dict[Tuple[int, ...], bool] = {}
    previous_end = -1
    for match in ASCII_WORD_RE.finditer(scan_text):
        separator = scan_text[previous_end:match.start()] if previous_end >= 0 else ""
        index = word_index.get(match.group(0).casefold())
        if index is None or (run and not _valid_display_separator(separator)):
            run = []
        if index is not None:
            run.append((match.start(), match.end(), index))
            if len(run) > max(BIP39_WORD_COUNTS):
                del run[0]
            for word_count in BIP39_WORD_COUNTS:
                if len(run) < word_count:
                    continue
                candidate = tuple(item[2] for item in run[-word_count:])
                valid = checksum_cache.get(candidate)
                if valid is None:
                    if len(checksum_cache) >= MAX_UNIQUE_CANDIDATES:
                        raise SecretScanConfigurationError("BIP39 scan exceeded its candidate limit")
                    valid = _valid_bip39_checksum(candidate)
                    checksum_cache[candidate] = valid
                if valid:
                    spans.append((run[-word_count][0], run[-1][1]))
        previous_end = match.end()

    spans.extend(_positional_mnemonic_spans(scan_text, word_index))
    if not spans:
        return []
    spans.sort()
    merged: List[Tuple[int, int]] = [spans[0]]
    for start, end in spans[1:]:
        old_start, old_end = merged[-1]
        if start <= old_end:
            merged[-1] = (old_start, max(old_end, end))
        else:
            merged.append((start, end))
    return merged


def contains_bip39_mnemonic(text: str) -> bool:
    return bool(bip39_mnemonic_spans(text))


def contains_bip39_mnemonic_sequence(values: Sequence[object]) -> bool:
    """Detect a mnemonic split across adjacent JSON/argv scalar elements."""

    strings = [value for value in values if isinstance(value, str)]
    return bool(strings) and contains_bip39_mnemonic(" ".join(strings))


def mapping_has_bip39_mnemonic(value: object) -> bool:
    """Detect checksum-valid mnemonics stored under w1/word1/... keys."""

    if not isinstance(value, dict):
        return False
    families: Dict[str, Dict[int, int]] = {}
    word_index = bip39_word_index()
    for key, nested in value.items():
        if not isinstance(key, str) or not isinstance(nested, str):
            continue
        match = POSITIONAL_MNEMONIC_KEY_RE.fullmatch(key.strip().strip("\"'"))
        if match is None:
            continue
        index = word_index.get(nested.strip().strip("\"'").casefold())
        if index is None:
            continue
        family = re.sub(r"[-_]", "", match.group("family").casefold())
        families.setdefault(family, {})[int(match.group("number"))] = index
    for numbered in families.values():
        for word_count in BIP39_WORD_COUNTS:
            if all(number in numbered for number in range(1, word_count + 1)):
                indices = tuple(numbered[number] for number in range(1, word_count + 1))
                if _valid_bip39_checksum(indices):
                    return True
    return False


def _merge_spans(spans: Sequence[Tuple[int, int]]) -> List[Tuple[int, int]]:
    if not spans:
        return []
    ordered = sorted(spans)
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        old_start, old_end = merged[-1]
        if start <= old_end:
            merged[-1] = (old_start, max(old_end, end))
        else:
            merged.append((start, end))
    return merged


def _redact_spans(text: str, spans: Sequence[Tuple[int, int]]) -> str:
    if not spans:
        return text
    chunks: List[str] = []
    cursor = 0
    for start, end in _merge_spans(spans):
        chunks.extend((text[cursor:start], "[REDACTED]"))
        cursor = end
    chunks.append(text[cursor:])
    return "".join(chunks)


ANSI_C1_STRING_STARTS = {"\x90", "\x98", "\x9d", "\x9e", "\x9f"}
ANSI_ESC_STRING_STARTS = {"P", "X", "]", "^", "_"}


def _ansi_sequence_bounds(text: str, start: int) -> Tuple[int, bool]:
    """Return (bounded end, complete) for one ANSI/C1 sequence."""

    limit = min(len(text), start + MAX_ANSI_SEQUENCE_CHARS)
    if text[start] == "\x9b":
        cursor = start + 1
        while cursor < limit:
            if "@" <= text[cursor] <= "~":
                return cursor + 1, True
            cursor += 1
        return start + 1, False
    if text[start] in ANSI_C1_STRING_STARTS:
        cursor = start + 1
        while cursor < limit:
            if text[cursor] == "\x9c":
                return cursor + 1, True
            if text[start] == "\x9d" and text[cursor] == "\x07":
                return cursor + 1, True
            if text[cursor] == "\x1b" and cursor + 1 < limit and text[cursor + 1] == "\\":
                return cursor + 2, True
            cursor += 1
        return start + 1, False
    if text[start] != "\x1b" or start + 1 >= len(text):
        return start + 1, False
    introducer = text[start + 1]
    if introducer == "[":
        cursor = start + 2
        while cursor < limit:
            if "@" <= text[cursor] <= "~":
                return cursor + 1, True
            cursor += 1
        return min(len(text), start + 2), False
    if introducer in ANSI_ESC_STRING_STARTS:
        cursor = start + 2
        while cursor < limit:
            if text[cursor] == "\x9c":
                return cursor + 1, True
            if introducer == "]" and text[cursor] == "\x07":
                return cursor + 1, True
            if text[cursor] == "\x1b" and cursor + 1 < limit and text[cursor + 1] == "\\":
                return cursor + 2, True
            cursor += 1
        return min(len(text), start + 2), False
    return min(len(text), start + 2), True


def _has_malformed_ansi(text: str) -> bool:
    cursor = 0
    recognized = ANSI_C1_STRING_STARTS | {"\x1b", "\x9b"}
    while cursor < len(text):
        if text[cursor] not in recognized:
            cursor += 1
            continue
        end, complete = _ansi_sequence_bounds(text, cursor)
        if not complete:
            return True
        cursor = end
    return False


def _control_stripped_view(
    text: str, preserve_layout: bool = False
) -> Tuple[str, List[int]]:
    """Remove display controls while retaining an index map to source text."""

    characters: List[str] = []
    offsets: List[int] = []
    cursor = 0
    while cursor < len(text):
        character = text[cursor]
        codepoint = ord(character)
        if character in ANSI_C1_STRING_STARTS | {"\x1b", "\x9b"}:
            cursor, _complete = _ansi_sequence_bounds(text, cursor)
            continue
        if (
            not (preserve_layout and character in {"\n", "\r", "\t"})
            and (
                unicodedata.category(character) in {"Cc", "Cf", "Cs"}
                or codepoint == 0x034F
                or 0xFE00 <= codepoint <= 0xFE0F
                or 0xE0100 <= codepoint <= 0xE01EF
            )
        ):
            cursor += 1
            continue
        characters.append(character)
        offsets.append(cursor)
        cursor += 1
    return "".join(characters), offsets


def _control_introducer_stripped_view(text: str) -> Tuple[str, List[int]]:
    """Retain ambiguous ANSI final bytes while removing their introducers."""

    characters: List[str] = []
    offsets: List[int] = []
    cursor = 0
    while cursor < len(text):
        character = text[cursor]
        codepoint = ord(character)
        if character == "\x1b":
            if cursor + 1 < len(text) and text[cursor + 1] in ({"["} | ANSI_ESC_STRING_STARTS):
                cursor += 2
            else:
                cursor += 1
            continue
        if character == "\x9b" or character in ANSI_C1_STRING_STARTS:
            cursor += 1
            continue
        if (
            unicodedata.category(character) in {"Cc", "Cf", "Cs"}
            or codepoint == 0x034F
            or 0xFE00 <= codepoint <= 0xFE0F
            or 0xE0100 <= codepoint <= 0xE01EF
        ):
            cursor += 1
            continue
        characters.append(character)
        offsets.append(cursor)
        cursor += 1
    return "".join(characters), offsets


def _map_view_spans(
    spans: Sequence[Tuple[int, int]], offsets: Sequence[int]
) -> List[Tuple[int, int]]:
    mapped: List[Tuple[int, int]] = []
    for start, end in spans:
        if start < end and end <= len(offsets):
            mapped.append((offsets[start], offsets[end - 1] + 1))
    return mapped


def _pattern_spans(text: str, patterns: Sequence[re.Pattern]) -> List[Tuple[int, int]]:
    return [match.span() for pattern in patterns for match in pattern.finditer(text)]


def _private_key_token_spans(text: str) -> List[Tuple[int, int]]:
    """Locate private-key blocks linearly and fail closed on a missing END."""

    spans: List[Tuple[int, int]] = []
    cursor = 0
    while cursor < len(text):
        begin = PRIVATE_KEY_BEGIN_TOKEN_RE.search(text, cursor)
        if begin is None:
            break
        end_marker = "-----END {}-----".format(begin.group("label"))
        end_start = text.find(end_marker, begin.end())
        if end_start < 0:
            spans.append((begin.start(), len(text)))
            break
        end = end_start + len(end_marker)
        spans.append((begin.start(), end))
        cursor = end
    return spans


def secret_token_spans(text: str) -> List[Tuple[int, int]]:
    """Locate standard tokens, including ANSI/control-interleaved forms."""

    if text and _has_malformed_ansi(text):
        return [(0, len(text))]
    spans = _private_key_token_spans(text)
    spans.extend(_pattern_spans(text, SECRET_TOKEN_PATTERNS))
    visible, offsets = _control_stripped_view(text)
    if len(visible) != len(text):
        visible_spans = _private_key_token_spans(visible)
        visible_spans.extend(_pattern_spans(visible, SECRET_TOKEN_PATTERNS))
        spans.extend(_map_view_spans(visible_spans, offsets))
        ambiguous, ambiguous_offsets = _control_introducer_stripped_view(text)
        ambiguous_spans = _private_key_token_spans(ambiguous)
        ambiguous_spans.extend(_pattern_spans(ambiguous, SECRET_TOKEN_PATTERNS))
        spans.extend(_map_view_spans(ambiguous_spans, ambiguous_offsets))
    return _merge_spans(spans)


def contains_secret_token(text: str) -> bool:
    return bool(secret_token_spans(text))


def redact_secret_tokens(text: str) -> str:
    return _redact_spans(text, secret_token_spans(text))


def contains_putty_private_key(text: str) -> bool:
    for header in PUTTY_HEADER_RE.finditer(text):
        if PUTTY_PRIVATE_FIELD_RE.search(text, header.end()) is not None:
            return True
    return False


def redact_putty_private_keys(text: str) -> str:
    for header in PUTTY_HEADER_RE.finditer(text):
        if PUTTY_PRIVATE_FIELD_RE.search(text, header.end()) is not None:
            # A PPK has no reliable end sentinel. Once its paired private field
            # is present, withhold the remainder rather than leaking key lines.
            return text[:header.start()] + "[REDACTED]"
    return text


def _next_netrc_token(
    text: str, cursor: int
) -> Tuple[Optional[Tuple[str, int, int]], int]:
    """Read one shell-like netrc token without unbounded lookahead storage."""

    while cursor < len(text):
        if text[cursor].isspace():
            cursor += 1
            continue
        if text[cursor] == "#":
            newline = text.find("\n", cursor + 1)
            cursor = len(text) if newline < 0 else newline + 1
            continue
        break
    if cursor >= len(text):
        return None, cursor

    start = cursor
    value: List[str] = []
    quote = text[cursor] if text[cursor] in "\"'" else ""
    if quote:
        cursor += 1
    while cursor < len(text):
        character = text[cursor]
        if character == "\\" and cursor + 1 < len(text):
            if len(value) < 64:
                value.append(text[cursor + 1])
            cursor += 2
            continue
        if quote:
            if character == quote:
                cursor += 1
                break
        elif character.isspace():
            break
        if len(value) < 64:
            value.append(character)
        cursor += 1
    return ("".join(value), start, cursor), cursor


def netrc_credential_spans(text: str) -> List[Tuple[int, int]]:
    """Locate populated password fields in whitespace-tokenized netrc stanzas."""

    spans: List[Tuple[int, int]] = []
    cursor = 0
    stanza_start = -1
    while cursor < len(text):
        token, cursor = _next_netrc_token(text, cursor)
        if token is None:
            break
        value, start, _end = token
        # netrc control words are case-sensitive in the standard grammar.
        keyword = value
        if keyword == "machine":
            host, cursor = _next_netrc_token(text, cursor)
            stanza_start = start if host is not None and bool(host[0]) else -1
            continue
        if keyword == "default":
            stanza_start = start
            continue
        if keyword == "macdef":
            _name, cursor = _next_netrc_token(text, cursor)
            blank = NETRC_MACRO_END_RE.search(text, cursor)
            cursor = len(text) if blank is None else blank.end()
            stanza_start = -1
            continue
        if stanza_start < 0:
            continue
        if keyword not in NETRC_FIELD_KEYWORDS:
            # A netrc stanza is a sequence of exact keyword/value pairs.  Do
            # not keep a prose occurrence of ``machine`` or ``default`` alive
            # until an unrelated later occurrence of ``password``.
            stanza_start = -1
            continue
        field_value, cursor = _next_netrc_token(text, cursor)
        if field_value is None or not field_value[0]:
            stanza_start = -1
            continue
        if keyword == "password":
            spans.append((stanza_start, field_value[2]))
    return _merge_spans(spans)


def contains_netrc_credentials(text: str) -> bool:
    return bool(netrc_credential_spans(text))


def redact_netrc_credentials(text: str) -> str:
    return _redact_spans(text, netrc_credential_spans(text))


def _bounded_assignment_cursor(text: str, cursor: int) -> int:
    limit = min(len(text), cursor + MAX_LABEL_GAP_CHARS)
    while cursor < limit and text[cursor].isspace():
        cursor += 1
    if cursor == limit and cursor < len(text) and text[cursor].isspace():
        return -1
    return cursor


def _labelled_scalar_tail(
    text: str, value_start: int, token_end: int
) -> Tuple[int, bool]:
    """Extend a scalar through meaningful same-line suffixes, boundedly."""

    limit = min(len(text), value_start + MAX_LABELLED_VALUE_CHARS)
    probe = token_end
    while probe < limit and text[probe] in " \t":
        probe += 1
    if (
        probe >= len(text)
        or probe >= limit
        or text[probe] in "\r\n,;)}]"
        or text.startswith("#", probe)
        or text.startswith("//", probe)
    ):
        return token_end, probe >= limit and probe < len(text)

    cursor = token_end
    quote = ""
    stack: List[str] = []
    pairs = {"(": ")", "[": "]", "{": "}"}
    while cursor < limit:
        character = text[cursor]
        if quote:
            if character == "\\" and cursor + 1 < limit:
                cursor += 2
                continue
            if character == quote:
                quote = ""
        elif character in "\"'":
            quote = character
        elif character in pairs:
            stack.append(pairs[character])
        elif stack and character == stack[-1]:
            stack.pop()
        elif not stack and character in "\r\n,;)}]":
            break
        cursor += 1
    if cursor >= limit and cursor < len(text):
        return len(text), True
    return cursor, False


def _quoted_key_prefix_is_valid(text: str, key_start: int) -> bool:
    """Validate a JSON/TOML quoted-key prefix using bounded lookbehind."""

    lookbehind_start = max(0, key_start - MAX_LABEL_GAP_CHARS)
    line_break = text.rfind("\n", lookbehind_start, key_start)
    prefix_start = line_break + 1 if line_break >= 0 else lookbehind_start
    prefix_truncated = line_break < 0 and lookbehind_start > 0
    prefix = text[prefix_start:key_start].rstrip()
    return (
        not prefix
        or prefix.endswith(("{", "[", ","))
        or TOML_DOTTED_KEY_PREFIX_RE.fullmatch(prefix) is not None
        or (prefix_truncated and prefix.endswith("."))
    )


def _labelled_secret_value(
    text: str, start: int, extend_tail: bool = True
) -> Tuple[int, str, bool, bool]:
    """Return the end and decoded preview of one bounded assignment value."""

    if start >= len(text):
        return start, "", False, False
    quote = text[start] if text[start] in "\"'" else ""
    if not quote:
        if text[start] == "$":
            cursor = start + 1
            while (
                cursor < len(text)
                and cursor - start < MAX_LABELLED_VALUE_CHARS
                and not text[cursor].isspace()
                and text[cursor] not in ",;)]"
                and unicodedata.category(text[cursor]) not in {"Cc", "Cf", "Cs"}
            ):
                cursor += 1
            if not extend_tail:
                return cursor, text[start:cursor], False, False
            value_end, incomplete = _labelled_scalar_tail(text, start, cursor)
            return value_end, text[start:value_end], False, incomplete
        expression = re.match(r"[A-Za-z_][A-Za-z0-9_.]*(?:\(|\[)", text[start:])
        if expression is not None:
            cursor = start + expression.end() - 1
            pairs = {"(": ")", "[": "]"}
            stack = [pairs[text[cursor]]]
            active_quote = ""
            cursor += 1
            while cursor < len(text) and cursor - start < MAX_LABELLED_VALUE_CHARS:
                character = text[cursor]
                if active_quote:
                    if character == "\\" and cursor + 1 < len(text):
                        cursor += 2
                        continue
                    if character == active_quote:
                        active_quote = ""
                elif character in "\"'":
                    active_quote = character
                elif character in pairs:
                    stack.append(pairs[character])
                elif stack and character == stack[-1]:
                    stack.pop()
                    if not stack:
                        token_end = cursor + 1
                        if not extend_tail:
                            return token_end, text[start:token_end], False, False
                        value_end, incomplete = _labelled_scalar_tail(
                            text, start, token_end
                        )
                        return value_end, text[start:value_end], False, incomplete
                elif character in "\r\n":
                    return len(text), text[start:cursor], False, True
                cursor += 1
            return len(text), text[start:cursor], False, True
        cursor = start
        while (
            cursor < len(text)
            and cursor - start < MAX_LABELLED_VALUE_CHARS
            and not text[cursor].isspace()
            and text[cursor] not in ",;)}]"
            and unicodedata.category(text[cursor]) not in {"Cc", "Cf", "Cs"}
        ):
            cursor += 1
        if (
            cursor - start == MAX_LABELLED_VALUE_CHARS
            and cursor < len(text)
            and not text[cursor].isspace()
            and text[cursor] not in ",;)}]"
            and unicodedata.category(text[cursor]) not in {"Cc", "Cf", "Cs"}
        ):
            return len(text), text[start:cursor], False, True
        if not extend_tail:
            return cursor, text[start:cursor], False, False
        value_end, incomplete = _labelled_scalar_tail(text, start, cursor)
        return value_end, text[start:value_end], False, incomplete

    cursor = start + 1
    decoded: List[str] = []
    while cursor < len(text) and cursor - start < MAX_LABELLED_VALUE_CHARS:
        character = text[cursor]
        if character in "\r\n":
            return len(text), "".join(decoded), True, True
        if character == "\\" and cursor + 1 < len(text) and text[cursor + 1] not in "\r\n":
            decoded.append(text[cursor + 1])
            cursor += 2
            continue
        if character == quote:
            token_end = cursor + 1
            if not extend_tail:
                return token_end, "".join(decoded), True, False
            value_end, incomplete = _labelled_scalar_tail(text, start, token_end)
            if value_end > token_end:
                return value_end, text[start:value_end], False, incomplete
            return token_end, "".join(decoded), True, incomplete
        decoded.append(character)
        cursor += 1
    # Once a bounded quoted value exceeds the lookahead budget, withhold the
    # remainder of the capture rather than risking a partial-secret leak.
    return len(text), "".join(decoded), True, True


def _scalar_value_is_material(value: str, quoted: bool = False) -> bool:
    normalized = " ".join(value.strip().strip("\"'").split())
    compact = "".join(character for character in normalized if not character.isspace())
    if not compact or BENIGN_SECRET_GUIDANCE_RE.fullmatch(normalized) is not None:
        return False
    if SAFE_TEMPLATE_SECRET_REFERENCE_RE.fullmatch(normalized) is not None:
        return False
    if re.fullmatch(
        r"(?:\$[A-Z_][A-Z0-9_]*|\$\{[A-Z_][A-Z0-9_]*\}|%[A-Z_][A-Z0-9_]*%)",
        normalized,
    ):
        return False
    if not quoted and re.match(r"[A-Za-z_][A-Za-z0-9_.]*(?:\(|\[)", normalized):
        if SAFE_SECRET_REFERENCE_RE.fullmatch(normalized):
            return False
        literals = re.findall(r"[\"']([^\"'\\]*(?:\\.[^\"'\\]*)*)[\"']", normalized)
        return any(
            bool("".join(character for character in literal if not character.isspace()))
            and BENIGN_SECRET_GUIDANCE_RE.fullmatch(" ".join(literal.split())) is None
            for literal in literals
        )
    if not quoted and SAFE_SECRET_REFERENCE_RE.fullmatch(normalized):
        return False
    if not quoted and re.fullmatch(r"[0-9]{4,}", compact):
        return True
    return len(compact) >= (1 if quoted else 6)


def _yaml_block_scalar(text: str, start: int, label_start: int) -> Tuple[int, str, bool]:
    """Read one bounded YAML literal/folded scalar and preserve source offsets."""

    if start >= len(text) or text[start] not in "|>":
        return start, "", False
    line_end = text.find("\n", start)
    if line_end < 0:
        return start + 1, "", False
    header = text[start + 1:line_end].split("#", 1)[0].strip()
    if not re.fullmatch(r"(?:[+-]?[1-9]?|[1-9]?[+-]?)", header):
        return start + 1, "", False
    key_line_start = text.rfind("\n", 0, label_start) + 1
    base_indent = len(text[key_line_start:label_start]) - len(
        text[key_line_start:label_start].lstrip(" \t")
    )
    cursor = line_end + 1
    block_end = line_end
    values: List[str] = []
    while cursor <= len(text):
        if cursor - start > MAX_LABELLED_VALUE_CHARS:
            return len(text), "\n".join(values), True
        next_end = text.find("\n", cursor)
        if next_end < 0:
            next_end = len(text)
        raw_line = text[cursor:next_end]
        if raw_line.strip():
            indentation = len(raw_line) - len(raw_line.lstrip(" \t"))
            if indentation <= base_indent:
                break
            values.append(raw_line[indentation:])
        else:
            values.append("")
        block_end = next_end
        if next_end == len(text):
            break
        cursor = next_end + 1
    return block_end, "\n".join(values), False


def _xml_secret_scalar_spans(text: str) -> List[Tuple[int, int]]:
    """Match secret-labelled XML elements in one bounded streaming pass."""

    openings: Dict[str, Deque[Tuple[int, int]]] = {}
    spans: List[Tuple[int, int]] = []
    cursor = 0
    while cursor < len(text):
        start = text.find("<", cursor)
        if start < 0:
            break
        if text.startswith("<!--", start):
            comment_end = text.find("-->", start + 4)
            if comment_end < 0:
                cursor = start + 4
                continue
            cursor = comment_end + 3
            continue

        name_cursor = start + 1
        closing = name_cursor < len(text) and text[name_cursor] == "/"
        if closing:
            name_cursor += 1
        while name_cursor < len(text) and text[name_cursor].isspace():
            name_cursor += 1
        if name_cursor >= len(text) or not text[name_cursor].isalpha():
            quote = ""
            cursor = name_cursor
            while cursor < len(text):
                character = text[cursor]
                if character == "<":
                    break
                if quote:
                    if character == quote:
                        quote = ""
                elif character in "\"'":
                    quote = character
                elif character == ">":
                    cursor += 1
                    break
                cursor += 1
            continue

        name_end = name_cursor + 1
        while name_end < len(text) and (
            text[name_end].isalnum() or text[name_end] in "_:-"
        ):
            name_end += 1
        tag_name = text[name_cursor:name_end].casefold()
        local_name = tag_name.rsplit(":", 1)[-1]
        secret_tag = LABELLED_SECRET_FULL_RE.fullmatch(local_name) is not None

        quote = ""
        end_cursor = name_end
        while end_cursor < len(text):
            character = text[end_cursor]
            if quote:
                if character == quote:
                    quote = ""
            elif character in "\"'":
                quote = character
            elif character == ">":
                break
            end_cursor += 1
        if end_cursor >= len(text):
            if secret_tag and not closing:
                spans.append((start, len(text)))
            break
        end = end_cursor + 1
        self_closing = text[start:end_cursor].rstrip().endswith("/")
        cursor = end
        if not secret_tag:
            continue

        tag_openings = openings.setdefault(tag_name, deque())
        while tag_openings and start - tag_openings[0][0] > MAX_LABELLED_VALUE_CHARS:
            opening_start, _opening_end = tag_openings.popleft()
            return [(opening_start, len(text))]
        if closing:
            if not tag_openings:
                continue
            opening_start, opening_end = tag_openings.pop()
            value = text[opening_end:start]
            if _scalar_value_is_material(value):
                spans.append((opening_start, end))
        elif not self_closing:
            tag_openings.append((start, end))
    for tag_openings in openings.values():
        for opening_start, _opening_end in tag_openings:
            spans.append((opening_start, len(text)))
    return _merge_spans(spans)


def _escaped_secret_key_scalar_spans(text: str) -> List[Tuple[int, int]]:
    """Decode bounded JSON/TOML escapes in quoted mapping keys."""

    spans: List[Tuple[int, int]] = []
    cursor = 0
    simple_escapes = {
        '"': '"', "'": "'", "\\": "\\", "/": "/", "b": "\b", "f": "\f",
        "n": "\n", "r": "\r", "t": "\t",
    }
    while cursor < len(text):
        key_start = text.find('"', cursor)
        if key_start < 0:
            break
        quote = '"'
        key_cursor = key_start + 1
        decoded: List[str] = []
        escaped = False
        closed = False
        while (
            key_cursor < len(text)
            and key_cursor - key_start <= MAX_LABEL_GAP_CHARS
            and text[key_cursor] not in "\r\n"
        ):
            character = text[key_cursor]
            if character == quote:
                closed = True
                break
            if character != "\\":
                decoded.append(character)
                key_cursor += 1
                continue
            escaped = True
            if key_cursor + 1 >= len(text):
                break
            escape = text[key_cursor + 1]
            if escape in {"u", "U"}:
                digits = 4 if escape == "u" else 8
                escape_end = key_cursor + 2 + digits
                hexadecimal = text[key_cursor + 2:escape_end]
                if (
                    len(hexadecimal) == digits
                    and re.fullmatch(r"[0-9A-Fa-f]+", hexadecimal)
                ):
                    codepoint = int(hexadecimal, 16)
                    if codepoint <= 0x10FFFF and not 0xD800 <= codepoint <= 0xDFFF:
                        decoded.append(chr(codepoint))
                        key_cursor = escape_end
                        continue
            decoded.append(simple_escapes.get(escape, escape))
            key_cursor += 2
        if not closed:
            cursor = key_start + 1
            continue
        key_end = key_cursor + 1
        # An unrelated quoted fragment can contain a JSON/TOML snippet. Move
        # one character on validation failure so its nested double-quoted key
        # remains visible; per-candidate work stays capped by the key budget.
        cursor = key_start + 1
        decoded_key = "".join(decoded).strip().strip("\"'")
        normalized_key = decoded_key.lstrip("-").strip()
        if (
            not escaped
            or LABELLED_SECRET_FULL_RE.fullmatch(normalized_key) is None
            or not _quoted_key_prefix_is_valid(text, key_start)
        ):
            continue
        cursor = key_end
        delimiter = _bounded_assignment_cursor(text, key_end)
        if delimiter < 0:
            spans.append((key_start, len(text)))
            break
        cli_value = (
            delimiter < len(text)
            and text[delimiter] == ","
            and decoded_key.startswith("-")
        )
        if delimiter >= len(text) or (
            text[delimiter] not in ":=" and not cli_value
        ):
            continue
        value_start = _bounded_assignment_cursor(text, delimiter + 1)
        if value_start < 0:
            spans.append((key_start, len(text)))
            break
        if value_start >= len(text):
            continue
        if text[value_start] in "|>":
            value_end, value, incomplete = _yaml_block_scalar(
                text, value_start, key_start
            )
            quoted = False
        else:
            value_end, value, quoted, incomplete = _labelled_secret_value(
                text, value_start, extend_tail=not cli_value
            )
        if incomplete or _scalar_value_is_material(value, quoted):
            spans.append((key_start, value_end))
        cursor = max(cursor, value_end)
    return _merge_spans(spans)


def _secret_scalar_spans_in_view(text: str) -> List[Tuple[int, int]]:
    """Single-pass bounded scanner for assignments, CLI, YAML and XML scalars."""

    spans: List[Tuple[int, int]] = _xml_secret_scalar_spans(text)
    spans.extend(_escaped_secret_key_scalar_spans(text))
    search_cursor = 0
    while search_cursor < len(text):
        label = LABELLED_SECRET_RE.search(text, search_cursor)
        if label is None:
            break
        next_cursor = label.end()

        key_start = label.start()
        key_end = label.end()
        quoted_cli_start = -1
        quoted_cli_end = -1
        if (
            label.start() >= 3
            and label.end() < len(text)
            and text[label.start() - 3] in "\"'"
            and text[label.start() - 2:label.start()] == "--"
            and text[label.end()] == text[label.start() - 3]
            and (
                label.start() == 3
                or text[label.start() - 4].isspace()
                or text[label.start() - 4] in "|;&([,{"
            )
        ):
            quoted_cli_start = label.start() - 3
            quoted_cli_end = label.end() + 1
        if (
            key_start > 0
            and key_end < len(text)
            and text[key_start - 1] in "\"'"
            and text[key_end] == text[key_start - 1]
        ):
            quoted_key_start = key_start - 1
            if _quoted_key_prefix_is_valid(text, quoted_key_start):
                key_start = quoted_key_start
                key_end += 1

        delimiter = _bounded_assignment_cursor(text, key_end)
        if delimiter < 0:
            spans.append((key_start, len(text)))
            break
        value_start = -1
        value_gap_exhausted = False
        cli_value = False
        scalar_start = key_start
        dash_start = label.start()
        while dash_start > 0 and text[dash_start - 1] == "-" and label.start() - dash_start < 2:
            dash_start -= 1
        dash_boundary = dash_start == 0 or not (
            text[dash_start - 1].isalnum() or text[dash_start - 1] == "_"
        )
        if quoted_cli_start >= 0:
            scalar_start = quoted_cli_start
            cli_value = True
            value_start = _bounded_assignment_cursor(text, quoted_cli_end)
            value_gap_exhausted = value_start < 0
            if (
                value_start >= 0
                and value_start < len(text)
                and text[value_start] == ","
            ):
                value_start = _bounded_assignment_cursor(text, value_start + 1)
                value_gap_exhausted = value_start < 0
        elif delimiter >= 0 and delimiter < len(text) and text[delimiter] in ":=":
            value_start = _bounded_assignment_cursor(text, delimiter + 1)
            value_gap_exhausted = value_start < 0
            cli_value = dash_start < label.start() and dash_boundary
        else:
            if (
                dash_start < label.start()
                and dash_boundary
                and key_end < len(text)
                and text[key_end].isspace()
            ):
                scalar_start = dash_start
                cli_value = True
                value_start = _bounded_assignment_cursor(text, key_end)
                value_gap_exhausted = value_start < 0

        if value_start < 0:
            if value_gap_exhausted:
                spans.append((scalar_start, len(text)))
                break
            search_cursor = next_cursor
            continue
        if value_start >= len(text):
            search_cursor = next_cursor
            continue
        if text[value_start] in "|>":
            value_end, value, incomplete = _yaml_block_scalar(
                text, value_start, label.start()
            )
            quoted = False
        else:
            value_end, value, quoted, incomplete = _labelled_secret_value(
                text, value_start, extend_tail=not cli_value
            )
        next_cursor = max(next_cursor, value_end)
        if incomplete or _scalar_value_is_material(value, quoted):
            spans.append((scalar_start, value_end))
        search_cursor = next_cursor
    return _merge_spans(spans)


def secret_scalar_spans(text: str) -> List[Tuple[int, int]]:
    """Locate secret-labelled scalar values, including control-interleaved forms."""

    spans = _secret_scalar_spans_in_view(text)
    visible, offsets = _control_stripped_view(text, preserve_layout=True)
    if len(visible) != len(text):
        spans.extend(_map_view_spans(_secret_scalar_spans_in_view(visible), offsets))
    return _merge_spans(spans)


def contains_secret_scalar(text: str) -> bool:
    return bool(secret_scalar_spans(text))


def redact_secret_scalars(text: str) -> str:
    return _redact_spans(text, secret_scalar_spans(text))


def is_secret_label(value: object) -> bool:
    if not isinstance(value, str):
        return False
    candidate = value.strip().strip("\"'").lstrip("-").strip()
    return LABELLED_SECRET_FULL_RE.fullmatch(candidate) is not None


def structured_value_is_populated(value: object) -> bool:
    """Return whether a structured scalar/container carries an explicit value."""

    return not (
        value is None
        or value is False
        or (isinstance(value, (str, list, tuple, dict)) and not value)
    )


def _structured_secret_value_is_populated(value: object) -> bool:
    if not structured_value_is_populated(value):
        return False
    if isinstance(value, str):
        normalized = " ".join(value.strip().strip("\"'").split())
        if (
            BENIGN_SECRET_GUIDANCE_RE.fullmatch(normalized) is not None
            or SAFE_TEMPLATE_SECRET_REFERENCE_RE.fullmatch(normalized) is not None
        ):
            return False
    return True


def mapping_has_populated_secret_keys(value: object) -> bool:
    return isinstance(value, dict) and any(
        is_secret_label(key) and _structured_secret_value_is_populated(child)
        for key, child in value.items()
    )


def sequence_has_adjacent_secret_value(values: Sequence[object]) -> bool:
    for index, value in enumerate(values):
        if not isinstance(value, str):
            continue
        candidate = value.strip()
        if "=" in candidate:
            key, nested = candidate.split("=", 1)
            if is_secret_label(key) and _structured_secret_value_is_populated(nested):
                return True
        if (
            is_secret_label(candidate)
            and index + 1 < len(values)
            and _structured_secret_value_is_populated(values[index + 1])
        ):
            return True
    return False


# Compatibility names retained for existing local callers.
def labelled_secret_assignment_spans(text: str) -> List[Tuple[int, int]]:
    return secret_scalar_spans(text)


def contains_labelled_secret_assignment(text: str) -> bool:
    return contains_secret_scalar(text)


def redact_labelled_secret_assignments(text: str) -> str:
    return redact_secret_scalars(text)


def is_recovery_label(value: object) -> bool:
    return isinstance(value, str) and RECOVERY_LABEL_RE.fullmatch(
        value.strip().strip("\"'")
    ) is not None


def sequence_has_recovery_material(values: Sequence[object]) -> bool:
    """Associate a recovery/backup argv flag with its following populated value."""

    for index, value in enumerate(values[:-1]):
        if is_recovery_label(value) and structured_value_is_populated(values[index + 1]):
            return True
    return False


def string_has_recovery_path_material(value: str) -> bool:
    """Detect a recovery label followed by a value in a path-like string."""

    components = re.split(r"[\\/]+", value)
    return sequence_has_recovery_material(components) or any(
        _inline_recovery_filename_has_material(component) for component in components
    )


def string_has_private_recovery_artifact_path(value: str) -> bool:
    """Detect transaction-owned recovery/quarantine basenames in a path."""

    return any(
        component.casefold().startswith(PRIVATE_RECOVERY_BASENAME_PREFIXES)
        for component in re.split(r"[\\/]+", value)
    )


def _looks_like_recovery_code(value: str) -> bool:
    candidate = value.strip().rstrip(",;").strip().strip("\"'")
    if not RECOVERY_CODE_RE.fullmatch(candidate):
        return False
    # Avoid treating ordinary prose below a heading as recovery material. Real
    # recovery codes are normally numeric, punctuated, or rendered in capitals.
    return (
        any(character.isdigit() for character in candidate)
        or "-" in candidate
        or "_" in candidate
        or candidate.isupper()
    )


def _inline_recovery_filename_has_material(value: str) -> bool:
    """Detect a labelled code embedded in one ordinary filename component."""

    for label in INLINE_RECOVERY_FILENAME_LABEL_RE.finditer(value):
        payload = value[label.end():].lstrip("-_. ")
        if not payload:
            continue
        # Remove only reviewed conventional filename extensions. Treating any
        # final dot segment as an extension would discard code material such
        # as ``ABC.DEF`` and let a labelled filename evade the path gates.
        candidate = payload
        for _suffix in range(3):
            stem, dot, extension = candidate.rpartition(".")
            if not dot or extension.casefold() not in RECOVERY_FILENAME_EXTENSIONS:
                break
            candidate = stem
        normalized = candidate.strip("-_. ")
        if (
            BENIGN_RECOVERY_FILENAME_PAYLOAD_RE.fullmatch(normalized) is None
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]*", normalized)
            and len(re.sub(r"[^A-Za-z0-9]", "", normalized)) >= 6
        ):
            return True
    return False


def _recovery_block_line(value: str) -> Tuple[bool, bool]:
    """Return (belongs_to_block, contains_value) for one following line."""

    candidate = re.sub(r"^(?:[ \t]*>[ \t]*)+", "", value).strip()
    if not candidate:
        return False, False
    if re.fullmatch(r"(?:```|~~~)[A-Za-z0-9_-]*", candidate):
        return True, False
    if re.fullmatch(r"[\[\]{},;]+", candidate):
        return True, False
    candidate = re.sub(r"^(?:[-*+]|\d{1,3}[.)])\s+", "", candidate)
    candidate = candidate.strip().rstrip(",;").strip()
    if re.fullmatch(r"[\[\]{}]+", candidate):
        return True, False
    if "," in candidate or ";" in candidate:
        has_value = _inline_recovery_payload_has_code(candidate)
        return has_value, has_value
    # JSON/YAML maps commonly use an account or device name as the key.
    if ":" in candidate:
        _key, nested = candidate.split(":", 1)
        nested = nested.strip().strip("{}[]").strip()
        return (_looks_like_recovery_code(nested), _looks_like_recovery_code(nested))
    is_value = _looks_like_recovery_code(candidate.strip("{}[]").strip())
    return is_value, is_value


def _inline_recovery_payload_has_code(value: str) -> bool:
    candidate = value.strip().strip("[]{}")
    if not candidate:
        return False
    for item in re.split(r"[,;]", candidate):
        nested = item.split(":", 1)[-1] if ":" in item else item
        if _looks_like_recovery_code(nested.strip()):
            return True
    return False


def recovery_material_spans(text: str) -> List[Tuple[int, int]]:
    """Locate populated labelled recovery-code blocks for safe redaction.

    The scanner covers scalar, inline list, JSON/YAML map, bulleted/numbered,
    and provider-style unbulleted line layouts. It deliberately stops at the
    first blank or prose line so a diagnostic keeps unrelated context.
    """

    scan_text = _mask_common_html_layout(text, line_breaks=True)
    spans: List[Tuple[int, int]] = []
    for label in RECOVERY_LABEL_TEXT_RE.finditer(scan_text):
        inline_limit = min(len(scan_text), label.end() + MAX_LABELLED_VALUE_CHARS)
        line_end = scan_text.find("\n", label.end(), inline_limit + 1)
        if line_end < 0:
            if inline_limit < len(scan_text):
                spans.append((label.start(), len(scan_text)))
                break
            line_end = len(scan_text)
        tail = scan_text[label.end():line_end]
        delimiter_tail = tail.lstrip(" \t\"'")
        payload = ""
        block_follows = False
        if delimiter_tail.startswith((":", "=")):
            payload = delimiter_tail[1:].strip()
            block_follows = not payload or payload in {"[", "{"}
        elif not delimiter_tail:
            block_follows = line_end < len(scan_text)
        else:
            continue

        if payload and not block_follows:
            if _inline_recovery_payload_has_code(payload):
                spans.append((label.start(), line_end))
            continue

        cursor = line_end + (1 if line_end < len(scan_text) else 0)
        block_end = line_end
        saw_value = False
        active_fence = ""
        lines_scanned = 0
        while cursor <= len(scan_text) and lines_scanned < 64 and cursor - label.end() <= 16_384:
            next_end = scan_text.find("\n", cursor)
            if next_end < 0:
                next_end = len(scan_text)
            raw_line = scan_text[cursor:next_end]
            normalized = re.sub(r"^(?:[ \t]*>[ \t]*)+", "", raw_line).strip()
            if not normalized:
                probe = next_end + (1 if next_end < len(scan_text) else 0)
                probe_lines = 0
                continuation = False
                while probe <= len(scan_text) and probe_lines < 4:
                    probe_end = scan_text.find("\n", probe)
                    if probe_end < 0:
                        probe_end = len(scan_text)
                    probe_value = re.sub(
                        r"^(?:[ \t]*>[ \t]*)+", "", scan_text[probe:probe_end]
                    ).strip()
                    if probe_value:
                        continuation = _recovery_block_line(probe_value)[0]
                        break
                    if probe_end == len(scan_text):
                        break
                    probe = probe_end + 1
                    probe_lines += 1
                if not continuation:
                    break
                belongs, contains_value = True, False
            else:
                fence = re.match(r"(```|~~~)", normalized)
                if fence is not None:
                    marker = fence.group(1)
                    if active_fence == marker:
                        block_end = next_end
                        if saw_value:
                            break
                        active_fence = ""
                    elif not active_fence:
                        active_fence = marker
                belongs, contains_value = _recovery_block_line(normalized)
            if not belongs:
                break
            saw_value = saw_value or contains_value
            block_end = next_end
            lines_scanned += 1
            if next_end == len(scan_text):
                break
            cursor = next_end + 1
        if saw_value:
            spans.append((label.start(), block_end))

    if not spans:
        return []
    spans.sort()
    merged = [spans[0]]
    for start, end in spans[1:]:
        old_start, old_end = merged[-1]
        if start <= old_end:
            merged[-1] = (old_start, max(old_end, end))
        else:
            merged.append((start, end))
    return merged


def contains_recovery_material(text: str) -> bool:
    return bool(recovery_material_spans(text))


def redact_recovery_material(text: str) -> str:
    spans = recovery_material_spans(text)
    if not spans:
        return text
    chunks: List[str] = []
    cursor = 0
    for start, end in spans:
        chunks.extend((text[cursor:start], "[REDACTED]"))
        cursor = end
    chunks.append(text[cursor:])
    return "".join(chunks)


def redact_bip39_mnemonics(text: str) -> str:
    spans = bip39_mnemonic_spans(text)
    if not spans:
        return text
    chunks: List[str] = []
    cursor = 0
    for start, end in spans:
        chunks.extend((text[cursor:start], "[REDACTED]"))
        cursor = end
    chunks.append(text[cursor:])
    return "".join(chunks)
