/** @type {import('jest').Config} */
module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['ts', 'js', 'json'],
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
