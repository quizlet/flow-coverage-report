'use babel';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUS_JSON = JSON.stringify({
  passed: true,
  flowVersion: '0.72.0',
  errors: []
});

const AST_JSON = JSON.stringify({
  comments: [{type: 'Line', value: '@flow'}]
});

function coveragePayload(covered, uncovered) {
  /* eslint-disable camelcase */
  return JSON.stringify({
    expressions: {
      covered_count: covered,
      uncovered_count: uncovered,
      uncovered_locs: []
    }
  });
  /* eslint-enable camelcase */
}

// Stand-in for the flow binary. Modes are selected from the source file name
// so one executable can serve every failure mode the collector handles.
const FAKE_FLOW_SOURCE = `#!/usr/bin/env node
'use strict';
const path = require('path');
const args = process.argv.slice(2);
const command = args[0];

function baseName() {
  return path.basename(args[args.length - 1] || '');
}

if (command === 'status') {
  process.stdout.write(${JSON.stringify(STATUS_JSON)});
  process.exit(0);
}

if (command === 'ast') {
  process.stdout.write(${JSON.stringify(AST_JSON)});
  process.exit(0);
}

if (command === 'coverage') {
  const base = baseName();
  if (base.startsWith('hang')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (base.startsWith('nonzero')) {
    process.stdout.write(${JSON.stringify(coveragePayload(99, 0))});
    process.stderr.write('coverage command failed');
    process.exit(2);
  }
  if (base.startsWith('jsonstdout')) {
    process.stdout.write(JSON.stringify({error: 'coverage json error'}));
    process.exit(0);
  }
  if (base.startsWith('jsonstderr')) {
    process.stderr.write(JSON.stringify({error: 'coverage json error'}));
    process.exit(0);
  }
  if (base.startsWith('badjson')) {
    process.stdout.write('{');
    process.exit(0);
  }
  if (base.startsWith('emptyout')) {
    process.exit(0);
  }
  if (base.startsWith('healthy')) {
    process.stdout.write(${JSON.stringify(coveragePayload(100, 0))});
    process.exit(0);
  }
  if (base.startsWith('partial')) {
    process.stdout.write(${JSON.stringify(coveragePayload(8, 2))});
    process.exit(0);
  }
  if (base.startsWith('zeroexpr')) {
    process.stdout.write(${JSON.stringify(coveragePayload(0, 0))});
    process.exit(0);
  }
}

process.stderr.write('unexpected flow invocation: ' + args.join(' '));
process.exit(99);
`;

function writeSourceFile(projectDir, name) {
  const srcDir = path.join(projectDir, 'src');
  fs.mkdirSync(srcDir, {recursive: true});
  const filePath = path.join(srcDir, name);
  fs.writeFileSync(filePath, '// @flow\nconst value = 1;\n');
  return path.join('src', name);
}

function createCoverageProject(fileNames) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cov-fail-'));
  const flowCommandPath = path.join(projectDir, 'fake-flow.js');
  fs.writeFileSync(flowCommandPath, FAKE_FLOW_SOURCE);
  fs.chmodSync(flowCommandPath, 0o755);
  const relativeFiles = fileNames.map(name => writeSourceFile(projectDir, name));
  return {projectDir, flowCommandPath, relativeFiles};
}

function removeCoverageProject(projectDir) {
  fs.rmSync(projectDir, {recursive: true, force: true});
}

module.exports = {
  createCoverageProject,
  removeCoverageProject
};
