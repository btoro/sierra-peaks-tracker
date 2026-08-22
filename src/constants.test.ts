import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPS_ACTIVE,
  SPS_SUSPENDED,
  SPS_TOTAL_ROWS,
  PEAKBAGGER_LIST_ID,
  PEAKBAGGER_COMPLETION_CID,
} from './constants.ts';

test('SPS dataset counts are pinned to the frozen contract', () => {
  assert.equal(SPS_ACTIVE, 247);
  assert.equal(SPS_SUSPENDED, 1);
  assert.equal(SPS_TOTAL_ROWS, 248);
});

test('the active dataset is never padded (247, not 273)', () => {
  assert.notEqual(SPS_ACTIVE, 273);
});

test('Peakbagger source identifiers are pinned', () => {
  assert.equal(PEAKBAGGER_LIST_ID, 5051);
  assert.equal(PEAKBAGGER_COMPLETION_CID, 30050);
});
