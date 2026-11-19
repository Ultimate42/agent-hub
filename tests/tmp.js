// Temporary directories of the tests.
// tmpDir() creates the directory and removes it when the test process exits (passed, failed, timed out or interrupted),
// whatever the test did with it: a test cannot leak by omission. /tmp is a tmpfs on many hosts (RAM + swap), where
// forgotten directories pile up with every run of the suite.
// Each test file runs in its own process (node --test), so the exit of that process is the end of the file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = new Set();
let armed = false;

function sweep() {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
  made.clear();
}

/** A new empty directory under os.tmpdir(), removed at process exit. */
export function tmpDir(prefix = 'test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(d);
  if (!armed) {
    armed = true;
    process.on('exit', sweep);
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(sig, () => { sweep(); process.exit(code); });
  }
  return d;
}
