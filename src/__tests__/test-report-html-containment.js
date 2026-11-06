'use babel';

import fs from 'fs';
import os from 'os';
import path from 'path';

import generateFlowCoverageReport from '../lib';
import reportHTML from '../lib/report-html';

// Placeholder file contents. These are not credentials.
const OUTSIDE_MARKER = 'OUTSIDE_MARKER_PLACEHOLDER';
const INSIDE_MARKER = 'INSIDE_MARKER_PLACEHOLDER';
const AUTHORIZED_MARKER = 'AUTHORIZED_MARKER_PLACEHOLDER';

function writeFlowStub(filePath) {
  const source = [
    '#!/usr/bin/env node',
    'const command = process.argv[2];',
    'if (command === \'status\') {',
    '  process.stdout.write(JSON.stringify({',
    '    passed: true,',
    '    flowVersion: \'stub\',',
    '    errors: []',
    '  }));',
    '  process.exit(0);',
    '}',
    'process.stderr.write(\'coverage stub did not read the source file\');',
    'process.exit(1);',
    ''
  ].join('\n');
  fs.writeFileSync(filePath, source, {mode: 0o755});
}

function walkFiles(dir, found = []) {
  if (!fs.existsSync(dir)) {
    return found;
  }
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      walkFiles(fullPath, found);
    } else if (entry.isFile()) {
      found.push(fullPath);
    }
  }
  return found;
}

function filesContaining(dir, marker) {
  const needle = Buffer.from(marker);
  return walkFiles(dir).filter(filePath => fs.readFileSync(filePath).includes(needle));
}

function coverageFor(filename) {
  return {
    filename,
    annotation: 'no flow',
    isFlow: false,
    isError: true,
    percent: 0,
    expressions: {
      /* eslint-disable camelcase */
      covered_count: 0,
      uncovered_count: 0,
      uncovered_locs: []
      /* eslint-enable camelcase */
    }
  };
}

function summaryWith(files) {
  const byName = {};
  for (const filename of files) {
    byName[filename] = coverageFor(filename);
  }
  return {
    threshold: 80,
    /* eslint-disable camelcase */
    covered_count: 0,
    uncovered_count: 0,
    /* eslint-enable camelcase */
    percent: 0,
    generatedAt: 'test',
    flowStatus: {passed: true, flowVersion: 'stub', errors: []},
    flowAnnotations: {
      passed: false,
      flowFiles: 0,
      flowWeakFiles: 0,
      noFlowFiles: files.length,
      totalFiles: files.length
    },
    files: byName,
    globIncludePatterns: [],
    globExcludePatterns: [],
    concurrentFiles: 1,
    strictCoverage: false
  };
}

// Retarget a symlink immediately before a later open/read of that same path.
// The first lookup still observes the original target. A second lookup of the
// symlink path observes the replacement. Reading the path captured by the
// first lookup does not.
function armRetargetOnUse(linkPath, nextTarget) {
  const linkAbs = path.resolve(linkPath);
  const original = {
    readFile: fs.readFile,
    readFileSync: fs.readFileSync,
    open: fs.open,
    openSync: fs.openSync,
    createReadStream: fs.createReadStream,
    promisesReadFile: fs.promises && fs.promises.readFile,
    promisesOpen: fs.promises && fs.promises.open
  };
  let moved = false;

  function isLink(candidate) {
    return typeof candidate === 'string' && path.resolve(candidate) === linkAbs;
  }

  function retarget() {
    if (moved) {
      return;
    }
    moved = true;
    fs.unlinkSync(linkAbs);
    fs.symlinkSync(nextTarget, linkAbs);
  }

  function wrap(originalFn) {
    return function (filePath, ...args) {
      if (isLink(filePath)) {
        retarget();
      }
      return originalFn.call(this, filePath, ...args);
    };
  }

  fs.readFile = wrap(original.readFile);
  fs.readFileSync = wrap(original.readFileSync);
  fs.open = wrap(original.open);
  fs.openSync = wrap(original.openSync);
  fs.createReadStream = wrap(original.createReadStream);
  if (original.promisesReadFile) {
    fs.promises.readFile = wrap(original.promisesReadFile);
    fs.promises.open = wrap(original.promisesOpen);
  }

  return function () {
    fs.readFile = original.readFile;
    fs.readFileSync = original.readFileSync;
    fs.open = original.open;
    fs.openSync = original.openSync;
    fs.createReadStream = original.createReadStream;
    if (original.promisesReadFile) {
      fs.promises.readFile = original.promisesReadFile;
      fs.promises.open = original.promisesOpen;
    }
  };
}

async function settle(promise) {
  try {
    return {result: await promise};
  } catch (err) {
    return {error: err};
  }
}

describe('HTML report path containment', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-coverage-report-'));
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  test('does not embed a symlink target from outside the project', async () => {
    const projectDir = path.join(root, 'project');
    const outputDir = path.join(root, 'output');
    const outsideDir = path.join(root, 'outside');
    fs.mkdirSync(path.join(projectDir, 'src'), {recursive: true});
    fs.mkdirSync(outsideDir, {recursive: true});

    const outsideFile = path.join(outsideDir, 'marker.txt');
    const insideFile = path.join(projectDir, 'src', 'ok.js');
    const linkFile = path.join(projectDir, 'src', 'linked.js');
    fs.writeFileSync(outsideFile, `${OUTSIDE_MARKER}\n`);
    fs.writeFileSync(insideFile, `${INSIDE_MARKER}\n`);
    fs.symlinkSync(outsideFile, linkFile);

    const flowCommandPath = path.join(root, 'flow-stub.js');
    writeFlowStub(flowCommandPath);

    const outsideBefore = fs.readdirSync(outsideDir);
    const {error} = await settle(generateFlowCoverageReport({
      projectDir,
      outputDir,
      flowCommandPath,
      globIncludePatterns: ['src/**/*.js'],
      globExcludePatterns: [],
      reportTypes: ['html'],
      threshold: 80,
      concurrentFiles: 1
    }));

    const leaked = filesContaining(outputDir, OUTSIDE_MARKER);
    const outsideAfter = fs.readdirSync(outsideDir);
    const createdOutside = outsideAfter.filter(name => !outsideBefore.includes(name));

    expect({
      error: error ? error.message : null,
      leaked,
      createdOutside,
      insideReported: filesContaining(outputDir, INSIDE_MARKER).length > 0
    }).toEqual({
      error: null,
      leaked: [],
      createdOutside: [],
      insideReported: true
    });
  });

  test('does not embed a symlink target swapped in after the path is checked', async () => {
    const projectDir = path.join(root, 'project');
    const outputDir = path.join(root, 'output');
    const outsideDir = path.join(root, 'outside');
    fs.mkdirSync(path.join(projectDir, 'src'), {recursive: true});
    fs.mkdirSync(outsideDir, {recursive: true});

    const outsideFile = path.join(outsideDir, 'marker.txt');
    const authorizedFile = path.join(projectDir, 'src', 'authorized.js');
    const okFile = path.join(projectDir, 'src', 'ok.js');
    const linkFile = path.join(projectDir, 'src', 'linked.js');
    fs.writeFileSync(outsideFile, `${OUTSIDE_MARKER}\n`);
    fs.writeFileSync(authorizedFile, `${AUTHORIZED_MARKER}\n`);
    fs.writeFileSync(okFile, `${INSIDE_MARKER}\n`);
    fs.symlinkSync(authorizedFile, linkFile);

    const restore = armRetargetOnUse(linkFile, outsideFile);
    let settled;
    try {
      settled = await settle(reportHTML.generate(summaryWith([
        'src/ok.js',
        'src/authorized.js',
        'src/linked.js'
      ]), {
        projectDir,
        outputDir,
        threshold: 80,
        htmlTemplateOptions: {autoHeightSource: false, showMeterBar: false}
      }));
    } finally {
      restore();
    }

    const leaked = filesContaining(outputDir, OUTSIDE_MARKER);
    expect({
      error: settled.error ? settled.error.message : null,
      leaked,
      insideReported: filesContaining(outputDir, INSIDE_MARKER).length > 0
    }).toEqual({
      error: null,
      leaked: [],
      insideReported: true
    });
  });
});
