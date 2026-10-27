// The isolation guard a test calls before it writes anything through CORE's default account home.
// Pure: it compares paths and calls the test-area predicate it is given, and reads or writes nothing else.
// It throws (code ISOLATION_GUARD) unless CORE's account home is a test home and not the OS account's real one.
import { join, resolve } from 'node:path';

const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? resolve(p).toLowerCase() : resolve(p));
const refuse = (msg) => { throw Object.assign(new Error(`isolation guard: ${msg}`), { code: 'ISOLATION_GUARD' }); };

/**
 * coreHome: the account home CORE resolves (trustedHome()).
 * osHome: the OS account record's home, read outside the test preload.
 * isTestArea: true only for a home the test run created for itself.
 * Returns the registry path CORE would write, which is then known to be outside the real ~/.core.
 */
export function assertIsolatedAccountHome({ coreHome, osHome, isTestArea }) {
  if (!coreHome || !osHome) refuse(`an account home is missing (CORE ${coreHome || '(none)'}, OS ${osHome || '(none)'})`);
  if (fold(coreHome) === fold(osHome)) refuse(`CORE resolves the real OS account home ${osHome}; the test preload is not in effect`);
  const registry = join(coreHome, '.core', 'projects.json');
  if (fold(registry) === fold(join(osHome, '.core', 'projects.json'))) refuse(`CORE's registry is the real one, ${registry}`);
  if (typeof isTestArea !== 'function' || !isTestArea(coreHome)) refuse(`CORE's account home ${coreHome} is not a test home`);
  return registry;
}
