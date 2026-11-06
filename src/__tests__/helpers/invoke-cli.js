process.chdir(process.env.FLOW_COVERAGE_PROJECT_DIR);
process.argv = ['node', 'flow-coverage-report'].concat(
  JSON.parse(process.env.FLOW_COVERAGE_ARGV)
);
require('../../lib/cli').run();
