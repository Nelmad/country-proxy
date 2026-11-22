"""Local documentation entry points must reach an existing section."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from doc_links import anchors, link_errors


class DocumentationLinksTests(unittest.TestCase):
    def test_stale_fragment_is_not_accepted_just_because_file_exists(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'verification.md').write_text('# Локальный кандидат 1.0.1 — 20 ноября 2026\n')
            entry = root/'README.md'
            entry.write_text('[acceptance](verification.md#unreleased--исправления-review-20-ноября-2026)\n')
            self.assertEqual(link_errors([entry])[0][3], 'missing heading or explicit anchor')
            entry.write_text('[acceptance](verification.md#локальный-кандидат-101--20-ноября-2026)\n')
            self.assertEqual(link_errors([entry]), [])

    def test_unicode_duplicate_headings_explicit_and_same_document_anchors(self):
        with tempfile.TemporaryDirectory() as folder:
            entry = Path(folder)/'readme.md'
            entry.write_text('# **Выбор** `NO/EE`\n# Выбор NO/EE\n<a id="acceptance"></a>\n'
                             '[one](#выбор-noee) [two](#%D0%B2%D1%8B%D0%B1%D0%BE%D1%80-noee-1)\n'
                             '[explicit](#acceptance) [remote](https://example.test/missing#remote)\n')
            self.assertEqual(link_errors([entry]), [])

    def test_code_examples_do_not_define_headings_or_links(self):
        text = '# Real\n```md\n# Fake\n[bad](missing.md#none)\n```\n~~~\n# Other\n~~~\n'
        self.assertEqual(anchors(text), {'real'})
        with tempfile.TemporaryDirectory() as folder:
            entry = Path(folder)/'readme.md'; entry.write_text(text)
            self.assertEqual(link_errors([entry]), [])

    def test_missing_file_and_angle_path_with_space(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'Setup guide.md').write_text('Setup\n=====\n')
            entry = root/'README.md'
            entry.write_text('[good](<Setup guide.md#setup>) [bad](absent.md)\n')
            errors = link_errors([entry])
            self.assertEqual([(e[2], e[3]) for e in errors], [('absent.md', 'missing file')])


if __name__ == '__main__':
    unittest.main()
