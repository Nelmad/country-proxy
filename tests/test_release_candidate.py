import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import release_candidate as candidate
import package

COMMIT = 'a' * 40


class ReleaseCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'source'
        self.root.mkdir()
        for name in package.ROOT_FILES:
            (self.root / name).write_text('fixture\n')
        for name in package.SOURCE_DIRS:
            (self.root / name).mkdir()
        self.manifest = self.root / 'extension/manifest.json'
        self.manifest.write_text('{"version":"0.2.1"}\n')
        (self.root / 'native/host.py').write_text('fixture host\n')
        (self.root / 'CHANGELOG.md').write_text('# Changes\n\n## [Unreleased]\n\nNext work.\n\n## [0.2.1] - 2026-10-30\n\nFixed recovery.\n\n### Limitations\n\nNo public NO pair confirmed.\n')
        self.snapshot = self.base / 'snapshot.json'
        self.output = self.base / 'output'

    def make_snapshot(self):
        return candidate.snapshot(self.root, 'v0.2.1', COMMIT, self.snapshot)

    def prepare(self):
        return candidate.prepare(self.root, self.snapshot, 'v0.2.1', COMMIT, self.output)

    def test_candidate_binds_inventory_commit_notes_and_asset_hashes(self):
        record = self.make_snapshot()
        result = self.prepare()
        metadata = json.loads((self.output / 'release-metadata.json').read_text())
        self.assertEqual(metadata['commit'], COMMIT)
        self.assertEqual(metadata['source_files'], record['source_files'])
        self.assertFalse(metadata['published'])
        self.assertEqual(set(p.name for p in self.output.iterdir()), {
            'country-proxy-0.2.1.zip', 'country-proxy-0.2.1.zip.sha256',
            'release-notes.md', 'release-metadata.json'})
        for name, digest in metadata['assets'].items():
            self.assertEqual(hashlib.sha256((self.output / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(result['metadata_sha256'], hashlib.sha256((self.output / 'release-metadata.json').read_bytes()).hexdigest())
        notes = (self.output / 'release-notes.md').read_text()
        self.assertIn('No public NO pair confirmed.', notes)
        self.assertIn(COMMIT, notes)
        self.assertNotIn('Next work.', notes)
        self.assertIn('/blob/v0.2.1/docs/installation.md', notes)

    def test_legal_files_are_bound_to_snapshot_and_exact_candidate_archive(self):
        expected = {'LICENSE': b'MIT License\r\nCopyright (c) 2026 Fixture\r\n',
                    'NOTICE': 'Notices\nТочный текст.\n'.encode()}
        for name, body in expected.items():
            (self.root / name).write_bytes(body)
        record = self.make_snapshot()
        self.prepare()
        with ZipFile(self.output / 'country-proxy-0.2.1.zip') as archive:
            manifest = json.loads(archive.read('country-proxy/BUILD-MANIFEST.json'))
            for name, body in expected.items():
                with self.subTest(name=name):
                    expected_hash = hashlib.sha256(body).hexdigest()
                    self.assertEqual(record['source_files'][name], expected_hash)
                    self.assertEqual(manifest['files'][name], expected_hash)
                    self.assertEqual(archive.read('country-proxy/' + name), body)

    def test_local_prepare_notes_link_both_languages_without_claiming_workflow_checks(self):
        for name in ('getting-started.md', 'installation.md', 'verification.md'):
            (self.root / 'docs' / name).write_text('Release documentation fixture.\n')
        for version in ('0.2.1', '1.0.0'):
            with self.subTest(version=version):
                tag = 'v' + version
                self.manifest.write_text(json.dumps({'version': version}) + '\n')
                (self.root / 'CHANGELOG.md').write_text(
                    f'## [{version}] - 2026-11-17\n\nLocal package notes.\n')
                snapshot = self.base / ('snapshot-' + version + '.json')
                output = self.base / ('output-' + version)
                candidate.snapshot(self.root, tag, COMMIT, snapshot)
                candidate.prepare(self.root, snapshot, tag, COMMIT, output)
                notes = (output / 'release-notes.md').read_text()
                base = f'https://github.com/Nelmad/country-proxy/blob/{tag}/docs/'
                self.assertIn('[English setup and recovery](' + base + 'getting-started.md)', notes)
                self.assertIn('[Установка, обновление и откат (русский)](' + base + 'installation.md)', notes)
                self.assertIn('[Verification and limits](' + base + 'verification.md)', notes)
                self.assertIn('Browser acceptance is recorded separately; CI does not perform it.', notes)
                self.assertIn('A GitHub Release does not update an installed extension automatically.', notes)
                self.assertNotIn('workflow', notes.casefold())
                self.assertNotIn('offline', notes.casefold())
                self.assertNotIn('черновик', notes.casefold())

    def test_legal_file_change_after_snapshot_is_rejected(self):
        for name in ('LICENSE', 'NOTICE'):
            with self.subTest(name=name):
                self.output = self.base / ('output-' + name)
                path = self.root / name
                path.write_bytes(b'original notice\n')
                self.make_snapshot()
                path.write_bytes(b'changed notice\n')
                with self.assertRaisesRegex(ValueError, 'Source changed'):
                    self.prepare()
                self.assertFalse(self.output.exists())

    def test_generated_notes_link_to_tagged_files_and_preserve_absolute_urls_and_code(self):
        changelog = self.root / 'CHANGELOG.md'
        changelog.write_text(changelog.read_text() + (
            '\n[verification](docs/verification.md#results) '
            '[section](#limitations) '
            '[spaced](<docs/My File.md>) '
            '[external](https://example.com/guide#one) '
            '[email](mailto:help@example.com)\n'
            '`[example](docs/example.md)`\n'
            '```markdown\n[example](docs/example.md)\n```\n'))
        self.make_snapshot()
        self.prepare()
        notes = (self.output / 'release-notes.md').read_text()
        base = 'https://github.com/Nelmad/country-proxy/blob/v0.2.1/'
        self.assertIn('[verification](' + base + 'docs/verification.md#results)', notes)
        self.assertIn('[section](' + base + 'CHANGELOG.md#limitations)', notes)
        self.assertIn('[spaced](' + base + 'docs/My%20File.md)', notes)
        self.assertIn('[external](https://example.com/guide#one)', notes)
        self.assertIn('[email](mailto:help@example.com)', notes)
        self.assertIn('`[example](docs/example.md)`', notes)
        self.assertIn('```markdown\n[example](docs/example.md)\n```', notes)

    def test_ambiguous_or_escaping_relative_note_links_are_rejected(self):
        for text in ('[link](../outside.md)', '[link](/absolute.md)',
                     '[link](docs/example(v2).md)', '[link](docs/example.md "title")',
                     '[link][reference]\n\n[reference]: docs/example.md'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                candidate.release_links(text, 'v0.2.1')

    def test_tag_and_sha_are_strict(self):
        for tag in ('v0.2.1\n', 'v0.2.1;echo', 'refs/tags/v0.2.1', 'v00.2.1', 'v0.2.1-rc.0', 'v0.0.0', 'v0.2.65536'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                candidate.identity(tag, COMMIT)
        for commit in ('main', 'a' * 39, 'A' * 40, COMMIT + '\n'):
            with self.subTest(commit=commit), self.assertRaises(ValueError):
                candidate.identity('v0.2.1', commit)
        self.assertEqual(candidate.identity('v0.2.1-rc.2', COMMIT), ('0.2.1', True))

    def test_manifest_tag_and_preview_display_must_agree(self):
        self.manifest.write_text('{"version":"0.2.0"}')
        with self.assertRaisesRegex(ValueError, 'numeric manifest'):
            self.make_snapshot()
        for display in ('v0.2.1-rc.1', '0.2.1-rc.1'):
            self.manifest.write_text(json.dumps({'version': '0.2.1', 'version_name': display}))
            (self.root / 'CHANGELOG.md').write_text('## [0.2.1-rc.1] - 2026-10-30\n\nPreview with known limitations.\n')
            self.assertTrue(candidate.inspect_source(self.root, 'v0.2.1-rc.1', COMMIT)['prerelease'])
            with self.assertRaisesRegex(ValueError, 'Stable release'):
                self.make_snapshot()
        self.manifest.write_text('{"version":"0.2.1"}')
        with self.assertRaisesRegex(ValueError, 'RC manifest'):
            candidate.inspect_source(self.root, 'v0.2.1-rc.1', COMMIT)

    def test_finalized_changelog_required(self):
        for body in ('## [Unreleased]\n\nCandidate0.2.1', '## [0.2.1]\n\nChanges',
                     '## [0.2.1] - 2026-10-30\n\n', '## [0.2.1] - 2026-10-30\n\nTODO details',
                     '## [0.2.1] - 2026-10-30 (planned)\n\nChanges',
                     '## [0.2.1] - 2026-02-30\n\nChanges',
                     '## [0.2.1] - 2026-10-30\nChanges\n## [0.2.1] - 2026-10-30\nDuplicate'):
            with self.subTest(body=body), self.assertRaises(ValueError):
                candidate.changelog_section(body, 'v0.2.1')

    def test_modified_added_and_removed_source_rejected_after_snapshot(self):
        for mutation in ('modified', 'added', 'removed'):
            self.make_snapshot()
            host = self.root / 'native/host.py'
            original = host.read_bytes()
            extra = self.root / 'native/extra.py'
            if mutation == 'modified':
                host.write_text('changed')
            elif mutation == 'added':
                extra.write_text('new')
            else:
                host.unlink()
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, 'Source changed'):
                self.prepare()
            host.write_bytes(original)
            extra.unlink(missing_ok=True)
        self.assertFalse(self.output.exists())

    def test_mutation_during_build_rejected(self):
        self.make_snapshot()
        original_build = candidate.build
        def changed(root):
            output = original_build(root)
            (root / 'native/host.py').write_text('changed during build')
            return output
        with patch.object(candidate, 'build', changed), self.assertRaisesRegex(ValueError, 'during packaging'):
            self.prepare()

    def test_zip_wrong_bytes_or_extra_entries_rejected(self):
        record = self.make_snapshot()
        for wrong in ('changed', 'extra'):
            archive_path = package.build(self.root)
            with ZipFile(archive_path) as archive:
                entries = {name: archive.read(name) for name in archive.namelist()}
            if wrong == 'changed':
                entries['country-proxy/native/host.py'] = b'tampered'
            else:
                entries['country-proxy/unreviewed.txt'] = b'extra'
            with ZipFile(archive_path, 'w') as archive:
                for name, data in entries.items():
                    archive.writestr(name, data)
            with self.subTest(wrong=wrong), self.assertRaisesRegex(ValueError, 'ZIP'):
                candidate.verify_archive(archive_path, record)

    def test_parent_symlink_rejected_before_manifest_content_read(self):
        extension = self.root / 'extension'
        extension.rename(self.base / 'outside')
        extension.symlink_to(self.base / 'outside', target_is_directory=True)
        with patch.object(candidate, 'read_regular', side_effect=AssertionError('Must validate paths first')):
            with self.assertRaisesRegex(ValueError, 'Symlink'):
                self.make_snapshot()

    def test_existing_output_is_not_overwritten(self):
        self.make_snapshot()
        self.output.mkdir()
        marker = self.output / 'preserve'
        marker.write_text('existing artifact')
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(marker.read_text(), 'existing artifact')


class ReleaseWorkflowTests(unittest.TestCase):
    setUp = ReleaseCandidateTests.setUp
    make_snapshot = ReleaseCandidateTests.make_snapshot
    prepare = ReleaseCandidateTests.prepare

    # Exercise the exact fixed inline guards without GitHub calls or credentials.
    def inline(self, marker):
        import re
        import textwrap
        workflow = (SCRIPTS.parent / '.github/workflows/release-draft.yml').read_text()
        matches = re.findall(r"          python3 - <<'" + marker + r"'\n(.*?)\n          " + marker, workflow, re.S)
        self.assertTrue(matches)
        self.assertTrue(all(item == matches[0] for item in matches))
        return compile(textwrap.dedent(matches[0]), marker, 'exec')

    def environment(self):
        return {'CI_EVENT': 'workflow_dispatch', 'CI_REF': 'refs/heads/main', 'ACCEPTED': 'true',
                'RELEASE_TAG': 'v0.2.1', 'APPROVED_SHA': COMMIT,
                'GITHUB_REPOSITORY': 'owner/example', 'GH_TOKEN': 'test-only-not-a-secret'}

    def api(self, *, tag_sha=COMMIT, comparison='ahead', existing=False, annotated=False, release_error=404, merge_base=COMMIT, tag_error=None, draft=False, draft_page=1):
        import io
        import urllib.error
        def get(request, timeout):
            self.assertEqual(timeout, 30)
            self.assertEqual(request.get_method(), 'GET')
            suffix = request.full_url.removeprefix('https://api.github.com/repos/owner/example/')
            if suffix == 'git/ref/tags/v0.2.1':
                if tag_error is not None:
                    raise urllib.error.HTTPError(request.full_url, tag_error, 'test', {}, io.BytesIO(b'{}'))
                value = {'object': {'type': 'tag' if annotated else 'commit', 'sha': 'b' * 40 if annotated else tag_sha}}
            elif suffix == 'git/tags/' + 'b' * 40:
                value = {'object': {'type': 'commit', 'sha': tag_sha}}
            elif suffix == 'compare/' + COMMIT + '...main':
                value = {'status': comparison, 'merge_base_commit': {'sha': merge_base}}
            elif suffix == 'releases/tags/v0.2.1':
                if not existing:
                    raise urllib.error.HTTPError(request.full_url, release_error, 'test', {}, io.BytesIO(b'{}'))
                value = {'id': 123}
            elif suffix.startswith('releases?per_page=100&page='):
                page = int(suffix.rsplit('=', 1)[1])
                if draft and page < draft_page:
                    value = [{'tag_name': 'v9.0.' + str(i)} for i in range(100)]
                elif draft and page == draft_page:
                    value = [{'id': 456, 'tag_name': 'v0.2.1', 'draft': True}]
                else:
                    value = []
            else:
                raise AssertionError('Unexpected GitHub API request: ' + suffix)
            return io.BytesIO(json.dumps(value).encode())
        return get

    def test_ref_guard_accepts_existing_lightweight_and_annotated_tags_on_main(self):
        import contextlib
        import io
        import os
        for annotated in (False, True):
            with self.subTest(annotated=annotated), patch.dict(os.environ, self.environment(), clear=True):
                with patch('urllib.request.urlopen', self.api(annotated=annotated)), contextlib.redirect_stdout(io.StringIO()):
                    exec(self.inline('PYREF'), {})

    def test_ref_guard_rejects_wrong_commit_off_main_and_existing_release(self):
        import os
        for options in ({'tag_sha': 'c' * 40}, {'comparison': 'behind'}, {'comparison': 'diverged'}, {'merge_base': 'c' * 40}, {'existing': True}, {'draft': True}):
            with self.subTest(options=options), patch.dict(os.environ, self.environment(), clear=True):
                with patch('urllib.request.urlopen', self.api(**options)), self.assertRaises(SystemExit):
                    exec(self.inline('PYREF'), {})

    def test_existing_draft_on_later_page_rejected_when_tag_lookup_is_404(self):
        import os
        with patch.dict(os.environ, self.environment(), clear=True):
            with patch('urllib.request.urlopen', self.api(draft=True, draft_page=2)):
                with self.assertRaisesRegex(SystemExit, 'draft already exists'):
                    exec(self.inline('PYREF'), {})

    def test_ref_guard_fails_on_api_error_not_only_release_absence(self):
        import os
        import urllib.error
        with patch.dict(os.environ, self.environment(), clear=True):
            with patch('urllib.request.urlopen', self.api(release_error=403)):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    exec(self.inline('PYREF'), {})
                self.assertTrue(caught.exception.fp.closed)

    def test_missing_tag_or_api_error_never_creates_a_tag(self):
        import os
        import urllib.error
        for code in (404, 500):
            with self.subTest(code=code), patch.dict(os.environ, self.environment(), clear=True):
                with patch('urllib.request.urlopen', side_effect=self.api(tag_error=code)) as calls:
                    with self.assertRaises(urllib.error.HTTPError):
                        exec(self.inline('PYREF'), {})
                    self.assertEqual(calls.call_count, 1)

    def test_ref_guard_requires_manual_main_and_explicit_acceptance_before_network(self):
        import os
        for override in ({'CI_EVENT': 'push'}, {'CI_REF': 'refs/heads/feature'}, {'ACCEPTED': 'false'}, {'RELEASE_TAG': 'v0.2.1;echo'}):
            with self.subTest(override=override), patch.dict(os.environ, {**self.environment(), **override}, clear=True):
                with patch('urllib.request.urlopen', side_effect=AssertionError('No request before guards')), self.assertRaises(SystemExit):
                    exec(self.inline('PYREF'), {})

    def test_write_job_checks_actual_artifact_against_readonly_job_hashes(self):
        import contextlib
        import io
        import os
        self.make_snapshot()
        outputs = self.prepare()
        artifact = self.base / 'release-artifact'
        self.output.rename(artifact)
        env = {**self.environment(), **{key.upper(): value for key, value in outputs.items()}}
        previous = Path.cwd()
        try:
            os.chdir(self.base)
            with patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(io.StringIO()):
                exec(self.inline('PYARTIFACT'), {})
                (artifact / 'release-notes.md').write_text('tampered after upload')
                with self.assertRaisesRegex(SystemExit, 'read-only build job output'):
                    exec(self.inline('PYARTIFACT'), {})
        finally:
            os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
