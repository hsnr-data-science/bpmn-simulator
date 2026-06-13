import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addWorkingTime,
  hoursToRanges,
  nextResourceAvailability,
  parseHourRanges,
  parseWeekdays,
  rangesToHours,
  serializeHourRanges,
  serializeWeekdays
} from '../../src/simulation/ResourceCalendar';
import type { ResourceConfig } from '../../src/types/simulation';

test('ResourceCalendar parses weekdays and hourly ranges', () => {
  assert.deepEqual(parseWeekdays('Mo-Fr,So'), [1, 2, 3, 4, 5, 7]);
  assert.deepEqual(parseHourRanges('08:00-12:00, 13-17'), [
    { start: 8, end: 12 },
    { start: 13, end: 17 }
  ]);
  assert.deepEqual(hoursToRanges([8, 9, 10, 13, 14]), [
    { start: 8, end: 11 },
    { start: 13, end: 15 }
  ]);
  assert.deepEqual(rangesToHours([{ start: 22, end: 24 }]), [22, 23]);
  assert.equal(serializeWeekdays([1, 2, 3]), '1,2,3');
  assert.equal(serializeHourRanges([{ start: 8, end: 11 }]), '8-11');
});

test('ResourceCalendar finds availability and adds working time over calendar gaps', () => {
  const calendar: ResourceConfig = {
    weekdays: [1, 2, 3, 4, 5],
    hourRanges: [{ start: 8, end: 10 }]
  };

  assert.equal(nextResourceAvailability(calendar, 7), 8);
  assert.equal(nextResourceAvailability(calendar, 10), 32);
  assert.equal(addWorkingTime(8, 3, calendar), 33);
});
