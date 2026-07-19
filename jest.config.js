/** Tests run against the same database as DATABASE_URL (no local/shadow Postgres is
 * available in this environment — the DB user lacks CREATEDB). Every test creates its
 * own throwaway Business (and cascading rows) and deletes it in an afterAll/afterEach,
 * so this is safe to run against a shared dev database. Never run this against a
 * database you don't want throwaway rows briefly appearing in. */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 20000,
  testMatch: ['**/test/**/*.test.js'],
  verbose: true,
};
