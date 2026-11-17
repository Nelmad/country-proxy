"""Keep CI's static reviewed approvals aligned with the exact offline contract.

This deliberately accepts only the current plain jobs/job/steps mappings and
two-line named runner step. Changing that workflow form requires review of this
guard as well; this is not a general YAML or shell parser.
"""
import hashlib
from pathlib import Path
import re
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = (
    ('.github/workflows/checks.yml', 'offline', 'Run offline checks'),
    ('.github/workflows/release-draft.yml', 'build', 'Run offline contract'),
)
COMMAND = 'python3 -B scripts/check.py --execute-reviewed '


def meaningful(lines):
    return [line for line in lines if line.strip() and not line.lstrip().startswith('#')]


def mapping_block(lines, key, indent):
    """Select one plain mapping, without matching text in nested scalar bodies."""
    # At the selected mapping boundary, restrict *all* keys so YAML escapes,
    # complex keys or merge keys cannot spell a second copy of the target key.
    # Simple quoted ASCII keys remain valid (the workflows use 'on' at root).
    simple_key = r'[A-Za-z_][A-Za-z0-9_-]*'
    entry = re.compile(' {' + str(indent) + '}(?:' + simple_key
                       + "|'" + simple_key + "'|\"" + simple_key + '\"):\\s*')
    for line in lines:
        if len(line) - len(line.lstrip(' ')) == indent and not entry.match(line):
            raise ValueError('Unsupported mapping key form requires review')
    # Quoted/inline alternatives count as candidates but are not accepted forms.
    header = re.compile(r' {' + str(indent) + r'}(?:' + re.escape(key)
                        + r'|[\'\"]' + re.escape(key) + r'[\'\"])\s*:')
    matches = [i for i, line in enumerate(lines) if header.match(line)]
    if len(matches) != 1 or lines[matches[0]] != ' ' * indent + key + ':':
        raise ValueError('Expected one plain mapping: ' + key)
    start = matches[0] + 1
    end = next((i for i in range(start, len(lines))
                if len(lines[i]) - len(lines[i].lstrip(' ')) <= indent), len(lines))
    return lines[start:end]


def reviewed_digest(text, job, step_name):
    """Read the approval only from the intended executable, unconditional step."""
    if '\t' in text:
        raise ValueError('Tabs require workflow-form review')
    lines = meaningful(text.splitlines())
    jobs = mapping_block(lines, 'jobs', 0)
    job_lines = mapping_block(jobs, job, 2)
    steps = mapping_block(job_lines, 'steps', 4)
    starts = [i for i, line in enumerate(steps) if line.startswith('      - ')]
    blocks = [steps[start:(starts + [len(steps)])[n + 1]]
              for n, start in enumerate(starts)]
    intended = [block for block in blocks
                if block[0] == '      - name: ' + step_name]
    if len(intended) != 1 or len(intended[0]) != 2:
        raise ValueError('Expected one unconditional two-line runner step: ' + step_name)
    command_line = intended[0][1]
    match = re.fullmatch('        run: ' + re.escape(COMMAND) + r'([0-9a-f]{64})', command_line)
    if not match:
        raise ValueError('Expected the canonical literal reviewed runner command')
    # Fail closed for a second approval, including quoted data or shell wrappers.
    # Comments cannot supply approval and are excluded above. The intended step
    # must itself contain the command, so comments/echo cannot mask its absence.
    approvals = [line for line in lines if '--execute-reviewed' in line]
    if approvals != [command_line]:
        raise ValueError('Expected exactly one reviewed invocation in the workflow')
    return match[1]


def validate_workflows(root):
    expected = hashlib.sha256((root / 'project-checks.json').read_bytes()).hexdigest()
    for relative, job, step in WORKFLOWS:
        actual = reviewed_digest((root / relative).read_text(), job, step)
        if actual != expected:
            raise ValueError(relative + ': reviewed digest differs from exact project-checks.json bytes')


class WorkflowContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / '.github/workflows').mkdir(parents=True)
        self.contract = b'{"schema_version":1,"checks":[]}\n'
        (self.root / 'project-checks.json').write_bytes(self.contract)
        self.digest = hashlib.sha256(self.contract).hexdigest()
        for relative, job, step in WORKFLOWS:
            (self.root / relative).write_text(self.workflow(job, step))

    def workflow(self, job, step):
        return ('name: Fixture\njobs:\n  ' + job + ':\n    runs-on: ubuntu-24.04\n'
                '    steps:\n      - name: ' + step + '\n        run: ' + COMMAND + self.digest + '\n')

    def test_repository_workflows_approve_current_exact_contract(self):
        validate_workflows(ROOT)

    def test_both_canonical_workflows_pass(self):
        validate_workflows(self.root)

    def test_one_byte_contract_change_invalidates_approval(self):
        (self.root / 'project-checks.json').write_bytes(self.contract + b' ')
        with self.assertRaisesRegex(ValueError, 'exact project-checks.json bytes'):
            validate_workflows(self.root)

    def test_either_stale_workflow_fails(self):
        for relative, job, step in WORKFLOWS:
            with self.subTest(workflow=relative):
                path = self.root / relative
                original = path.read_text()
                path.write_text(original.replace(self.digest, '0' * 64))
                with self.assertRaisesRegex(ValueError, relative):
                    validate_workflows(self.root)
                path.write_text(original)

    def test_missing_either_workflow_fails(self):
        for relative, job, step in WORKFLOWS:
            with self.subTest(workflow=relative):
                path = self.root / relative
                original = path.read_text()
                path.unlink()
                with self.assertRaises(FileNotFoundError):
                    validate_workflows(self.root)
                path.write_text(original)

    def test_non_executable_or_ambiguous_approvals_fail(self):
        relative, job, step = WORKFLOWS[0]
        original = self.workflow(job, step)
        command_line = '        run: ' + COMMAND + self.digest
        mutations = {
            'missing step': original.replace('      - name: ' + step, '      - name: Other'),
            'missing command': original.replace(command_line, '        run: true'),
            'comment only': original.replace(command_line, '        # ' + COMMAND + self.digest),
            'echo': original.replace(command_line, '        run: echo ' + COMMAND + self.digest),
            'quoted data': original.replace(command_line, '        env: "' + COMMAND + self.digest + '"'),
            'dynamic expression': original.replace(self.digest, '${{ env.REVIEW_DIGEST }}'),
            'shell substitution': original.replace(self.digest, '$(sha256sum project-checks.json)'),
            'invalid digest': original.replace(self.digest, 'Z' * 64),
            'quoted run': original.replace(command_line, '        run: "' + COMMAND + self.digest + '"'),
            'multiline run': original.replace(command_line, '        run: |\n          ' + COMMAND + self.digest),
            'extra shell command': original.replace(command_line, command_line + ' && true'),
            'conditional step': original.replace(command_line, '        if: false\n' + command_line),
            'duplicate intended step': original + '      - name: ' + step + '\n' + command_line + '\n',
            'duplicate other step': original + '      - name: Other\n' + command_line + '\n',
            'duplicate run key': original + command_line + '\n',
            'duplicate mapping': original + '    steps: []\n',
            'quoted duplicate mapping': original + '    "steps": []\n',
            'escaped root duplicate': original + '"jo\\u0062s": {}\n',
            'escaped job duplicate': original + '  "offl\\u0069ne": {}\n',
            'escaped steps duplicate': original + '    "st\\u0065ps": []\n',
            'complex root key': original + '? jobs\n: {}\n',
            'complex job key': original + '  ? offline\n  : {}\n',
            'complex steps key': original + '    ? steps\n    : []\n',
            'merge key': original + '    <<: *other\n',
            'nested scalar decoy': original.replace('    steps:', '    description: |\n      steps:'),
        }
        for label, text in mutations.items():
            with self.subTest(case=label):
                with self.assertRaises(ValueError):
                    reviewed_digest(text, job, step)

    def test_comments_and_unrelated_digests_do_not_supply_approval(self):
        relative, job, step = WORKFLOWS[0]
        text = self.workflow(job, step)
        text = '# ' + COMMAND + '0' * 64 + '\n' + text
        text = text.replace('    runs-on:', '    unrelated: ' + '0' * 64 + '\n    runs-on:')
        self.assertEqual(reviewed_digest(text, job, step), self.digest)


if __name__ == '__main__':
    unittest.main()
