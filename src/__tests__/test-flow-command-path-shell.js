'use babel';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

jest.setTimeout(30000);

const REPO_ROOT = path.join(__dirname, '../..');
const BABEL_NODE = path.join(REPO_ROOT, 'node_modules/.bin/babel-node');
const INVOKE_CLI = path.join(__dirname, 'helpers/invoke-cli.js');
const createdDirs = [];

afterAll(() => {
  createdDirs.forEach(dir => {
    fs.rmSync(dir, {recursive: true, force: true});
  });
});

function makeProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-coverage-report-'));
  fs.mkdirSync(path.join(projectDir, 'src'));
  fs.writeFileSync(path.join(projectDir, 'src', 'main.js'), '// fixture\n');
  createdDirs.push(projectDir);
  return projectDir;
}

function markerIn(projectDir, name) {
  return path.join(projectDir, name);
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeExecutable(filePath, body) {
  fs.writeFileSync(filePath, body, {mode: 0o755});
  fs.chmodSync(filePath, 0o755);
}

function writePackageSection(projectDir, flowCommandPath) {
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      'flow-coverage-report': {flowCommandPath}
    }, null, 2)
  );
}

function writePackageWithoutSection(projectDir) {
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({name: 'fixture'}, null, 2)
  );
}

function writeDotfile(projectDir, flowCommandPath) {
  fs.writeFileSync(
    path.join(projectDir, '.flow-coverage-report.json'),
    JSON.stringify({flowCommandPath}, null, 2)
  );
}

function writeConfigFile(projectDir, flowCommandPath) {
  const configPath = path.join(projectDir, 'reporter-config.json');
  fs.writeFileSync(configPath, JSON.stringify({flowCommandPath}, null, 2));
  return configPath;
}

function writeRelativeProgram(projectDir, marker) {
  writeExecutable(
    path.join(projectDir, 'evil-flow'),
    `#!/bin/sh\n: > ${quoteShell(marker)}\n`
  );
  return './evil-flow';
}

// Prints valid flow JSON for status/coverage/ast. Records a side effect only
// when the ast invocation is performed by a shell, which is how
// flow-annotation-check genCheckFlowStatus launches flowCommandPath.
function writeAnnotationProbe(projectDir, marker) {
  const scriptPath = path.join(projectDir, 'flow-probe.sh');
  writeExecutable(scriptPath, [
    '#!/bin/sh',
    'parent=$(cat /proc/$PPID/comm 2>/dev/null | tr -d \'[:space:]\')',
    'cmd="$1"',
    'if [ "$cmd" = "ast" ] && [ "$parent" != "node" ]; then',
    `  : > ${quoteShell(marker)}`,
    'fi',
    'case "$cmd" in',
    '  status)',
    '    printf \'%s\\n\' \'{"passed":true,"flowVersion":"0.0.0","errors":[]}\'',
    '    ;;',
    '  coverage)',
    '    printf \'%s\\n\' \'{"expressions":{"covered_count":1,"uncovered_count":0,"uncovered_locs":[]}}\'',
    '    ;;',
    '  ast)',
    '    printf \'%s\\n\' \'{"comments":[]}\'',
    '    ;;',
    'esac',
    'exit 0',
    ''
  ].join('\n'));
  return scriptPath;
}

function runCli(projectDir, argv) {
  const result = spawnSync(BABEL_NODE, [INVOKE_CLI], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, {
      FLOW_COVERAGE_PROJECT_DIR: projectDir,
      FLOW_COVERAGE_ARGV: JSON.stringify(argv)
    }),
    encoding: 'utf8',
    timeout: 20000
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function expectAbsent(marker) {
  expect(fs.existsSync(marker)).toBe(false);
}

describe('repository flowCommandPath must not be a shell command', () => {
  test('package.json flowCommandPath is not executed when -i is passed and -f is omitted', () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    writePackageSection(projectDir, `touch ${marker} #`);
    runCli(projectDir, ['-i', 'src/*.js']);
    expectAbsent(marker);
  });

  test('package.json command substitution in flowCommandPath is not executed', () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    writePackageSection(projectDir, `$(touch ${marker})`);
    runCli(projectDir, ['-i', 'src/*.js']);
    expectAbsent(marker);
  });

  test('package.json relative flowCommandPath is not executed when -f is omitted', () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    writePackageSection(projectDir, writeRelativeProgram(projectDir, marker));
    runCli(projectDir, ['-i', 'src/*.js']);
    expectAbsent(marker);
  });

  test('.flow-coverage-report.json flowCommandPath is not executed when package.json is absent', () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    writeDotfile(projectDir, `touch ${marker} #`);
    runCli(projectDir, ['-i', 'src/*.js']);
    expectAbsent(marker);
  });

  test('.flow-coverage-report.json is not executed when package.json has no reporter section', () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    writePackageWithoutSection(projectDir);
    writeDotfile(projectDir, `touch ${marker} #`);
    runCli(projectDir, ['-i', 'src/*.js']);
    expectAbsent(marker);
  });

  test('.flow-coverage-report.json relative flowCommandPath is not executed when -f is omitted', () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    writeDotfile(projectDir, writeRelativeProgram(projectDir, marker));
    runCli(projectDir, ['-i', 'src/*.js']);
    expectAbsent(marker);
  });

  test('--config flowCommandPath is not executed when -f is omitted', () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    const configPath = writeConfigFile(projectDir, `touch ${marker} #`);
    runCli(projectDir, ['-i', 'src/*.js', '--config', configPath]);
    expectAbsent(marker);
  });

  test('--config relative flowCommandPath is not executed when -f is omitted', () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    const configPath = writeConfigFile(projectDir, writeRelativeProgram(projectDir, marker));
    runCli(projectDir, ['-i', 'src/*.js', '--config', configPath]);
    expectAbsent(marker);
  });

  test('an explicit -f value is not executed through a shell', () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    runCli(projectDir, ['-i', 'src/*.js', '-f', `touch ${marker} #`]);
    expectAbsent(marker);
  });

  test('an explicit -f executable overrides package.json flowCommandPath', () => {
    const projectDir = makeProject();
    const configMarker = markerIn(projectDir, 'from-config');
    const explicitMarker = markerIn(projectDir, 'from-flag');
    writePackageSection(projectDir, `touch ${configMarker} #`);
    const scriptPath = path.join(projectDir, 'explicit-flow');
    writeExecutable(scriptPath, `#!/bin/sh\n: > ${quoteShell(explicitMarker)}\n`);
    runCli(projectDir, ['-i', 'src/*.js', '-f', scriptPath]);
    expectAbsent(configMarker);
    expect(fs.existsSync(explicitMarker)).toBe(true);
  });

  test('--no-config does not execute package.json flowCommandPath', () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    writePackageSection(projectDir, `touch ${marker} #`);
    runCli(projectDir, ['-i', 'src/*.js', '--no-config']);
    expectAbsent(marker);
  });
});

describe('flowCommandPath sinks do not use a shell', () => {
  [
    ['a hash comment', marker => `touch ${marker} #`],
    ['a semicolon', marker => `touch ${marker};`],
    ['a newline', marker => `touch ${marker}\n`],
    ['command substitution', marker => `$(touch ${marker})`],
    ['backtick substitution', marker => `\`touch ${marker}\``],
    ['a pipe', marker => `touch ${marker} | true`],
    ['an && operator', marker => `touch ${marker} && true`]
  ].forEach(([name, buildPayload]) => {
    test(`checkFlowStatus does not shell-execute ${name} in flowCommandPath`, async () => {
      const projectDir = makeProject();
      const marker = markerIn(projectDir, 'marker');
      const flow = require('../lib/flow');
      await flow.checkFlowStatus(buildPayload(marker), projectDir).catch(() => {});
      expectAbsent(marker);
    });
  });

  test('collectFlowCoverageForFile does not shell-execute flowCommandPath', async () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    const flow = require('../lib/flow');
    await flow.collectFlowCoverageForFile({
      flowCommandPath: `touch ${marker} #`,
      flowCommandTimeout: 5000,
      projectDir,
      strictCoverage: false
    }, 'src/main.js');
    expectAbsent(marker);
  });

  test('collectFlowCoverageForFile does not shell-execute flowCommandPath for annotation checks', async () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    const flow = require('../lib/flow');
    await flow.collectFlowCoverageForFile({
      flowCommandPath: writeAnnotationProbe(projectDir, marker),
      flowCommandTimeout: 5000,
      projectDir,
      strictCoverage: false
    }, 'src/main.js').catch(() => {});
    expectAbsent(marker);
  });

  test('excludeNonFlow does not shell-execute flowCommandPath for annotation checks', async () => {
    const projectDir = makeProject();
    const marker = markerIn(projectDir, 'marker');
    const flow = require('../lib/flow');
    await flow.collectFlowCoverage({
      flowCommandPath: writeAnnotationProbe(projectDir, marker),
      flowCommandTimeout: 5000,
      projectDir,
      globIncludePatterns: ['src/*.js'],
      globExcludePatterns: [],
      threshold: 80,
      percentDecimals: 0,
      concurrentFiles: 1,
      strictCoverage: false,
      excludeNonFlow: true
    }).catch(() => {});
    expectAbsent(marker);
  });
});
