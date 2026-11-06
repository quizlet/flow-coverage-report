'use babel';

import fs from 'fs';
import os from 'os';
import path from 'path';

import {collectFlowCoverage, collectFlowCoverageForFile} from '../lib/flow';
import {glob} from '../lib/promisified';

// These tests are the spec for a shell injection in coverage collection.
// They fail while a scanned filename is still interpolated into a shell
// command, and they pass once that filename can no longer run a command.
const INCLUDE = 'src/**/*.js';

function quoteSh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function removeDir(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }

  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    if (fs.lstatSync(entryPath).isDirectory()) {
      removeDir(entryPath);
    } else {
      fs.unlinkSync(entryPath);
    }
  }

  fs.rmdirSync(dir);
}

function writeFakeFlow(flowPath, argvLog) {
  const log = quoteSh(argvLog);
  const script = `#!/bin/sh
printf '%s\\n' "$0" >> ${log}
for arg do
  printf '%s\\n' "$arg" >> ${log}
done
printf '\\n---\\n' >> ${log}
case "$1" in
  status)
    printf '%s\\n' '{"passed":true,"flowVersion":"0.72.0","errors":[]}'
    ;;
  coverage)
    printf '%s\\n' '{"expressions":{"covered_count":1,"uncovered_count":0,"uncovered_locs":[]}}'
    ;;
  ast)
    printf '%s\\n' '{"comments":[{"type":"Line","value":"@flow"}]}'
    ;;
esac
exit 0
`;
  fs.writeFileSync(flowPath, script);
  fs.chmodSync(flowPath, 0o755);
}

function writePayload(scriptPath, markerPath) {
  fs.writeFileSync(scriptPath, `printf 'injected\\n' > ${quoteSh(markerPath)}\n`);
}

function writeSource(projectDir, relativeName) {
  const fullPath = path.join(projectDir, relativeName);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
  fs.writeFileSync(fullPath, '// @flow\n');
}

function coverageOptions(projectDir, flowPath, extra) {
  return {
    flowCommandPath: flowPath,
    flowCommandTimeout: 15000,
    projectDir,
    globIncludePatterns: [INCLUDE],
    globExcludePatterns: [],
    threshold: 90,
    percentDecimals: 0,
    concurrentFiles: 1,
    strictCoverage: false,
    excludeNonFlow: false,
    ...extra
  };
}

// Run `body` with process.cwd() and the coverage cwd both set to a fresh
// project. The CLI defaults projectDir to process.cwd(), and the annotation
// checker shells out without its own cwd.
async function withProject(body) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cov-shell-'));
  const previousCwd = process.cwd();
  const flowPath = path.join(projectDir, 'fake-flow');
  const argvLog = path.join(projectDir, 'argv.log');

  fs.mkdirSync(path.join(projectDir, 'src'));
  writeFakeFlow(flowPath, argvLog);
  process.chdir(projectDir);

  try {
    await body({projectDir, flowPath, argvLog});
  } finally {
    process.chdir(previousCwd);
    removeDir(projectDir);
  }
}

// The interesting failure is a payload that ran. Include the argv log in the
// comparison so a failure shows which flow subcommand was reached.
function expectPayloadDidNotRun(markerPath, argvLog) {
  const argvLogText = readText(argvLog);
  expect({
    payloadRan: fs.existsSync(markerPath),
    argvLog: argvLogText
  }).toEqual({
    payloadRan: false,
    argvLog: argvLogText
  });
}

async function settle(promise) {
  try {
    return await promise;
  } catch (err) {
    return err;
  }
}

test('glob match with semicolon and input redirection is not executed', async () => {
  await withProject(async ({projectDir, flowPath, argvLog}) => {
    const relativeName = 'src/x;sh<pwn.sh;.js';
    const markerPath = path.join(projectDir, 'shell-payload-marker');
    writePayload(path.join(projectDir, 'pwn.sh'), markerPath);
    writeSource(projectDir, relativeName);

    const matches = await glob(INCLUDE, {cwd: projectDir, root: projectDir});
    expect(matches).toContain(relativeName);

    await settle(collectFlowCoverage(coverageOptions(projectDir, flowPath)));

    expect(readText(argvLog)).toContain('status');
    expectPayloadDidNotRun(markerPath, argvLog);
  });
});

test('glob match that is a single-token command is not executed', async () => {
  await withProject(async ({projectDir, flowPath, argvLog}) => {
    const markerPath = path.join(projectDir, 'shell-id-marker');
    const relativeName = 'src/a;id>shell-id-marker;.js';
    writeSource(projectDir, relativeName);

    const matches = await glob(INCLUDE, {cwd: projectDir, root: projectDir});
    expect(matches).toContain(relativeName);

    await settle(collectFlowCoverage(coverageOptions(projectDir, flowPath)));

    expect(readText(argvLog)).toContain('status');
    expectPayloadDidNotRun(markerPath, argvLog);
  });
});

test('coverage command does not execute a piped filename', async () => {
  await withProject(async ({projectDir, flowPath, argvLog}) => {
    const relativeName = 'src/p|sh<pipe-payload.sh;.js';
    const markerPath = path.join(projectDir, 'shell-pipe-marker');
    writePayload(path.join(projectDir, 'pipe-payload.sh'), markerPath);
    writeSource(projectDir, relativeName);

    await settle(collectFlowCoverageForFile(
      coverageOptions(projectDir, flowPath),
      relativeName
    ));

    expectPayloadDidNotRun(markerPath, argvLog);
  });
});

test('coverage command does not execute a background filename', async () => {
  await withProject(async ({projectDir, flowPath, argvLog}) => {
    const relativeName = 'src/c&sh<bg-payload.sh;.js';
    const markerPath = path.join(projectDir, 'shell-bg-marker');
    writePayload(path.join(projectDir, 'bg-payload.sh'), markerPath);
    writeSource(projectDir, relativeName);

    await settle(collectFlowCoverageForFile(
      coverageOptions(projectDir, flowPath),
      relativeName
    ));

    expectPayloadDidNotRun(markerPath, argvLog);
  });
});

test('excludeNonFlow annotation check does not execute the scanned filename', async () => {
  await withProject(async ({projectDir, flowPath, argvLog}) => {
    const relativeName = 'src/x;sh<pwn.sh;.js';
    const markerPath = path.join(projectDir, 'shell-annotation-marker');
    writePayload(path.join(projectDir, 'pwn.sh'), markerPath);
    writeSource(projectDir, relativeName);

    const matches = await glob(INCLUDE, {cwd: projectDir, root: projectDir});
    expect(matches).toContain(relativeName);

    await settle(collectFlowCoverage(coverageOptions(projectDir, flowPath, {
      excludeNonFlow: true
    })));

    expect(readText(argvLog)).toContain('status');
    expectPayloadDidNotRun(markerPath, argvLog);
  });
});

test('annotation read after a successful coverage command does not execute the filename', async () => {
  await withProject(async ({projectDir, flowPath, argvLog}) => {
    // No second semicolon, so a shell that runs the payload can still exit 0
    // and reach the annotation command that follows a parsed coverage result.
    const relativeName = 'src/x;sh<pwn.sh.js';
    const markerPath = path.join(projectDir, 'shell-after-coverage-marker');
    writePayload(path.join(projectDir, 'pwn.sh.js'), markerPath);
    writeSource(projectDir, relativeName);

    const matches = await glob(INCLUDE, {cwd: projectDir, root: projectDir});
    expect(matches).toContain(relativeName);

    await settle(collectFlowCoverage(coverageOptions(projectDir, flowPath)));

    expect(readText(argvLog)).toContain('status');
    expectPayloadDidNotRun(markerPath, argvLog);
  });
});
