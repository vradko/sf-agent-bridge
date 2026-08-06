const { jestConfig } = require('@salesforce/sfdx-lwc-jest/config');

module.exports = {
  ...jestConfig,
  modulePathIgnorePatterns: ['<rootDir>/.localdevserver'],
  testPathIgnorePatterns: ['__tests__/testWidget', '__tests__/defaultWidget']
};
