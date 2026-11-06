'use babel';

/**
 * The CLI fails the process only when the reported percent is below the
 * threshold. These tests fail while a coverage error, timeout, or JSON
 * error result still exits 0, including with --no-config and an explicit
 * --threshold of 100, and while a failed file mixed with a fully covered
 * file stays above the threshold.
 *
 * Required behavior: exit non-zero when any included file's coverage
 * command fails, times out, or returns an error. A successful file with
 * zero expressions still exits 0 at a 100 percent threshold.
 */

const {
  createCoverageProject,
  removeCoverageProject
} = require('../../helpers/coverage-failure-fixture');
const {runFlowCoverageReport} = require('../../common');

const SHORT_TIMEOUT = '400';

function cliArgs(project, extra) {
  return [
    '--no-config',
    '-p', project.projectDir,
    '-i', '"src/*.js"',
    '-f', project.flowCommandPath,
    '--flow-command-timeout', SHORT_TIMEOUT,
    '-t', 'text',
    ...extra
  ];
}

async function runProject(fileNames, extraArgs) {
  const project = createCoverageProject(fileNames);
  try {
    const result = await runFlowCoverageReport(cliArgs(project, extraArgs), {
      cwd: project.projectDir
    });
    return result;
  } finally {
    removeCoverageProject(project.projectDir);
  }
}

describe('CLI coverage gate rejects files the tool did not measure', () => {
  const failureCases = [
    ['nonzero.js', 'non-zero exit'],
    ['jsonstdout.js', 'JSON error on stdout'],
    ['jsonstderr.js', 'JSON error on stderr'],
    ['badjson.js', 'unparseable coverage JSON'],
    ['emptyout.js', 'empty coverage stdout'],
    ['hang.js', 'coverage command timeout']
  ];

  failureCases.forEach(([fileName, label]) => {
    it(`exits non-zero at threshold 100 when the only file fails via ${label}`, async () => {
      const {exitCode} = await runProject([fileName], ['--threshold', '100']);
      expect(exitCode).not.toBe(0);
    });
  });

  it('exits non-zero when a failed file is mixed with a fully covered file above the threshold', async () => {
    const {exitCode, stdout, stderr} = await runProject(
      ['healthy.js', 'nonzero.js'],
      ['--threshold', '90']
    );

    // Healthy.js is 100 covered expressions and 0 uncovered. One omitted
    // failure must not leave the gate green at a 90 percent threshold.
    const output = `${stdout || ''}\n${stderr || ''}`;
    expect(output).toEqual(expect.stringContaining('src/nonzero.js'));
    expect(exitCode).not.toBe(0);
  });

  it('exits 0 for a successful file that really has zero expressions', async () => {
    const {exitCode} = await runProject(
      ['zeroexpr.js'],
      ['--threshold', '100']
    );
    expect(exitCode).toBe(0);
  });
});
