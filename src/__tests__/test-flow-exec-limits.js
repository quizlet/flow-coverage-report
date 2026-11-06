'use babel';

import {spawn} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  checkFlowStatus,
  collectFlowCoverage,
  collectFlowCoverageForFile
} from '../lib/flow';

// Node's own default, from lib/child_process.js (MAX_BUFFER) in the runtime
// that executes these tests. Callers override it with Infinity today.
const NODE_MAX_BUFFER = 1024 * 1024;

// A flow subprocess must be bounded by the timeout the caller already passes
// in, and by a finite stdout/stderr cap no larger than NODE_MAX_BUFFER.
// checkFlowStatus(flowCommandPath, projectDir, tmpDirPath, flowCommandTimeout)
// has to forward that fourth argument. collectFlowCoverage and
// collectFlowCoverageForFile have to forward opts.flowCommandTimeout.
// The same bounds apply to every flow subprocess reached from a project
// file: `flow status`, `flow coverage`, and `flow ast`.
const HANG_TIMEOUT = 400;
const HANG_DEADLINE = 1500;
const SLOW_STATUS_MS = 600;
const SLOW_TIMEOUT = 1500;
const SLOW_DEADLINE = 4000;

const REPO_ROOT = path.resolve(__dirname, '../..');

jest.setTimeout(20000);

function writeStub(ctx, mode) {
  const source = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const pidFile = ${JSON.stringify(ctx.pidFile)};
const logFile = ${JSON.stringify(ctx.logFile)};
const mode = ${JSON.stringify(mode)};
const slowMs = ${SLOW_STATUS_MS};
const padLength = ${NODE_MAX_BUFFER};
fs.appendFileSync(pidFile, String(process.pid) + '\\n');
const command = process.argv[2];
fs.appendFileSync(logFile, String(command) + ' ' + Date.now() + '\\n');

function statusOk() {
  process.stdout.write(JSON.stringify({
    passed: true,
    flowVersion: '9.9.9',
    errors: []
  }));
  process.exit(0);
}

function coverageOk() {
  process.stdout.write(JSON.stringify({
    expressions: {
      covered_count: 1,
      uncovered_count: 0,
      uncovered_locs: []
    }
  }));
  process.exit(0);
}

function astOk() {
  process.stdout.write(JSON.stringify({
    comments: [{type: 'Line', value: '@flow'}]
  }));
  process.exit(0);
}

function hang() {
  setInterval(() => {}, 1000);
}

function writeAll(payload) {
  const bytes = Buffer.from(payload);
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const wrote = fs.writeSync(1, bytes, offset, bytes.length - offset);
      if (wrote > 0) {
        offset += wrote;
      }
    } catch (err) {
      if (err.code !== 'EAGAIN') {
        throw err;
      }
    }
  }
}

function writeBig(body) {
  const pad = 'x'.repeat(padLength);
  writeAll(JSON.stringify(body(pad)));
  process.exit(0);
}

if (command === 'status') {
  if (mode === 'hang-status') {
    hang();
  } else if (mode === 'slow-status') {
    setTimeout(statusOk, slowMs);
  } else if (mode === 'big-status') {
    writeBig(pad => ({
      passed: true,
      flowVersion: '9.9.9',
      errors: [],
      pad
    }));
  } else {
    statusOk();
  }
} else if (command === 'coverage') {
  if (mode === 'hang-coverage') {
    hang();
  } else if (mode === 'big-coverage') {
    writeBig(pad => ({
      expressions: {
        covered_count: 1,
        uncovered_count: 0,
        uncovered_locs: []
      },
      pad
    }));
  } else {
    coverageOk();
  }
} else if (command === 'ast') {
  if (mode === 'hang-ast') {
    hang();
  } else if (mode === 'big-ast') {
    writeBig(pad => ({
      comments: [{type: 'Line', value: '@flow'}],
      pad
    }));
  } else {
    astOk();
  }
} else {
  process.stderr.write('unexpected flow command ' + command);
  process.exit(1);
}
`;
  fs.writeFileSync(ctx.stub, source);
  fs.chmodSync(ctx.stub, 0o755);
}

function killPids(pidFile) {
  if (!fs.existsSync(pidFile)) {
    return;
  }
  for (const pid of fs.readFileSync(pidFile, 'utf8').split('\n')) {
    if (!pid) {
      continue;
    }
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch (err) {
      // The stub already exited.
    }
  }
}

async function withStub(mode, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-exec-limits-'));
  const ctx = {
    dir,
    stub: path.join(dir, 'flow-stub.js'),
    pidFile: path.join(dir, 'pids'),
    logFile: path.join(dir, 'commands.log')
  };
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src', 'main.js'),
    '// @flow\nexport const value = 1;\n'
  );
  writeStub(ctx, mode);
  try {
    return await fn(ctx);
  } finally {
    killPids(ctx.pidFile);
  }
}

function readLog(ctx) {
  if (!fs.existsSync(ctx.logFile)) {
    return '';
  }
  return fs.readFileSync(ctx.logFile, 'utf8');
}

function commandNames(ctx) {
  return readLog(ctx)
    .split('\n')
    .filter(Boolean)
    .map(line => line.split(' ')[0]);
}

function expectWaited(ctx, command, timeoutMs) {
  const line = readLog(ctx)
    .split('\n')
    .find(entry => entry.startsWith(`${command} `));
  const started = line ? Number(line.split(' ')[1]) : NaN;
  const waited = Date.now() - started;
  expect(Number.isFinite(started)).toBe(true);
  expect(waited).toBeGreaterThanOrEqual(Math.floor(timeoutMs * 0.75));
  expect(waited).toBeLessThan(timeoutMs + 800);
}

function coverageOptions(ctx, timeout, extra) {
  return {
    flowCommandPath: ctx.stub,
    flowCommandTimeout: timeout,
    projectDir: ctx.dir,
    globIncludePatterns: ['src/*.js'],
    globExcludePatterns: [],
    threshold: 50,
    percentDecimals: 0,
    concurrentFiles: 1,
    strictCoverage: false,
    excludeNonFlow: false,
    ...extra
  };
}

async function settle(promise, deadlineMs) {
  const started = Date.now();
  let timer;
  const outcome = await Promise.race([
    promise.then(
      value => ({status: 'fulfilled', value}),
      error => ({status: 'rejected', error})
    ),
    new Promise(resolve => {
      timer = setTimeout(() => resolve({status: 'pending'}), deadlineMs);
    })
  ]);
  clearTimeout(timer);
  outcome.elapsed = Date.now() - started;
  return outcome;
}

function childError(error) {
  if (error && error.error && typeof error.error === 'object') {
    return error.error;
  }
  return error;
}

function expectTimedKill(result, timeoutMs) {
  const error = childError(result.error);
  expect(result.status).toBe('rejected');
  expect(error && error.killed).toBe(true);
  expect(error && error.signal).toBe('SIGTERM');
  expect(result.elapsed).toBeGreaterThanOrEqual(Math.floor(timeoutMs * 0.75));
  expect(result.elapsed).toBeLessThan(timeoutMs + 800);
}

function expectMaxBuffer(result) {
  const error = childError(result.error);
  expect(result.status).toBe('rejected');
  expect(error && error.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  expect(String(error && error.message)).toMatch(/maxBuffer/);
}

function runCli(ctx, timeout) {
  const runner = path.join(ctx.dir, 'run-cli.js');
  fs.writeFileSync(
    runner,
    `require(${JSON.stringify(require.resolve('babel-register'))});
require(${JSON.stringify(path.join(REPO_ROOT, 'src/lib/cli/index.js'))}).run();
`
  );

  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      runner,
      '--no-config',
      '--project-dir', ctx.dir,
      '--include-glob', 'src/*.js',
      '--flow-command-path', ctx.stub,
      '--flow-command-timeout', String(timeout),
      '--threshold', '50',
      '--type', 'text'
    ], {
      cwd: REPO_ROOT,
      env: {...process.env, NODE_ENV: 'development'}
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const started = Date.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      resolve({
        status: 'pending',
        elapsed: Date.now() - started,
        stdout,
        stderr,
        exitCode: null
      });
    }, HANG_DEADLINE);
    child.on('close', code => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        status: 'exited',
        elapsed: Date.now() - started,
        stdout,
        stderr,
        exitCode: code
      });
    });
  });
}

test('collectFlowCoverage rejects a hung flow status within flowCommandTimeout', async () => {
  await withStub('hang-status', async ctx => {
    const result = await settle(
      collectFlowCoverage(coverageOptions(ctx, HANG_TIMEOUT)),
      HANG_DEADLINE
    );
    expectTimedKill(result, HANG_TIMEOUT);
    expectWaited(ctx, 'status', HANG_TIMEOUT);
    expect(commandNames(ctx)).toEqual(['status']);
  });
});

test('checkFlowStatus rejects a hung flow status within its timeout argument', async () => {
  await withStub('hang-status', async ctx => {
    const result = await settle(
      checkFlowStatus(ctx.stub, ctx.dir, null, HANG_TIMEOUT),
      HANG_DEADLINE
    );
    expectTimedKill(result, HANG_TIMEOUT);
    expectWaited(ctx, 'status', HANG_TIMEOUT);
    expect(commandNames(ctx)).toEqual(['status']);
  });
});

test('collectFlowCoverage rejects oversized flow status output', async () => {
  await withStub('big-status', async ctx => {
    const result = await settle(
      collectFlowCoverage(coverageOptions(ctx, SLOW_TIMEOUT)),
      SLOW_DEADLINE
    );
    expectMaxBuffer(result);
    expect(commandNames(ctx)).toEqual(['status']);
  });
});

test('checkFlowStatus rejects oversized flow status output', async () => {
  await withStub('big-status', async ctx => {
    const result = await settle(
      checkFlowStatus(ctx.stub, ctx.dir, null, SLOW_TIMEOUT),
      SLOW_DEADLINE
    );
    expectMaxBuffer(result);
  });
});

test('collectFlowCoverage rejects oversized flow coverage output', async () => {
  await withStub('big-coverage', async ctx => {
    const result = await settle(
      collectFlowCoverage(coverageOptions(ctx, SLOW_TIMEOUT)),
      SLOW_DEADLINE
    );
    expectMaxBuffer(result);
    expect(commandNames(ctx)).toEqual(['status', 'coverage']);
  });
});

test('collectFlowCoverageForFile rejects a hung flow ast command within flowCommandTimeout', async () => {
  await withStub('hang-ast', async ctx => {
    const result = await settle(
      collectFlowCoverageForFile(
        coverageOptions(ctx, HANG_TIMEOUT),
        'src/main.js'
      ),
      HANG_DEADLINE
    );
    expectTimedKill(result, HANG_TIMEOUT);
    expectWaited(ctx, 'ast', HANG_TIMEOUT);
    expect(commandNames(ctx)).toEqual(['coverage', 'ast']);
  });
});

test('excludeNonFlow rejects a hung flow ast command before coverage', async () => {
  await withStub('hang-ast', async ctx => {
    const result = await settle(
      collectFlowCoverage(coverageOptions(ctx, HANG_TIMEOUT, {excludeNonFlow: true})),
      HANG_DEADLINE
    );
    expectTimedKill(result, HANG_TIMEOUT);
    expectWaited(ctx, 'ast', HANG_TIMEOUT);
    expect(commandNames(ctx)).toEqual(['status', 'ast']);
  });
});

test('collectFlowCoverageForFile rejects oversized flow ast output', async () => {
  await withStub('big-ast', async ctx => {
    const result = await settle(
      collectFlowCoverageForFile(
        coverageOptions(ctx, SLOW_TIMEOUT),
        'src/main.js'
      ),
      SLOW_DEADLINE
    );
    expectMaxBuffer(result);
    expect(commandNames(ctx)).toEqual(['coverage', 'ast']);
  });
});

test('collectFlowCoverage still accepts a flow status that returns before the timeout', async () => {
  await withStub('slow-status', async ctx => {
    const result = await settle(
      collectFlowCoverage(coverageOptions(ctx, SLOW_TIMEOUT)),
      SLOW_DEADLINE
    );
    expect(result.status).toBe('fulfilled');
    expect(result.value.flowStatus.flowVersion).toBe('9.9.9');
    expect(result.value.files['src/main.js'].expressions.covered_count).toBe(1);
    expect(result.elapsed).toBeGreaterThanOrEqual(SLOW_STATUS_MS - 50);
    expect(result.elapsed).toBeLessThan(SLOW_TIMEOUT + 800);
    expect(commandNames(ctx)).toEqual(['status', 'coverage', 'ast']);
  });
});

test('the CLI exits non-zero when flow status hangs', async () => {
  await withStub('hang-status', async ctx => {
    const result = await runCli(ctx, HANG_TIMEOUT);
    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(255);
    expectWaited(ctx, 'status', HANG_TIMEOUT);
    expect(result.stderr).toMatch(/Error while generating Flow Coverage Report/);
    expect(commandNames(ctx)).toEqual(['status']);
  });
});

test('the CLI exits non-zero when flow status output exceeds the buffer cap', async () => {
  await withStub('big-status', async ctx => {
    const result = await runCli(ctx, SLOW_TIMEOUT);
    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(255);
    expect(result.stderr).toMatch(/maxBuffer/);
    expect(result.elapsed).toBeLessThan(HANG_DEADLINE);
    expect(commandNames(ctx)).toEqual(['status']);
  });
});
