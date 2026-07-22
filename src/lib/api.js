import { isNativeHost, nativeRequest, onNativeEvent } from './nativeHost.js';
import { eventToMutationPayload } from './eventHistory.js';

const API_BASE = '';

function getAuthHeaders() {
  try {
    const token =
      localStorage.getItem('my-calendar-auth-token')
      ?? sessionStorage.getItem('my-calendar-auth-token');
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  } catch {
    return {};
  }
}

function parseBody(options = {}) {
  if (options.body == null || options.body === '') return null;
  if (typeof options.body === 'string') {
    try {
      return JSON.parse(options.body);
    } catch {
      return null;
    }
  }
  return options.body;
}

async function request(path, options = {}) {
  if (isNativeHost()) {
    const method = options.method ?? 'GET';
    return nativeRequest(method, path, parseBody(options));
  }

  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...(options.headers ?? {}),
    },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  const contentType = res.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error('API 서버에 연결할 수 없습니다. My Desktop Calendar가 실행 중인지 확인해 주세요.');
  }
  return res.json();
}

export async function fetchStore() {
  return request('/api/store');
}

export async function createEvent(payload) {
  const body = eventToMutationPayload(payload ?? {});
  return request('/api/events', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateEvent(id, payload) {
  // Partial patches must not invent defaults (e.g. repeat: "none") that wipe fields
  // on the existing event — MergeObjects on the store overwrites with those defaults.
  const body = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (key === 'id' || value === undefined) continue;
    body[key] = value;
  }
  return request(`/api/events/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteEvent(id) {
  return request(`/api/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Native file-picker attach (desktop WebView only). Returns updated event. */
export async function addEventAttachments(eventId) {
  return request(`/api/events/${encodeURIComponent(eventId)}/attachments`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function removeEventAttachment(eventId, attachmentId) {
  return request(
    `/api/events/${encodeURIComponent(eventId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' },
  );
}

export async function openEventAttachment(eventId, attachmentId) {
  return request(
    `/api/events/${encodeURIComponent(eventId)}/attachments/${encodeURIComponent(attachmentId)}/open`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export async function createCalendar(payload) {
  return request('/api/calendars', { method: 'POST', body: JSON.stringify(payload) });
}

export async function patchSettings(payload) {
  return request('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function importStore(payload) {
  return request('/api/store/import', { method: 'POST', body: JSON.stringify(payload) });
}

/** Desktop only: SaveFileDialog → ZIP (store.json + attachments/). */
export async function exportBackupZip() {
  return request('/api/store/export-backup-zip', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** Desktop only: OpenFileDialog → restore store + attachment files. */
export async function importBackupZip() {
  return request('/api/store/import-backup-zip', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function patchCalendar(id, payload) {
  return request(`/api/calendars/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function deleteCalendar(id) {
  return request(`/api/calendars/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function clearCalendarEvents(calendarId) {
  return request(`/api/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'DELETE' });
}

export async function createTag(payload) {
  return request('/api/tags', { method: 'POST', body: JSON.stringify(payload) });
}

export async function patchTag(id, payload) {
  return request(`/api/tags/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function deleteTag(id) {
  return request(`/api/tags/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Import events into an existing calendar (append).
 * @param {string} calendarId
 * @param {{ events: object[] }} payload
 */
export async function importIntoCalendar(calendarId, payload) {
  return request(`/api/calendars/${encodeURIComponent(calendarId)}/import`, {
    method: 'POST',
    body: JSON.stringify(payload ?? {}),
  });
}

/** @returns {Promise<{ members: object[] }>} */
export async function listMembers() {
  return request('/api/members');
}

/**
 * Batch create/update/delete members (NAS4USB-compatible payload).
 * @param {{ members: object[] }} payload
 * @returns {Promise<{ ok: boolean, members: object[] }>}
 */
export async function saveMembers(payload) {
  return request('/api/members', { method: 'PUT', body: JSON.stringify(payload) });
}

export async function fetchSyncInfo() {
  return request('/api/sync-info');
}

/**
 * Sync Korean public holidays into holidays-kr.
 * @param {{ years?: number[] }} [payload]
 */
export async function syncKoreanHolidays(payload = {}) {
  return request('/api/holidays/sync', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * @param {URLSearchParams} params
 */
export async function fetchExport(params) {
  if (isNativeHost()) {
    const year = Number(params.get('year'));
    const month = Number(params.get('month'));
    const scope = params.get('scope') === 'year' ? 'year' : 'month';
    const format = params.get('format');
    if (format !== 'excel' && format !== 'pdf') {
      throw new Error('유효하지 않은 내보내기 형식입니다.');
    }

    const store = await fetchStore();
    const period = scope === 'year'
      ? { scope: 'year', year }
      : { scope: 'month', year, month };
    const {
      buildExcelBuffer,
      buildPdfBuffer,
      getExcelExportFileName,
      getPdfExportFileName,
    } = await import('./calendarExport.js');

    const buffer = format === 'excel'
      ? await buildExcelBuffer(store, period, { asAdmin: false })
      : await buildPdfBuffer(store, period, { asAdmin: false });
    const fileName = format === 'excel'
      ? getExcelExportFileName(period)
      : getPdfExportFileName(period);
    const contentType = format === 'excel'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/pdf';

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
    });
  }

  return fetch(`${API_BASE}/api/export?${params.toString()}`, {
    headers: getAuthHeaders(),
  });
}

export function connectSync(onMessage) {
  if (isNativeHost()) {
    const unsubscribe = onNativeEvent((data) => {
      if (data?.type === 'store-updated' || data?.type === 'store-changed') {
        onMessage(data);
      }
    });
    return {
      close() {
        unsubscribe();
      },
    };
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

  ws.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch {
      /* ignore */
    }
  };

  ws.onclose = () => {
    setTimeout(() => connectSync(onMessage), 3000);
  };

  return ws;
}
