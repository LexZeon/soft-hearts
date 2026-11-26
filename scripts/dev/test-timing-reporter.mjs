// Node test reporter used by test-all --by-part: writes { file: ms } to the path in SH_TEST_TIMING_FILE. It runs next to the spec
// reporter, so the normal output is untouched. A file's time is the sum of its top-level tests.
import fs from 'node:fs';
import path from 'node:path';

export default async function* timing(source) {
  const ms = {};
  for await (const e of source) {
    if ((e.type === 'test:pass' || e.type === 'test:fail') && e.data.nesting === 0 && e.data.file) {
      const rel = path.relative(process.cwd(), e.data.file).replace(/\\/g, '/');
      ms[rel] = (ms[rel] ?? 0) + (e.data.details?.duration_ms ?? 0);
    }
  }
  if (process.env.SH_TEST_TIMING_FILE) fs.writeFileSync(process.env.SH_TEST_TIMING_FILE, JSON.stringify(ms));
}
