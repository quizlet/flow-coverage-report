'use babel';

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  collectFlowCoverage,
  collectFlowCoverageForFile
} from '../../../src/lib/flow';
import {glob} from '../../../src/lib/promisified';

// Same filename the report describes. `;` and `<` are outside the
// escape class shared by escapeFileName and flow-annotation-check's escapeShell.
const SHELL_FILENAME = 'src/x;sh<pwn.sh;.js';

// The trailing `.js` makes the finding's filename exit non-zero, so coverage
// collection returns before the post-parse annotation check. `||true` is also
// outside the escape class and lets that shell exit 0 so the second check runs.
const EXIT_ZERO_FILENAME = 'src/x;sh<pwn.sh||true.js';

function writeFlowStub(stubPath) {
  fs.writeFileSync(stubPath, `#!/bin/sh
cmd="$1"
if [ "$cmd" = "status" ]; then
  printf '%s\\n' '{"passed":true,"flowVersion":"0.72.0","errors":[]}'
  exit 0
fi
if [ "$cmd" = "coverage" ]; then
  printf '%s\\n' '{"expressions":{"covered_count":1,"uncovered_count":0,"uncovered_locs":[]}}'
  exit 0
fi
if [ "$cmd" = "ast" ]; then
  printf '%s\\n' '{"comments":[]}'
  exit 0
fi
exit 0
`);
  fs.chmodSync(stubPath, 0o755);
}

function makeProject(filename) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-coverage-shell-'));
  const marker = path.join(projectDir, 'pwned');
  const stub = path.join(projectDir, 'flow-stub');
  writeFlowStub(stub);
  fs.writeFileSync(
    path.join(projectDir, 'pwn.sh'),
    `touch ${JSON.stringify(marker)}\n`
  );
  fs.mkdirSync(path.join(projectDir, 'src'));
  fs.writeFileSync(path.join(projectDir, filename), '/* fixture */\n');
  return {projectDir, marker, stub};
}

function removeProject(projectDir) {
  fs.rmSync(projectDir, {recursive: true, force: true});
}

// flow-annotation-check 1.8.1 exec() does not set cwd, so the shell inherits
// process.cwd(). The CLI defaults projectDir to process.cwd() and never chdir.
async function withProjectCwd(projectDir, fn) {
  const previous = process.cwd();
  process.chdir(projectDir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function settle(promise) {
  try {
    return {status: 'fulfilled', value: await promise};
  } catch (error) {
    return {status: 'rejected', error};
  }
}

function errorText(error) {
  if (!error) {
    return '';
  }
  if (error.message) {
    return String(error.message);
  }
  if (error.error && error.error.message) {
    return String(error.error.message);
  }
  return String(error);
}

test('excludeNonFlow does not execute a shell command embedded in a globbed filename', async () => {
  const {projectDir, marker, stub} = makeProject(SHELL_FILENAME);
  try {
    const files = await glob('src/*.js', {cwd: projectDir, root: projectDir});
    expect(files).toEqual([SHELL_FILENAME]);

    const outcome = await withProjectCwd(projectDir, () => settle(collectFlowCoverage({
      flowCommandPath: stub,
      projectDir,
      globIncludePatterns: ['src/*.js'],
      globExcludePatterns: [],
      threshold: 0,
      percentDecimals: 0,
      concurrentFiles: 1,
      strictCoverage: false,
      excludeNonFlow: true,
      flowCommandTimeout: 5000
    })));

    if (outcome.status === 'rejected') {
      const message = errorText(outcome.error);
      expect(message).not.toMatch(/status --json/);
      expect(message).not.toMatch(/Invalid Flow status/);
      expect(message).not.toMatch(/Parsing error on Flow status/);
    }

    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    removeProject(projectDir);
  }
});

test('excludeNonFlow does not execute the filename when the annotation shell exits zero', async () => {
  const {projectDir, marker, stub} = makeProject(EXIT_ZERO_FILENAME);
  try {
    const files = await glob('src/*.js', {cwd: projectDir, root: projectDir});
    expect(files).toEqual([EXIT_ZERO_FILENAME]);

    const outcome = await withProjectCwd(projectDir, () => settle(collectFlowCoverage({
      flowCommandPath: stub,
      projectDir,
      globIncludePatterns: ['src/*.js'],
      globExcludePatterns: [],
      threshold: 0,
      percentDecimals: 0,
      concurrentFiles: 1,
      strictCoverage: false,
      excludeNonFlow: true,
      flowCommandTimeout: 5000
    })));

    if (outcome.status === 'rejected') {
      const message = errorText(outcome.error);
      expect(message).not.toMatch(/status --json/);
      expect(message).not.toMatch(/Invalid Flow status/);
      expect(message).not.toMatch(/Parsing error on Flow status/);
    } else {
      expect(outcome.value.files[EXIT_ZERO_FILENAME]).toBeUndefined();
    }

    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    removeProject(projectDir);
  }
});

test('collectFlowCoverageForFile does not execute a shell command embedded in the filename', async () => {
  const {projectDir, marker, stub} = makeProject(SHELL_FILENAME);
  try {
    const outcome = await withProjectCwd(projectDir, () => settle(collectFlowCoverageForFile({
      flowCommandPath: stub,
      projectDir,
      flowCommandTimeout: 5000,
      strictCoverage: false
    }, SHELL_FILENAME)));

    if (outcome.status === 'fulfilled') {
      expect(outcome.value.filename).toBe(SHELL_FILENAME);
    }
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    removeProject(projectDir);
  }
});

test('parsed coverage still does not execute a shell command in the annotation check', async () => {
  const {projectDir, marker, stub} = makeProject(EXIT_ZERO_FILENAME);
  try {
    const outcome = await withProjectCwd(projectDir, () => settle(collectFlowCoverageForFile({
      flowCommandPath: stub,
      projectDir,
      flowCommandTimeout: 5000,
      strictCoverage: false
    }, EXIT_ZERO_FILENAME)));

    expect(outcome.status).toBe('fulfilled');
    expect(outcome.value.filename).toBe(EXIT_ZERO_FILENAME);
    expect(outcome.value.isError).not.toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    removeProject(projectDir);
  }
});
