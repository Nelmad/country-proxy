"""Check the local inline Markdown links used in this repository, including anchors."""
from html import unescape
from pathlib import Path
import re
import unicodedata
from urllib.parse import unquote, urlsplit


def heading_text(value):
    value = re.sub(r'!?\[([^\]]+)\]\([^)]*\)', r'\1', value)
    value = re.sub(r'<[^>]*>', '', value)
    return unescape(value).strip().lower()


def heading_slug(value):
    return ''.join(c for c in heading_text(value)
                   if c in '-_ ' or unicodedata.category(c)[0] not in 'PS').replace(' ', '-')


def visible_lines(text):
    """Ignore fenced code examples, which define neither links nor headings."""
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        mark = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
        if fence:
            if mark and mark[1][0] == fence[0] and len(mark[1]) >= fence[1] and not mark[2].strip():
                fence = None
            continue
        if mark:
            fence = (mark[1][0], len(mark[1]))
            continue
        yield number, line


def anchors(text):
    used, result, previous = set(), set(), ''
    for _, line in visible_lines(text):
        result.update(unescape(v) for v in re.findall(r'<[^>]+\b(?:id|name)=[\"\']([^\"\']+)[\"\']', line))
        atx = re.match(r'^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$', line)
        title = atx[1] if atx else previous if previous and re.fullmatch(r' {0,3}(?:=+|-+)\s*', line) else None
        if title is not None:
            base = heading_slug(title)
            slug, suffix = base, 0
            while slug in used:
                suffix += 1
                slug = f'{base}-{suffix}'
            used.add(slug)
            result.add(slug)
        previous = line.strip() if title is None else ''
    return result


def link_errors(files):
    """Return file, line, target, reason; no remote requests or code execution."""
    errors, cache = [], {}
    for file in files:
        file = Path(file)
        for number, line in visible_lines(file.read_text()):
            for match in re.finditer(r'\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[\"\'][^\n]*?[\"\'])?\)', line):
                target = match[1] if match[1] is not None else match[2]
                parts = urlsplit(target)
                if parts.scheme or parts.netloc:
                    continue
                dest = (file.parent / unquote(parts.path)).resolve() if parts.path else file
                if not dest.exists():
                    errors.append((str(file), number, target, 'missing file'))
                elif parts.fragment and dest.suffix.lower() == '.md':
                    if dest not in cache:
                        cache[dest] = anchors(dest.read_text())
                    if unquote(parts.fragment) not in cache[dest]:
                        errors.append((str(file), number, target, 'missing heading or explicit anchor'))
    return errors
