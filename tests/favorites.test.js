import test from 'node:test';
import assert from 'node:assert/strict';
import {FavoritesDraft, FavoritesWriter, applyFavoriteDelta} from '../extension/favorites.js';

const allowed = ['AT', 'EE', 'NO', 'PL'];

test('options changes merge with remote additions and removals, preserving untouched order', () => {
  const draft = new FavoritesDraft(['NO', 'PL']);
  draft.set('AT', true);
  draft.receive(['PL', 'EE']);
  assert.deepEqual(draft.countries, ['PL', 'EE', 'AT']);
  const {snapshot, add, remove} = draft.beginSave();
  assert.deepEqual({add, remove}, {add: ['AT'], remove: []});
  const committed = applyFavoriteDelta(['PL', 'EE'], {add, remove});
  draft.receive(committed); draft.finishSave(snapshot, true);
  assert.deepEqual(draft.countries, ['PL', 'EE', 'AT']); assert.equal(draft.changed, false);
});

test('a normal local undo leaves no pending changes or reorder', () => {
  const draft = new FavoritesDraft(['NO', 'EE']);
  draft.set('NO', false); draft.set('NO', true);
  draft.set('AT', true); draft.set('AT', false);
  assert.deepEqual(draft.countries, ['NO', 'EE']); assert.equal(draft.changed, false);
});

test('edits and undo during save survive own storage event and response', () => {
  for (const present of [false, true]) {
    const draft = new FavoritesDraft(present ? ['NO'] : []);
    draft.set('NO', !present);
    const {snapshot, add, remove} = draft.beginSave();
    draft.set('NO', present); // Undo before the pending write is visible remotely.
    draft.set('AT', true);
    draft.receive(applyFavoriteDelta(present ? ['NO'] : [], {add, remove}));
    draft.receive([...draft.remote, 'EE']);
    draft.finishSave(snapshot, true);
    assert.equal(draft.countries.includes('NO'), present);
    assert.ok(draft.countries.includes('AT')); assert.ok(draft.countries.includes('EE'));
    assert.equal(draft.changed, true);
    const retry = draft.beginSave();
    assert.ok(retry[present ? 'add' : 'remove'].includes('NO'));
    draft.receive(applyFavoriteDelta(draft.remote, retry));
    draft.finishSave(retry.snapshot, true);
    assert.equal(draft.changed, false);
    assert.equal(draft.countries.includes('NO'), present);
  }
});

test('changes to the same country after its storage event remain after acknowledgement', () => {
  const draft = new FavoritesDraft(['NO']);
  draft.set('AT', true);
  const first = draft.beginSave();
  draft.receive(['NO', 'AT']);
  draft.set('AT', false);
  draft.finishSave(first.snapshot, true);
  assert.deepEqual(draft.countries, ['NO']); assert.equal(draft.changed, true);
  const second = draft.beginSave(); assert.deepEqual(second.remove, ['AT']);
});

test('failed save retains retry intents, remote edits and newer local edits', () => {
  const draft = new FavoritesDraft(['NO']);
  draft.set('AT', true);
  const first = draft.beginSave();
  draft.set('PL', true); draft.receive(['EE']);
  draft.finishSave(first.snapshot, false);
  assert.deepEqual(draft.countries, ['EE', 'AT', 'PL']);
  const retry = draft.beginSave(); assert.deepEqual(retry.add, ['AT', 'PL']);
  draft.receive(applyFavoriteDelta(['EE'], retry)); draft.finishSave(retry.snapshot, true);
  assert.equal(draft.changed, false); assert.deepEqual(draft.countries, ['EE', 'AT', 'PL']);
});

test('undo during a failed save needs no retry when the baseline never changed', () => {
  const draft = new FavoritesDraft(['NO']);
  draft.set('NO', false); const first = draft.beginSave();
  draft.set('NO', true); draft.finishSave(first.snapshot, false);
  assert.equal(draft.changed, false); assert.deepEqual(draft.countries, ['NO']);
});

test('concurrent explicit same-country operations are idempotent and order is deterministic', async () => {
  const state = {countries: ['NO','PL']};
  const writer = new FavoritesWriter({get: async () => structuredClone(state), set: async value => Object.assign(state, value)}, allowed);
  await Promise.all([
    writer.write({action: 'settings', add: ['EE','AT'], remove: ['NO']}),
    writer.write({action: 'settings', add: ['EE'], remove: []}),
    writer.write({action: 'settings', add: [], remove: ['AT']}),
    writer.write({action: 'settings', add: ['AT'], remove: []})
  ]);
  assert.deepEqual(state.countries, ['PL','EE','AT']);
});
