import assert from 'node:assert/strict';
import test from 'node:test';
import { lineEndingDrift } from '../scripts/dev/build-candidate.mjs';

test('a script whose endings drifted to CRLF stops the build; Windows scripts are only noted', () => {
  const listing = [
    'i/lf    w/lf    attr/text=auto eol=lf \tCLAUDE.md',
    'i/lf    w/crlf  attr/text=auto eol=lf \tscripts/smoke.mjs',
    'i/lf    w/crlf  attr/text=auto eol=lf \tscripts/experience/register-nightly-task.ps1',
    'i/lf    w/crlf  attr/text=auto eol=lf \thandbook/文档 有空格.md',
    'i/crlf  w/crlf  attr/text eol=crlf    \tstart-soft-hearts.cmd',
    'i/-text w/-text attr/-text            \tassets/bundled/a.png',
    '',
  ].join('\n');
  assert.deepEqual(lineEndingDrift(listing), {
    blocking: ['scripts/smoke.mjs', 'handbook/文档 有空格.md'],
    harmless: ['scripts/experience/register-nightly-task.ps1'],
  });
});

test('a clean tree has no drift, and CRLF without an eol=lf rule is left alone', () => {
  assert.deepEqual(lineEndingDrift('i/lf    w/lf    attr/text=auto eol=lf \ta.ts\ni/lf    w/crlf  attr/text=auto      \tb.ts'), { blocking: [], harmless: [] });
});
