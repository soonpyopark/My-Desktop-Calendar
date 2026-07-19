import assert from 'node:assert/strict';
import {
  addExdate,
  buildFollowingSeriesEvent,
  buildSingleExceptionEvent,
  expandEventsForRange,
  getSeriesId,
  listOccurrenceStarts,
  truncateSeriesBefore,
} from '../shared/eventOccurrences.js';

function event(partial) {
  return {
    id: 'series-1',
    title: '테스트',
    allDay: true,
    startDate: '2026-07-01',
    endDate: '2026-07-01',
    repeat: 'none',
    ...partial,
  };
}

{
  const starts = listOccurrenceStarts(event({ repeat: 'daily', startDate: '2026-07-01' }), '2026-07-01', '2026-07-03');
  assert.deepEqual(starts, ['2026-07-01', '2026-07-02', '2026-07-03']);
}

{
  const starts = listOccurrenceStarts(
    event({ repeat: 'weekly', startDate: '2026-07-01' }),
    '2026-07-01',
    '2026-07-22',
  );
  assert.deepEqual(starts, ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22']);
}

{
  const starts = listOccurrenceStarts(
    event({ repeat: 'weekdays', startDate: '2026-07-01' }),
    '2026-07-01',
    '2026-07-07',
  );
  assert.deepEqual(starts, ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07']);
}

{
  const starts = listOccurrenceStarts(
    event({ repeat: 'monthly', startDate: '2026-01-31' }),
    '2026-01-01',
    '2026-03-31',
  );
  assert.deepEqual(starts, ['2026-01-31', '2026-02-28', '2026-03-31']);
}

{
  const starts = listOccurrenceStarts(
    event({ repeat: 'yearly', startDate: '2024-02-29' }),
    '2024-01-01',
    '2026-12-31',
  );
  assert.deepEqual(starts, ['2024-02-29', '2025-02-28', '2026-02-28']);
}

{
  // 2026-07-12 solar = lunar 2026-05-28
  const starts = listOccurrenceStarts(
    event({ repeat: 'lunar-yearly', startDate: '2026-07-12' }),
    '2026-01-01',
    '2028-12-31',
  );
  assert.deepEqual(starts, ['2026-07-12', '2027-07-02', '2028-06-20']);
}

{
  const starts = listOccurrenceStarts(
    event({ repeat: 'lunar-monthly', startDate: '2026-07-12', repeatCount: 3 }),
    '2026-07-01',
    '2027-12-31',
  );
  assert.equal(starts.length, 3);
  assert.equal(starts[0], '2026-07-12');
  assert.ok(starts[1] > starts[0]);
  assert.ok(starts[2] > starts[1]);
}

{
  const starts = listOccurrenceStarts(
    event({ repeat: 'daily', startDate: '2026-07-01', repeatUntil: '2026-07-03' }),
    '2026-07-01',
    '2026-07-10',
  );
  assert.deepEqual(starts, ['2026-07-01', '2026-07-02', '2026-07-03']);
}

{
  const starts = listOccurrenceStarts(
    event({ repeat: 'daily', startDate: '2026-07-01', repeatCount: 3 }),
    '2026-07-01',
    '2026-07-10',
  );
  assert.deepEqual(starts, ['2026-07-01', '2026-07-02', '2026-07-03']);
}

{
  const starts = listOccurrenceStarts(
    event({ repeat: 'daily', startDate: '2026-07-01', exdates: ['2026-07-02'] }),
    '2026-07-01',
    '2026-07-03',
  );
  assert.deepEqual(starts, ['2026-07-01', '2026-07-03']);
}

{
  const expanded = expandEventsForRange(
    [event({ repeat: 'daily', startDate: '2026-07-10', endDate: '2026-07-11' })],
    '2026-07-12',
    '2026-07-12',
  );
  assert.equal(expanded.length, 2);
  assert.deepEqual(
    expanded.map((item) => item.startDate),
    ['2026-07-11', '2026-07-12'],
  );
  assert.equal(getSeriesId(expanded[0]), 'series-1');
}

{
  const none = expandEventsForRange(
    [event({ repeat: 'none', startDate: '2026-07-01', endDate: '2026-07-02' })],
    '2026-07-02',
    '2026-07-02',
  );
  assert.equal(none.length, 1);
  assert.equal(none[0].id, 'series-1');
  assert.equal(none[0].isOccurrence, false);
}

{
  const master = event({ repeat: 'daily', startDate: '2026-07-01' });
  const withEx = addExdate(master, '2026-07-03');
  assert.deepEqual(withEx.exdates, ['2026-07-03']);
  const truncated = truncateSeriesBefore(master, '2026-07-05');
  assert.equal(truncated.repeatUntil, '2026-07-04');
  const exception = buildSingleExceptionEvent(master, { title: '예외' }, '2026-07-03');
  assert.equal(exception.repeat, 'none');
  assert.equal(exception.title, '예외');
  assert.equal(exception.startDate, '2026-07-03');
  const following = buildFollowingSeriesEvent(master, { title: '이후', repeat: 'weekly' }, '2026-07-08');
  assert.equal(following.repeat, 'weekly');
  assert.equal(following.startDate, '2026-07-08');
}

console.log('eventOccurrences: all checks passed');
