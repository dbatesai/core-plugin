// Steers CORE's account home in a child process the way production resolves it (the OS account
// record), never through HOME: the child's os.userInfo() and os.homedir() answer with `home`.
export function accountHomeArgs(home) {
  const preload = `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';os.userInfo=()=>({homedir:${JSON.stringify(home)}});os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();`;
  return ['--import', 'data:text/javascript,' + encodeURIComponent(preload)];
}

// In-process version: from now on this process's os.userInfo()/os.homedir() answer with `home`.
// Call it at the top of a test file, before anything resolves the account home.
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
export function installAccountHome(home) {
  os.userInfo = () => ({ homedir: home });
  os.homedir = () => home;
  syncBuiltinESMExports();
}
