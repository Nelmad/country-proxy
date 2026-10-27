#!/bin/sh
set -eu
cd "$(dirname "$0")"
for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if "$candidate" -c 'import sys; sys.exit(sys.version_info < (3,11))' 2>/dev/null; then
    "$candidate" scripts/install.py
    printf '\nОткройте chrome://extensions → Режим разработчика → Загрузить распакованное → папка extension.\n'
    exit 0
  fi
done
printf 'Нужен Python 3.11+. Установите Python с python.org и повторите.\n'
exit 1
