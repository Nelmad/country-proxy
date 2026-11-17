import assert from 'node:assert/strict';
import test from 'node:test';
import {exportGroups, parseBackup, mergeGroups} from '../extension/group-backup.js';

const allowed = ['AT','EE','NO','GB'];
const groups = [{name:'Группа', countries:['EE','NO'], id:'private-id', other:'private'}];

test('backup omits local identifiers, ignores remote IDs, and imports only supported country codes', () => {
  const json = exportGroups(groups,allowed);
  assert.ok(!json.includes('private'));
  const parsed = JSON.parse(json);
  parsed.groups[0].id = 'untrusted-id';
  const merged = mergeGroups([],parseBackup(JSON.stringify(parsed),allowed));
  assert.equal(merged.groups.length,1);
  assert.notEqual(merged.groups[0].id, parsed.groups[0].id);
  assert.deepEqual(merged.groups[0].countries,['EE','NO']);
  parsed.groups.push({name:'Invalid entry',countries:['ZZ']});
  assert.throws(() => parseBackup(JSON.stringify(parsed),allowed));
});

test('merging preserves existing groups and skips equivalent country sets or colliding names', () => {
  const json = exportGroups([
    {id:'a',name:'Другая',countries:['NO','EE']},
    {id:'b',name:'группа',countries:['GB']},
    {id:'c',name:'Новая',countries:['AT']}],allowed);
  const result = mergeGroups(groups,parseBackup(json,allowed));
  assert.deepEqual([result.added,result.nameConflicts,result.sameCountries],[1,1,1]);
  assert.deepEqual(result.groups[0],groups[0]);
  assert.equal(groups.length,1);
  assert.equal(mergeGroups(result.groups,parseBackup(json,allowed)).added,0);
});
