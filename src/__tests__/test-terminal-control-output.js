'use babel';

import {spawn} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Colors is an indirect dependency of terminal-table, the text reporter's printer.
// eslint-disable-next-line import/no-extraneous-dependencies
import colors from 'colors/safe';

import reportText from '../lib/report-text';

// C0 controls except tab and line feed, plus DEL and C1.
// The text table legitimately contains newlines. Color SGR sequences are
// disabled in these tests, so no ESC bytes should remain in the output.
const TERMINAL_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

const ESC = '\u001b';
const BEL = '\u0007';
const CR = '\r';
const CSI = '\u009b';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FLOW_BIN = path.join(
  REPO_ROOT,
  'node_modules/flow-bin/flow-linux64-v0.72.0/flow'
);
const CLI_ENTRY = path.join(REPO_ROOT, 'src/lib/cli/index.js');
const BABEL_REGISTER = path.join(REPO_ROOT, 'node_modules/babel-core/register.js');

const FLOW_SOURCE = [
  '// @flow',
  'export const value: number = 1;',
  ''
].join('\n');

jest.setTimeout(60000);

function expectTerminalSafe(text, fragments) {
  const output = String(text);
  expect(output).not.toMatch(TERMINAL_CONTROLS);
  fragments.forEach(fragment => {
    expect(output).toContain(fragment);
  });
}

function writeRunner(dir) {
  const runner = path.join(dir, 'run-cli.js');
  fs.writeFileSync(runner, [
    '\'use strict\';',
    'process.argv = [\'node\', \'flow-coverage-report\'].concat(',
    '  JSON.parse(process.env.CLI_ARGV)',
    ');',
    'require(process.env.CLI_ENTRY).run();',
    ''
  ].join('\n'));
  return runner;
}

function writeFlowStub(dir) {
  const stub = path.join(dir, 'flow-stub.js');
  const source = [
    '#!/usr/bin/env node',
    '\'use strict\';',
    'const mode = process.env.FLOW_STUB_MODE || \'ok\';',
    'const sub = process.argv[2];',
    'if (mode === \'status-fail\') {',
    '  process.stderr.write(\'status\' + \'\\u001b]0;STAT\\u0007\' + \'boom\');',
    '  process.exit(1);',
    '}',
    'if (sub === \'status\') {',
    '  process.stdout.write(JSON.stringify({',
    '    passed: true,',
    '    flowVersion: \'9.9.9\\u001b]0;VER\\u0007\',',
    '    errors: []',
    '  }));',
    '  process.exit(0);',
    '}',
    'if (sub === \'ast\') {',
    '  if (mode === \'ast-bad\') {',
    '    process.stdout.write(JSON.stringify({',
    '      comments: [{type: \'Weird\\u001b]0;TYPE\\u0007\', value: \'@flow\'}]',
    '    }));',
    '    process.exit(0);',
    '  }',
    '  process.stdout.write(JSON.stringify({',
    '    comments: [{type: \'Line\', value: \'@flow\'}]',
    '  }));',
    '  process.exit(0);',
    '}',
    'if (sub === \'coverage\') {',
    '  if (mode === \'coverage-fail\') {',
    '    process.stderr.write(\'coverage\' + \'\\u001b]0;STDERR\\u0007\' + \'marker\');',
    '    process.exit(1);',
    '  }',
    '  process.stdout.write(JSON.stringify({',
    '    expressions: {',
    '      covered_count: 1,',
    '      uncovered_count: 1,',
    '      uncovered_locs: []',
    '    }',
    '  }));',
    '  process.exit(0);',
    '}',
    'process.stderr.write(\'unknown flow subcommand\');',
    'process.exit(1);',
    ''
  ].join('\n');
  fs.writeFileSync(stub, source, {mode: 0o755});
  return stub;
}

function runCli(argv, env, scratchDir, cwd) {
  const runner = writeRunner(scratchDir);
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-r', BABEL_REGISTER, runner], {
      cwd,
      env: Object.assign({}, process.env, {
        NODE_ENV: 'development',
        FORCE_COLOR: '0',
        CLI_ENTRY,
        CLI_ARGV: JSON.stringify(argv)
      }, env),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 45000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        combined: stdout + '\n' + stderr
      });
    });
  });
}

function stopFlow(projectDir) {
  return new Promise(resolve => {
    const child = spawn(FLOW_BIN, ['stop'], {cwd: projectDir, stdio: 'ignore'});
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

function spawnSyncChmod(dir) {
  const child = spawn('chmod', ['-R', 'u+rwx', dir], {stdio: 'ignore'});
  return new Promise(resolve => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

function writeProjectFile(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body);
}

describe('terminal control characters in the text report', () => {
  let rootDir;
  let projectDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cov-term-'));
    // The directory name itself is attacker-controlled when a config file sets
    // projectDir, and the text summary prints its basename.
    projectDir = path.join(rootDir, 'reportproj' + ESC + ']0;DIR' + BEL);
    fs.mkdirSync(path.join(projectDir, 'src'), {recursive: true});
    fs.writeFileSync(path.join(projectDir, '.flowconfig'), '[ignore]\n');
  });

  afterEach(async () => {
    if (projectDir && fs.existsSync(FLOW_BIN)) {
      await stopFlow(projectDir);
    }
    if (rootDir) {
      await spawnSyncChmod(rootDir);
      fs.rmSync(rootDir, {recursive: true, force: true});
    }
  });

  it(
    'strips controls from filenames, glob patterns, and the project name',
    async () => {
      writeProjectFile(path.join(projectDir, 'src'), 'ok.js', FLOW_SOURCE);
      writeProjectFile(
        path.join(projectDir, 'src'),
        'bel' + BEL + 'file.js',
        FLOW_SOURCE
      );
      writeProjectFile(
        path.join(projectDir, 'src'),
        'low' + CR + ESC + '[1A' + ESC + '[2Kcovered.js',
        FLOW_SOURCE
      );
      writeProjectFile(
        path.join(projectDir, 'src'),
        'c1' + CSI + '31mfile.js',
        FLOW_SOURCE
      );
      writeProjectFile(
        path.join(projectDir, 'src'),
        'skip' + BEL + 'me.js',
        FLOW_SOURCE
      );
      writeProjectFile(
        path.join(projectDir, 'src'),
        'plain' + BEL + '.js',
        'export const value = 1;\n'
      );

      const result = await runCli([
        '--no-config',
        '--project-dir', projectDir,
        '--include-glob', 'src/**/*.js',
        '--include-glob', 'pat' + ESC + ']0;GLOB' + BEL,
        '--exclude-glob', 'src/skip*',
        '--exclude-glob', 'ex' + ESC + ']0;EX' + BEL,
        '--flow-command-path', FLOW_BIN,
        '--threshold', '1',
        '--type', 'text',
        '--exclude-non-flow'
      ], {VERBOSE: '1'}, rootDir, projectDir);

      expect(result.code === 0 || result.code === 2).toBe(true);
      expectTerminalSafe(result.combined, [
        'src/ok.js',
        'src/belfile.js',
        'src/low[1A[2Kcovered.js',
        'src/c131mfile.js',
        'src/skipme.js',
        'src/plain.js',
        'pat]0;GLOB',
        'ex]0;EX',
        'reportproj]0;DIR',
        'filename'
      ]);
    }
  );

  it('strips controls from a filename that makes coverage collection fail', async () => {
    writeProjectFile(path.join(projectDir, 'src'), 'ok.js', FLOW_SOURCE);
    writeProjectFile(
      path.join(projectDir, 'src'),
      'owned-file' + ESC + ']0;nosuchcmd' + BEL + '.js',
      FLOW_SOURCE
    );

    const result = await runCli([
      '--no-config',
      '--project-dir', projectDir,
      '--include-glob', 'src/**/*.js',
      '--flow-command-path', FLOW_BIN,
      '--threshold', '1',
      '--type', 'text'
    ], {VERBOSE: '1'}, rootDir, projectDir);

    expect(result.code === 0 || result.code === 2).toBe(true);
    expectTerminalSafe(result.combined, [
      'src/ok.js',
      'src/owned-file]0;nosuchcmd.js',
      'ERROR Collecting coverage data from'
    ]);
  });

  it(
    'strips controls from the flow version, flow stderr, and the html url',
    async () => {
      const stub = writeFlowStub(rootDir);
      const outputDir = path.join(projectDir, 'out' + ESC + ']0;OUT' + BEL);
      writeProjectFile(
        path.join(projectDir, 'src'),
        'name' + BEL + '.js',
        FLOW_SOURCE
      );

      const result = await runCli([
        '--no-config',
        '--project-dir', projectDir,
        '--include-glob', 'src/**/*.js',
        '--flow-command-path', stub,
        '--threshold', '1',
        '--type', 'text',
        '--type', 'html',
        '--output-dir', outputDir
      ], {FLOW_STUB_MODE: 'coverage-fail', VERBOSE: '1'}, rootDir, projectDir);

      expect(result.code === 0 || result.code === 2).toBe(true);
      expectTerminalSafe(result.combined, [
        'src/name.js',
        '9.9.9]0;VER',
        'coverage]0;STDERRmarker',
        'out]0;OUT'
      ]);
    }
  );

  it('strips controls echoed from a failing flow status command', async () => {
    const stub = writeFlowStub(rootDir);
    writeProjectFile(path.join(projectDir, 'src'), 'ok.js', FLOW_SOURCE);

    const result = await runCli([
      '--no-config',
      '--project-dir', projectDir,
      '--include-glob', 'src/**/*.js',
      '--flow-command-path', stub,
      '--threshold', '1',
      '--type', 'text'
    ], {FLOW_STUB_MODE: 'status-fail', VERBOSE: '1'}, rootDir, projectDir);

    expect(result.code).toBe(255);
    expectTerminalSafe(result.combined, [
      'status]0;STATboom'
    ]);
  });

  it('strips controls from an annotation printed by the text report', async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logs.push(args.map(value => String(value)).join(' '));
    };
    colors.disable();

    const filename = 'src/annotated' + BEL + '.js';
    /* eslint-disable camelcase */
    const coverageData = {
      flowStatus: {
        passed: true,
        errors: [],
        flowVersion: '1.2.3' + ESC + ']0;VER' + BEL
      },
      generatedAt: 'Thu Jan 01 2026',
      covered_count: 1,
      uncovered_count: 1,
      threshold: 80,
      percent: 50,
      globIncludePatterns: ['src/*.js' + ESC + ']0;IN' + BEL],
      globExcludePatterns: ['test' + CR + 'hide'],
      files: {
        [filename]: {
          percent: 10,
          annotation: 'flow' + ESC + ']0;ANN' + BEL + CR + 'hidden',
          isFlow: true,
          expressions: {
            covered_count: 1,
            uncovered_count: 9,
            uncovered_locs: []
          }
        }
      }
    };
    /* eslint-enable camelcase */

    try {
      await reportText.generate(coverageData, {
        projectDir,
        threshold: 80
      });
    } finally {
      console.log = originalLog;
    }

    expectTerminalSafe(logs.join('\n'), [
      'src/annotated.js',
      'flow]0;ANNhidden',
      '1.2.3]0;VER',
      'src/*.js]0;IN',
      'testhide',
      'reportproj]0;DIR',
      '10 %'
    ]);
  });

  it(
    'strips controls from an annotation error raised while reading flow ast',
    async () => {
      const stub = writeFlowStub(rootDir);
      writeProjectFile(
        path.join(projectDir, 'src'),
        'name' + BEL + '.js',
        FLOW_SOURCE
      );

      const result = await runCli([
        '--no-config',
        '--project-dir', projectDir,
        '--include-glob', 'src/**/*.js',
        '--flow-command-path', stub,
        '--threshold', '1',
        '--type', 'text'
      ], {FLOW_STUB_MODE: 'ast-bad'}, rootDir, projectDir);

      expect(result.code).toBe(255);
      expectTerminalSafe(result.combined, [
        'Weird]0;TYPE'
      ]);
    }
  );
});
