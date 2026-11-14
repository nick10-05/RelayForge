// Shared helpers for integration tests.
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://relayforge:relayforge@localhost:5433/relayforge_test';

/**
 * Engine tests get their own database. The claim query takes ANY due delivery, so it must
 * not see (or steal) the pending deliveries that API tests create in the shared test DB.
 * Created and migrated by global-setup; the engine test project runs its files serially.
 */
export const ENGINE_DATABASE_NAME = 'relayforge_engine_test';
export const ENGINE_TEST_DATABASE_URL = (() => {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${ENGINE_DATABASE_NAME}`;
  return url.toString();
})();

/** A URL where nothing is listening, for "database down" tests. */
export const UNREACHABLE_DATABASE_URL = 'postgres://relayforge:relayforge@127.0.0.1:1/none';
