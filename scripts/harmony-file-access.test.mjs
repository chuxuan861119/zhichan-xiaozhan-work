import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';

const parent = 'file://docs/storage/Users/currentUser/Download';
const target = `${parent}/example.patdoc`;
const source = await readFile(new URL('../platforms/harmony/arkts/WorkbenchFileAccess.ets', import.meta.url), 'utf8');
const code = transformSync(source.replace(/^import .*;\r?\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;

function fixture({ old = [], selected = [parent], revoked = false, deny = false } = {}) {
  let stored = JSON.stringify(old);
  let picks = 0;
  let active = false;
  const persisted = new Set(old.filter(p => !revoked).map(p => p.uri));
  const fileShare = {
    OperationMode: { READ_MODE: 1, WRITE_MODE: 2, CREATE_MODE: 4, DELETE_MODE: 8, RENAME_MODE: 16 },
    persistPermission: async policies => {
      for (const p of policies) {
        // Picker grants directory read/write. Additional per-target bits are not granted.
        if (deny || !selected.includes(p.uri) || (p.operationMode & ~3)) throw Error('Permission not granted');
        persisted.add(p.uri);
      }
    },
    activatePermission: async policies => {
      for (const p of policies) {
        if (!persisted.has(p.uri) || (p.operationMode & ~3)) throw Error('Permission revoked');
      }
      active = true;
    },
  };
  const preferences = { getPreferencesSync: () => ({
    getSync: () => stored,
    putSync: (_key, value) => { stored = value; },
    flush: async () => {},
  }) };
  const picker = {
    DocumentSelectOptions: class {}, DocumentSelectMode: { FOLDER: 1 },
    DocumentViewPicker: class { async select() { picks++; return selected; } },
  };
  const Inject = { getOrCreate: () => ({ getContext: () => ({}), getActiveContext: () => ({}) }) };
  const module = { exports: {} };
  new Function('fileShare', 'picker', 'preferences', 'Inject', 'ContextAdapter', 'module', 'exports', code)(
    fileShare, picker, preferences, Inject, {}, module, module.exports,
  );
  return { api: module.exports, policies: () => JSON.parse(stored), picks: () => picks, active: () => active };
}

test('save directory persists only the read/write grant provided by Picker', async () => {
  const f = fixture();
  assert.equal(await f.api.ensureSaveDirectoryAccess(target), true);
  assert.equal(f.active(), true);
  assert.deepEqual(f.policies(), [{ uri: parent, operationMode: 3 }]);
  assert.equal(await f.api.ensureSaveDirectoryAccess(target), true);
  assert.equal(f.picks(), 1);
});

test('legacy directory grants restore as read/write without invalidating other saved files', async () => {
  const f = fixture({ old: [{ uri: parent, operationMode: 31 }, { uri: `${parent}/old.patdoc`, operationMode: 1 }] });
  const result = await new Promise(resolve => f.api.restoreFileAccess(value => resolve(JSON.parse(value))));
  assert.deepEqual(result, { restored: 2, failed: 0 });
  assert.equal(await f.api.ensureSaveDirectoryAccess(target), true);
  assert.equal(f.picks(), 0);
});

test('revoked access requires selection again; cancellation and denial never authorize a save', async () => {
  const old = [{ uri: parent, operationMode: 31 }];
  const canceled = fixture({ old, revoked: true, selected: [] });
  assert.equal(await canceled.api.ensureSaveDirectoryAccess(target), false);
  assert.equal(canceled.active(), false);
  assert.deepEqual(canceled.policies(), old);
  const denied = fixture({ deny: true });
  await assert.rejects(denied.api.ensureSaveDirectoryAccess(target), /Permission not granted/);
  assert.deepEqual(denied.policies(), []);
  const renewed = fixture({ old, revoked: true });
  assert.equal(await renewed.api.ensureSaveDirectoryAccess(target), true);
  assert.deepEqual(renewed.policies(), [{ uri: parent, operationMode: 3 }]);
});

test('selecting a different directory does not authorize the requested destination', async () => {
  const f = fixture({ selected: [`${parent}/other`] });
  await assert.rejects(f.api.ensureSaveDirectoryAccess(target), /Unexpected save directory/);
  assert.deepEqual(f.policies(), []);
});
