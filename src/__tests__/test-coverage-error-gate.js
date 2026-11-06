'use babel';

/**
 * Coverage commands that fail, time out, or return an error must not be
 * omitted from the project total. These tests fail while that happens:
 * error files are stored with zero covered and zero uncovered expressions,
 * getCoveredPercent reports 100 when the combined total is zero, and a
 * failing file mixed with healthy files leaves the percent at the healthy
 * ratio.
 *
 * Required behavior:
 * - an error file stays in the summary with isError, covered_count 0,
 *   uncovered_count >= 1, and percent 0, so it is fully uncovered
 * - when every included file failed, the project percent is 0
 * - when a failed file is mixed with measured files, the project percent
 *   is strictly below the percent of the measured files alone
 * - a successful file that really has zero expressions is still 100 percent
 */

const {
  createCoverageProject,
  removeCoverageProject
} = require('../../__tests__/helpers/coverage-failure-fixture');

const flow = require('../lib/flow');

const SHORT_TIMEOUT = 400;

function summaryOptions(project, extra) {
  return {
    flowCommandPath: project.flowCommandPath,
    flowCommandTimeout: SHORT_TIMEOUT,
    projectDir: project.projectDir,
    globIncludePatterns: ['src/*.js'],
    globExcludePatterns: [],
    threshold: 100,
    percentDecimals: 0,
    concurrentFiles: 1,
    ...extra
  };
}

function expectFullyUncoveredError(fileSummary) {
  expect(fileSummary.isError).toBe(true);
  expect(fileSummary.expressions.covered_count).toBe(0);
  expect(fileSummary.expressions.uncovered_count).toBeGreaterThan(0);
  expect(fileSummary.percent).toBe(0);
}

describe('coverage command failures are not omitted from the total', () => {
  const failureCases = [
    ['nonzero.js', 'non-zero exit'],
    ['jsonstdout.js', 'JSON error on stdout'],
    ['jsonstderr.js', 'JSON error on stderr'],
    ['badjson.js', 'unparseable coverage JSON'],
    ['emptyout.js', 'empty coverage stdout'],
    ['hang.js', 'coverage command timeout']
  ];

  failureCases.forEach(([fileName, label]) => {
    it(`reports 0 percent when the only file fails via ${label}`, async () => {
      const project = createCoverageProject([fileName]);
      try {
        const summary = await flow.collectFlowCoverage(summaryOptions(project));
        const relative = `src/${fileName}`;
        expect(Object.keys(summary.files)).toEqual([relative]);
        expectFullyUncoveredError(summary.files[relative]);
        expect(summary.covered_count).toBe(0);
        expect(summary.uncovered_count).toBeGreaterThan(0);
        expect(summary.percent).toBe(0);
      } finally {
        removeCoverageProject(project.projectDir);
      }
    });
  });

  it('counts every concurrent failure in the denominator', async () => {
    const project = createCoverageProject([
      'nonzero-a.js',
      'jsonstdout-b.js'
    ]);
    try {
      const summary = await flow.collectFlowCoverage(summaryOptions(project, {
        concurrentFiles: 2
      }));
      expect(Object.keys(summary.files).sort()).toEqual([
        'src/jsonstdout-b.js',
        'src/nonzero-a.js'
      ]);
      Object.keys(summary.files).forEach(filename => {
        expectFullyUncoveredError(summary.files[filename]);
      });
      expect(summary.covered_count).toBe(0);
      expect(summary.uncovered_count).toBeGreaterThanOrEqual(2);
      expect(summary.percent).toBe(0);
    } finally {
      removeCoverageProject(project.projectDir);
    }
  });

  it('lowers the project percent when a failed file is mixed with a measured file', async () => {
    const project = createCoverageProject([
      'healthy.js',
      'nonzero.js'
    ]);
    try {
      const summary = await flow.collectFlowCoverage(summaryOptions(project));
      const healthy = summary.files['src/healthy.js'];
      const failed = summary.files['src/nonzero.js'];

      expect(healthy.isError).toBeFalsy();
      expect(healthy.expressions.covered_count).toBe(100);
      expect(healthy.expressions.uncovered_count).toBe(0);
      expect(healthy.percent).toBe(100);

      expectFullyUncoveredError(failed);

      const measuredPercent = flow.getCoveredPercent(healthy.expressions);
      expect(summary.covered_count).toBe(100);
      expect(summary.uncovered_count).toBeGreaterThan(0);
      expect(summary.percent).toBeLessThan(measuredPercent);
    } finally {
      removeCoverageProject(project.projectDir);
    }
  });

  it('keeps a successful file with zero expressions at 100 percent', async () => {
    const project = createCoverageProject(['zeroexpr.js']);
    try {
      const summary = await flow.collectFlowCoverage(summaryOptions(project));
      const fileSummary = summary.files['src/zeroexpr.js'];
      expect(fileSummary.isError).toBeFalsy();
      expect(fileSummary.expressions.covered_count).toBe(0);
      expect(fileSummary.expressions.uncovered_count).toBe(0);
      expect(summary.percent).toBe(100);
    } finally {
      removeCoverageProject(project.projectDir);
    }
  });
});
