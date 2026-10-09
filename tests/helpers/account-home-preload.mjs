// Test-only preload (node --import). Every process in a suite run resolves the account home named by
// CORE_TEST_ACCOUNT_HOME, the way production resolves it (the OS account record). os.homedir() still follows HOME, as the harness-native root does.
// Production code never loads this file.
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const home = process.env.CORE_TEST_ACCOUNT_HOME;
if (home) {
  os.userInfo = () => ({ homedir: home });
  syncBuiltinESMExports();
}
