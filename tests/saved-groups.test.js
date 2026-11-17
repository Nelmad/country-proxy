import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appliedCountries, readGroups, updateGroups} from '../extension/saved-groups.js';

const allowed = ['AT','EE','NO','PL'];
const all = ['AT','EE','NO'];
const group = {id:'alpha', name:'По работе', countries:all};

test('selection honors legacy and current storage and rejects a partly invalid group', () => {
  assert.deepEqual(appliedCountries({selected:'PL'}, allowed), ['PL']);
  assert.deepEqual(appliedCountries({selected:'PL', selectedCountries:['NO','EE','AT']}, allowed), all);
  assert.deepEqual(appliedCountries({selected:'PL', selectedCountries:['EE','XX']}, allowed), []);
  assert.deepEqual(appliedCountries({selected:'PL', selectedCountries:[]}, allowed), []);
});

test('groups round-trip regardless of selection or storage order', () => {
  const raw = [{...group, countries:['NO','EE','AT','EE']}];
  const restored = readGroups(raw, allowed);
  assert.deepEqual(restored,[group]);
  const again = appliedCountries({selectedCountries:['EE','NO','AT']},allowed);
  assert.deepEqual(updateGroups([], {...group, name:'   По работе   ', countries:again}, allowed), restored);
  assert.deepEqual(updateGroups([], {id:'one', name:'Одна страна', countries:['NO']}, allowed),
    [{id:'one', name:'Одна страна', countries:['NO']}]);
  assert.throws(() => readGroups([{...group, countries:['AT','XX']}], allowed));
  assert.throws(() => readGroups([group, group], allowed));
});

test('invalid country, duplicate group and duplicate title do not modify saved records', () => {
  const saved = [group];
  const add = {id:'beta', name:'Ещё', countries:['PL']};
  assert.throws(() => updateGroups(saved, {...add,countries:['GB']}, allowed), /стран/i);
  assert.throws(() => updateGroups(saved, {...add, name:'по работе'}, allowed), /названием/);
  assert.throws(() => updateGroups(saved, {...add, countries:all}, allowed), /набором/);
  assert.throws(() => updateGroups(saved, {...add, name:'   '}, allowed), /название/);
  assert.deepEqual(saved, [group]);
});

test('renaming and removing a group preserve disjoint changes and reject stale edits', () => {
  const other = {id:'beta', name:'Семья', countries:['PL']};
  const renamed = updateGroups([group, other], {original:group, name:'Работа',countries:all}, allowed);
  assert.deepEqual(renamed, [{...group, name:'Работа'},other]);
  assert.throws(() => updateGroups(renamed, {original:group, remove:true}, allowed), /изменилась/);
  assert.deepEqual(updateGroups(renamed, {original:renamed[0], remove:true}, allowed), [other]);
});

test('country edits keep the id, canonicalize order, reject duplicate sets, and detect a concurrent membership change', () => {
  const other = {id:'beta', name:'Семья', countries:['PL']};
  const draft = {original:group, name:group.name, countries:['PL','NO','NO']};
  const changed = updateGroups([group, other], draft, allowed);
  assert.deepEqual(changed, [{...group, countries:['NO','PL']}, other]);
  assert.throws(() => updateGroups(changed, draft, allowed), /изменилась/);
  assert.throws(() => updateGroups([group, other], {...draft, countries:['PL']}, allowed), /набором/);
  assert.throws(() => updateGroups([group], {...draft, countries:[]}, allowed), /стран/);
});
