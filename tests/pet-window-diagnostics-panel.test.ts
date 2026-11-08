import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPetWindowDiagnostics } from '../src/ui/PetWindowDiagnosticsPanel';

test('the developer log reads as one line per native or renderer fact', () => {
  const text = formatPetWindowDiagnostics({ enabled: true, entries: [
    { t: 1250, event: 'repair', detail: { reason: 'restore', problems: 'hidden', visible: true } },
    { t: 4000, event: 'settled', detail: { reason: 'restore' } },
  ] });
  assert.equal(text, '1.25s repair reason=restore problems=hidden visible=true\n4.00s settled reason=restore');
});

test('with developer mode off the panel says nothing is recorded', () => {
  assert.match(formatPetWindowDiagnostics({ enabled: false, entries: [] }), /不记录/);
  assert.match(formatPetWindowDiagnostics({ enabled: true, entries: [] }), /还没有记录/);
});
