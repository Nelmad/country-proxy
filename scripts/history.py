#!/usr/bin/env python3
"""Clear only Country Proxy's exact local endpoint cache, while no helper owns it."""
import argparse
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'native'))
from history_store import FileHistoryStore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['clear'])
    parser.add_argument('--data-dir', required=True, type=Path)
    args = parser.parse_args()
    store = None
    try:
        store = FileHistoryStore(args.data_dir, create=False)
        count = store.clear()
        print(f'Cleared {count} endpoint-history files; unrelated files and lock retained.')
    except (OSError, ValueError, OverflowError) as error:
        parser.exit(1, str(error)+'\n')
    finally:
        if store is not None:
            store.close()


if __name__ == '__main__':
    main()
