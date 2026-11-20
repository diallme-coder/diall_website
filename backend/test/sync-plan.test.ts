import assert from 'node:assert/strict';
import test from 'node:test';
import { planSync } from '../src/sync-plan.js';

test('plans independent remote and local changes while ignoring app-only fields', () => {
  const plan = planSync(
    [
      { id: 'local', data: { firstName: 'Ada', category: 'Work' }, updatedAt: '2026-01-01', deleted: false },
      { id: 'edit-local', data: { firstName: 'Grace' }, updatedAt: '2026-01-02', deleted: false }
    ],
    [
      { contactId: 'local', externalId: 'remote-1', baseData: { firstName: 'Ada' } },
      { contactId: 'edit-local', externalId: 'remote-2', baseData: { firstName: 'Grace' } }
    ],
    [
      { id: 'remote-1', data: { firstName: 'Ada Lovelace' } },
      { id: 'remote-2', data: { firstName: 'Grace' } }
    ]
  );

  assert.deepEqual(plan.operations.map(({ kind, contactId }) => [kind, contactId]), [
    ['import', 'local']
  ]);
  assert.equal(plan.conflicts.length, 0);
});

test('surfaces divergent edits for explicit user choice', () => {
  const plan = planSync(
    [{ id: 'c1', data: { firstName: 'Local' }, deleted: false }],
    [{ contactId: 'c1', externalId: 'p1', baseData: { firstName: 'Base' } }],
    [{ id: 'p1', data: { firstName: 'Provider' } }]
  );
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0]?.kind, 'bothChanged');
  assert.equal(plan.conflicts[0]?.local.firstName, 'Local');
  assert.equal(plan.conflicts[0]?.remote?.firstName, 'Provider');
});

test('records a common baseline when both sides independently clear the same field', () => {
  const plan = planSync(
    [{ id: 'c1', data: { email: '' }, deleted: false }],
    [{ contactId: 'c1', externalId: 'p1', baseData: { email: 'old@example.test' } }],
    [{ id: 'p1', data: {} }]
  );
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.operations[0]?.kind, 'baseline');
});

test('propagates deletions only when the other side has not changed', () => {
  const plan = planSync(
    [
      { id: 'same', data: { firstName: 'Same' }, deleted: false },
      { id: 'deleted', data: { firstName: 'Deleted' }, deleted: true },
      { id: 'edited', data: { firstName: 'Changed' }, deleted: false },
      { id: 'remote-deleted', data: { firstName: 'Local edit' }, deleted: false }
    ],
    [
      { contactId: 'same', externalId: 'r1', baseData: { firstName: 'Same' } },
      { contactId: 'deleted', externalId: 'r2', baseData: { firstName: 'Deleted' } },
      { contactId: 'edited', externalId: 'r3', baseData: { firstName: 'Old' } },
      { contactId: 'remote-deleted', externalId: 'r4', baseData: { firstName: 'Old' } }
    ],
    [
      { id: 'r2', data: { firstName: 'Deleted' } },
      { id: 'r3', data: { firstName: 'Old' } }
    ]
  );
  assert.deepEqual(plan.operations.map((operation) => operation.kind).sort(), ['deleteLocal', 'deleteRemote', 'export']);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0]?.kind, 'remoteDeleted');
});
