// Shared helpers for integration tests.
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://relayforge:relayforge@localhost:5433/relayforge_test';

/** A URL where nothing is listening, for "database down" tests. */
export const UNREACHABLE_DATABASE_URL = 'postgres://relayforge:relayforge@127.0.0.1:1/none';
