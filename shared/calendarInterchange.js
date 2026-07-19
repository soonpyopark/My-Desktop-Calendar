import { HOLIDAYS_KR_CALENDAR_ID } from './constants.js';
import { addDaysToDateKey, getEventDurationDays, toDateKey } from './eventOccurrences.js';

/** @typedef {'json' | 'ics' | 'csv'} CalendarFileFormat */

export const CALENDAR_FILE_FORMATS = [
  { value: 'json', label: 'JSON (.json)', extension: 'json', mimeType: 'application/json' },
  { value: 'ics', label: 'ICS (.ics)', extension: 'ics', mimeType: 'text/calendar;charset=utf-8' },
  { value: 'csv', label: 'CSV (.csv)', extension: 'csv', mimeType: 'text/csv;charset=utf-8' },
];

const CSV_HEADERS = [
  'Subject',
  'Start Date',
  'Start Time',
  'End Date',
  'End Time',
  'All Day Event',
  'Description',
  'Location',
  'Calendar',
];

/**
 * @param {CalendarFileFormat} format
 */
export function getCalendarFileFormatMeta(format) {
  const meta = CALENDAR_FILE_FORMATS.find((item) => item.value === format);
  if (!meta) {
    throw new Error(`지원하지 않는 형식입니다: ${format}`);
  }
  return meta;
}

/**
 * @param {string} filename
 * @returns {CalendarFileFormat | null}
 */
export function detectCalendarFileFormat(filename) {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.ics')) return 'ics';
  if (lower.endsWith('.csv')) return 'csv';
  return null;
}

/**
 * @param {string} content
 * @param {string} filename
 * @param {string} mimeType
 */
export function downloadCalendarFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeIcsText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * @param {string} dateKey YYYY-MM-DD
 * @param {string | null | undefined} time HH:mm
 * @param {boolean} allDay
 */
function formatIcsDateTime(dateKey, time, allDay) {
  const compact = dateKey.replace(/-/g, '');
  if (allDay) return compact;
  const [hours = '00', minutes = '00'] = String(time ?? '00:00').split(':');
  return `${compact}T${pad2(hours)}${pad2(minutes)}00`;
}

/**
 * @param {string} dateKey
 */
function addDaysToDateKeyLocal(dateKey, days) {
  return addDaysToDateKey(dateKey, days);
}

/**
 * @param {object} event
 * @returns {string | null}
 */
function buildIcsRRule(event) {
  const repeat = event.repeat ?? 'none';
  if (repeat === 'none') return null;

  /** @type {string[]} */
  const parts = [];
  if (repeat === 'weekdays') {
    parts.push('FREQ=WEEKLY', 'BYDAY=MO,TU,WE,TH,FR');
  } else {
    const freqMap = {
      daily: 'DAILY',
      weekly: 'WEEKLY',
      monthly: 'MONTHLY',
      yearly: 'YEARLY',
    };
    const freq = freqMap[repeat];
    if (!freq) return null;
    parts.push(`FREQ=${freq}`);
  }

  if (event.repeatUntil) {
    parts.push(`UNTIL=${String(event.repeatUntil).replace(/-/g, '')}`);
  } else if (event.repeatCount) {
    parts.push(`COUNT=${Math.floor(Number(event.repeatCount))}`);
  }

  return parts.join(';');
}

/**
 * @param {object} event
 * @param {string} [calendarName]
 */
function buildIcsEventBlock(event, calendarName = '') {
  const allDay = event.allDay !== false;
  const startDate = event.startDate;
  const endDate = event.endDate ?? event.startDate;
  const dtStart = formatIcsDateTime(startDate, event.startTime, allDay);
  const dtEnd = allDay
    ? formatIcsDateTime(addDaysToDateKeyLocal(endDate, 1), null, true)
    : formatIcsDateTime(endDate, event.endTime ?? event.startTime, false);
  const uid = `${event.id ?? `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`}@my-desktop-calendar`;

  /** @type {string[]} */
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatIcsDateTime(toDateKey(new Date()), '00:00', false)}Z`,
    allDay ? `DTSTART;VALUE=DATE:${dtStart}` : `DTSTART:${dtStart}`,
    allDay ? `DTEND;VALUE=DATE:${dtEnd}` : `DTEND:${dtEnd}`,
    `SUMMARY:${escapeIcsText(event.title ?? '(제목 없음)')}`,
  ];

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }
  if (calendarName) {
    lines.push(`CATEGORIES:${escapeIcsText(calendarName)}`);
  }

  const rrule = buildIcsRRule(event);
  if (rrule) {
    lines.push(`RRULE:${rrule}`);
  }

  for (const exdate of event.exdates ?? []) {
    lines.push(`EXDATE;VALUE=DATE:${String(exdate).replace(/-/g, '')}`);
  }

  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

/**
 * @param {object[]} events
 * @param {Map<string, string>} [calendarNamesById]
 */
export function buildIcsDocument(events, calendarNamesById = new Map()) {
  const blocks = events.map((event) =>
    buildIcsEventBlock(event, calendarNamesById.get(event.calendarId) ?? ''),
  );
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//My Desktop Calendar//KO', ...blocks, 'END:VCALENDAR'].join(
    '\r\n',
  );
}

function escapeCsvCell(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * @param {string} dateKey
 */
function formatCsvDate(dateKey) {
  const [year, month, day] = String(dateKey).split('-');
  return `${month}/${day}/${year}`;
}

/**
 * @param {object} event
 * @param {string} [calendarName]
 */
function eventToCsvRow(event, calendarName = '') {
  const allDay = event.allDay !== false;
  return [
    event.title ?? '',
    formatCsvDate(event.startDate),
    allDay ? '' : (event.startTime ?? ''),
    formatCsvDate(event.endDate ?? event.startDate),
    allDay ? '' : (event.endTime ?? ''),
    allDay ? 'True' : 'False',
    event.description ?? '',
    event.location ?? '',
    calendarName,
  ].map(escapeCsvCell).join(',');
}

/**
 * @param {object[]} events
 * @param {Map<string, string>} [calendarNamesById]
 */
export function buildCsvDocument(events, calendarNamesById = new Map()) {
  const rows = events.map((event) =>
    eventToCsvRow(event, calendarNamesById.get(event.calendarId) ?? ''),
  );
  return `\uFEFF${CSV_HEADERS.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

/**
 * @param {object} store
 * @param {CalendarFileFormat} format
 * @param {string} timestamp
 */
export function exportFullStore(store, format, timestamp) {
  if (format === 'json') {
    return {
      content: JSON.stringify(store, null, 2),
      filename: `my-calendar-export-${timestamp}.json`,
      mimeType: getCalendarFileFormatMeta('json').mimeType,
    };
  }

  const calendarNamesById = new Map(
    (store?.calendars ?? []).map((calendar) => [calendar.id, calendar.name ?? '']),
  );
  const events = store?.events ?? [];

  if (format === 'ics') {
    return {
      content: buildIcsDocument(events, calendarNamesById),
      filename: `my-calendar-export-${timestamp}.ics`,
      mimeType: getCalendarFileFormatMeta('ics').mimeType,
    };
  }

  return {
    content: buildCsvDocument(events, calendarNamesById),
    filename: `my-calendar-export-${timestamp}.csv`,
    mimeType: getCalendarFileFormatMeta('csv').mimeType,
  };
}

/**
 * @param {{ calendar: object, events: object[] }} payload
 * @param {CalendarFileFormat} format
 * @param {string} timestamp
 */
export function exportSingleCalendar(payload, format, timestamp) {
  const calendarName = payload.calendar?.name ?? 'calendar';
  const safeName = calendarName.replace(/[\\/:*?"<>|]/g, '_');

  if (format === 'json') {
    return {
      content: JSON.stringify(payload, null, 2),
      filename: `${safeName}-export-${timestamp}.json`,
      mimeType: getCalendarFileFormatMeta('json').mimeType,
    };
  }

  const events = payload.events ?? [];
  const calendarNamesById = new Map([[payload.calendar.id, calendarName]]);

  if (format === 'ics') {
    return {
      content: buildIcsDocument(events, calendarNamesById),
      filename: `${safeName}-export-${timestamp}.ics`,
      mimeType: getCalendarFileFormatMeta('ics').mimeType,
    };
  }

  return {
    content: buildCsvDocument(events, calendarNamesById),
    filename: `${safeName}-export-${timestamp}.csv`,
    mimeType: getCalendarFileFormatMeta('csv').mimeType,
  };
}

/**
 * @param {string} text
 */
function unfoldIcs(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .reduce((acc, line) => {
      if ((line.startsWith(' ') || line.startsWith('\t')) && acc.length) {
        acc[acc.length - 1] += line.slice(1);
      } else {
        acc.push(line);
      }
      return acc;
    }, /** @type {string[]} */ ([]))
    .join('\n');
}

/**
 * @param {string} raw
 */
function parseIcsDateValue(raw) {
  const value = String(raw).trim();
  if (/^\d{8}$/.test(value)) {
    return {
      dateKey: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
      allDay: true,
      time: null,
    };
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!match) {
    throw new Error(`ICS 날짜 형식을 해석할 수 없습니다: ${value}`);
  }
  return {
    dateKey: `${match[1]}-${match[2]}-${match[3]}`,
    allDay: false,
    time: `${match[4]}:${match[5]}`,
  };
}

/**
 * @param {string} rule
 */
function parseIcsRRule(rule) {
  const parts = Object.fromEntries(
    String(rule)
      .split(';')
      .map((segment) => segment.split('='))
      .filter(([key]) => key),
  );

  if (parts.BYDAY === 'MO,TU,WE,TH,FR' && parts.FREQ === 'WEEKLY') {
    return { repeat: 'weekdays', repeatUntil: null, repeatCount: null };
  }

  const freqMap = {
    DAILY: 'daily',
    WEEKLY: 'weekly',
    MONTHLY: 'monthly',
    YEARLY: 'yearly',
  };
  const repeat = freqMap[parts.FREQ] ?? 'none';
  let repeatUntil = null;
  if (parts.UNTIL && /^\d{8}/.test(parts.UNTIL)) {
    repeatUntil = `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`;
  }
  const repeatCount = parts.COUNT ? Math.max(1, Number.parseInt(parts.COUNT, 10) || 1) : null;
  return { repeat, repeatUntil, repeatCount };
}

/**
 * @param {Record<string, string>} props
 * @returns {object}
 */
function mapIcsPropsToEvent(props) {
  const startRaw = props['DTSTART;VALUE=DATE'] ?? props.DTSTART ?? '';
  const endRaw = props['DTEND;VALUE=DATE'] ?? props.DTEND ?? '';
  const start = parseIcsDateValue(startRaw);
  let end = endRaw ? parseIcsDateValue(endRaw) : { ...start };

  if (start.allDay && end.allDay && end.dateKey) {
    end = { ...end, dateKey: addDaysToDateKeyLocal(end.dateKey, -1) };
  }

  const recurrence = props.RRULE ? parseIcsRRule(props.RRULE) : { repeat: 'none', repeatUntil: null, repeatCount: null };
  /** @type {string[]} */
  const exdates = [];
  for (const exdateKey of Object.keys(props)) {
    if (!exdateKey.startsWith('EXDATE')) continue;
    const parsed = parseIcsDateValue(props[exdateKey]);
    if (parsed.dateKey) exdates.push(parsed.dateKey);
  }

  return {
    title: props.SUMMARY ?? '(제목 없음)',
    description: props.DESCRIPTION ?? '',
    location: props.LOCATION ?? '',
    startDate: start.dateKey,
    endDate: end.dateKey ?? start.dateKey,
    allDay: start.allDay,
    startTime: start.allDay ? null : start.time,
    endTime: start.allDay ? null : end.time,
    repeat: recurrence.repeat,
    repeatUntil: recurrence.repeatUntil,
    repeatCount: recurrence.repeatCount,
    exdates,
    calendarLabel: props.CATEGORIES ?? '',
  };
}

/**
 * @param {string} text
 * @returns {object[]}
 */
export function parseIcsEvents(text) {
  const normalized = unfoldIcs(text);
  /** @type {object[]} */
  const events = [];
  const chunks = normalized.split(/BEGIN:VEVENT\r?\n|BEGIN:VEVENT\n/i).slice(1);

  for (const chunk of chunks) {
    const body = chunk.split(/END:VEVENT/i)[0] ?? '';
    /** @type {Record<string, string>} */
    const props = {};
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const index = line.indexOf(':');
      if (index <= 0) continue;
      props[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    events.push(mapIcsPropsToEvent(props));
  }

  return events;
}

/**
 * @param {string} text
 */
function parseCsvDate(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    return `${slash[3]}-${pad2(slash[1])}-${pad2(slash[2])}`;
  }
  return null;
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  /** @type {string[]} */
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

/**
 * @param {string} text
 * @returns {object[]}
 */
export function parseCsvEvents(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  const indexOf = (name) => headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());

  const subjectIdx = indexOf('Subject');
  const startDateIdx = indexOf('Start Date');
  const startTimeIdx = indexOf('Start Time');
  const endDateIdx = indexOf('End Date');
  const endTimeIdx = indexOf('End Time');
  const allDayIdx = indexOf('All Day Event');
  const descriptionIdx = indexOf('Description');
  const locationIdx = indexOf('Location');
  const calendarIdx = indexOf('Calendar');

  /** @type {object[]} */
  const events = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const startDate = parseCsvDate(cells[startDateIdx]);
    if (!startDate) continue;
    const endDate = parseCsvDate(cells[endDateIdx]) ?? startDate;
    const allDayRaw = String(cells[allDayIdx] ?? '').trim().toLowerCase();
    const allDay = allDayRaw === 'true' || allDayRaw === '1' || allDayRaw === 'yes' || allDayRaw === 'y';

    events.push({
      title: cells[subjectIdx]?.trim() || '(제목 없음)',
      description: cells[descriptionIdx]?.trim() ?? '',
      location: cells[locationIdx]?.trim() ?? '',
      startDate,
      endDate,
      allDay,
      startTime: allDay ? null : (cells[startTimeIdx]?.trim() || null),
      endTime: allDay ? null : (cells[endTimeIdx]?.trim() || null),
      repeat: 'none',
      repeatUntil: null,
      repeatCount: null,
      exdates: [],
      calendarLabel: cells[calendarIdx]?.trim() ?? '',
    });
  }

  return events;
}

/**
 * @param {object[]} events
 */
function normalizeImportedEvents(events) {
  return events.map((event) => {
    const allDay = event.allDay !== false;
    const startDate = event.startDate;
    let endDate = event.endDate ?? startDate;
    if (endDate < startDate) {
      endDate = startDate;
    }
    const durationDays = getEventDurationDays({ startDate, endDate });
    return {
      title: String(event.title ?? '').trim() || '(제목 없음)',
      description: String(event.description ?? ''),
      location: String(event.location ?? ''),
      startDate,
      endDate,
      allDay,
      startTime: allDay ? null : event.startTime ?? null,
      endTime: allDay ? null : event.endTime ?? null,
      repeat: event.repeat ?? 'none',
      repeatUntil: event.repeatUntil ?? null,
      repeatCount: event.repeatCount ?? null,
      exdates: Array.isArray(event.exdates) ? event.exdates : [],
      ...(durationDays > 1 ? {} : {}),
    };
  });
}

/**
 * @param {string} text
 * @param {CalendarFileFormat} format
 * @param {string} [sourceName]
 */
export function parseImportPayload(text, format, sourceName = '가져온 캘린더') {
  if (format === 'json') {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') {
      throw new Error('JSON 파일 형식을 확인해 주세요.');
    }
    return { kind: 'json', data };
  }

  const events =
    format === 'ics'
      ? parseIcsEvents(text)
      : parseCsvEvents(text);

  if (!events.length) {
    throw new Error('가져올 일정이 없습니다.');
  }

  const calendarLabel = events.find((event) => event.calendarLabel)?.calendarLabel;
  const calendarName = calendarLabel || sourceName.replace(/\.(json|ics|csv)$/i, '') || '가져온 캘린더';

  return {
    kind: 'merge-calendar',
    data: {
      calendar: {
        name: calendarName,
        description: '',
        color: null,
        visible: true,
        custom: true,
      },
      events: normalizeImportedEvents(events),
    },
  };
}

/**
 * Pull event rows out of a parsed import file for "import into this calendar".
 * @param {{ kind: string, data: object }} parsed
 * @returns {object[]}
 */
export function extractEventsFromImportPayload(parsed) {
  if (!parsed?.data) return [];
  if (parsed.kind === 'merge-calendar') {
    return Array.isArray(parsed.data.events) ? parsed.data.events : [];
  }

  const data = parsed.data;
  if (!Array.isArray(data.events)) return [];

  // Single-calendar export: { calendar, events }
  if (data.calendar && typeof data.calendar === 'object' && !Array.isArray(data.calendars)) {
    const calId = data.calendar.id;
    return data.events.filter(
      (event) =>
        event
        && event.calendarId !== HOLIDAYS_KR_CALENDAR_ID
        && (!calId || !event.calendarId || event.calendarId === calId),
    );
  }

  // Full store export — all non-holiday events (caller assigns target calendarId).
  return data.events.filter(
    (event) => event && event.calendarId !== HOLIDAYS_KR_CALENDAR_ID,
  );
}
