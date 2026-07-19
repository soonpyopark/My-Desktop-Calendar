import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connectSync,
  createCalendar,
  createEvent,
  createTag,
  clearCalendarEvents as clearCalendarEventsApi,
  deleteCalendar,
  deleteEvent,
  deleteTag,
  fetchStore,
  importIntoCalendar,
  importStore,
  patchCalendar,
  patchSettings,
  patchTag,
  syncKoreanHolidays,
  updateEvent,
} from '../lib/api.js';
import {
  clearOfflineQueue,
  drainOfflineQueue,
  enqueueOfflineAction,
  loadOfflineSnapshot,
  saveOfflineSnapshot,
} from '../lib/offlineStore.js';
import { calendarToPatch, eventToMutationPayload } from '../lib/eventHistory.js';
import { isNativeHost, onNativeEvent } from '../lib/nativeHost.js';
import { useHistoryStack } from './useHistoryStack.js';
import { DEFAULT_CALENDARS, DEFAULT_HOLIDAYS_KR_SETTINGS, DEFAULT_SETTINGS, DEFAULT_VIEW_OPTIONS } from '../../shared/constants.js';
import { sortTags } from '../../shared/eventTags.js';

function mergeSettings(current, patch) {
  const notifications = {
    ...DEFAULT_SETTINGS.notifications,
    ...current?.notifications,
    ...(patch.notifications ?? {}),
  };
  if (notifications.enabled === 'email') {
    notifications.enabled = 'none';
  }
  const holidaysKr = {
    ...DEFAULT_HOLIDAYS_KR_SETTINGS,
    ...current?.holidaysKr,
    ...(patch.holidaysKr ?? {}),
  };
  holidaysKr.serviceKey = String(holidaysKr.serviceKey ?? '').trim();
  holidaysKr.rememberKey = Boolean(holidaysKr.rememberKey) && Boolean(holidaysKr.serviceKey);
  if (!holidaysKr.rememberKey) {
    holidaysKr.serviceKey = '';
  }
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    ...patch,
    notifications,
    viewOptions: {
      ...DEFAULT_VIEW_OPTIONS,
      ...current?.viewOptions,
      ...(patch.viewOptions ?? {}),
    },
    widget: {
      ...DEFAULT_SETTINGS.widget,
      ...current?.widget,
      ...(patch.widget ?? {}),
    },
    holidaysKr,
    dayColors: patch.dayColors !== undefined
      ? { ...(patch.dayColors ?? {}) }
      : { ...(current?.dayColors ?? {}) },
    allowedIpCidrs: patch.allowedIpCidrs !== undefined
      ? [...(patch.allowedIpCidrs ?? [])]
      : [...(current?.allowedIpCidrs ?? [])],
  };
}

function sortCalendars(calendars) {
  const order = new Map(DEFAULT_CALENDARS.map((calendar, index) => [calendar.id, index]));
  return [...calendars].sort((a, b) => {
    const aOrder = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bOrder = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ko');
  });
}

function mergeCreatedCalendar(current, created) {
  return {
    ...current,
    calendars: sortCalendars([...current.calendars.filter((calendar) => calendar.id !== created.id), created]),
    updatedAt: new Date().toISOString(),
  };
}

function mergePatchedCalendar(current, patched) {
  return {
    ...current,
    calendars: current.calendars.map((calendar) => (calendar.id === patched.id ? patched : calendar)),
    updatedAt: new Date().toISOString(),
  };
}

function mergeDeletedCalendar(current, id) {
  return {
    ...current,
    calendars: (current.calendars ?? []).filter((calendar) => calendar.id !== id),
    events: (current.events ?? []).filter((event) => event.calendarId !== id),
    updatedAt: new Date().toISOString(),
  };
}

function mergeClearedCalendarEvents(current, calendarId) {
  return {
    ...current,
    events: (current.events ?? []).filter((event) => event.calendarId !== calendarId),
    updatedAt: new Date().toISOString(),
  };
}

function mergeCreatedTag(current, created) {
  if (!created?.id) return current;
  return {
    ...current,
    tags: sortTags([...(current.tags ?? []).filter((tag) => tag.id !== created.id), created]),
    updatedAt: new Date().toISOString(),
  };
}

function mergePatchedTag(current, patched) {
  if (!patched?.id) return current;
  return {
    ...current,
    tags: sortTags((current.tags ?? []).map((tag) => (tag.id === patched.id ? patched : tag))),
    updatedAt: new Date().toISOString(),
  };
}

function mergeDeletedTag(current, id) {
  return {
    ...current,
    tags: (current.tags ?? []).filter((tag) => tag.id !== id),
    events: (current.events ?? []).map((event) => ({
      ...event,
      tagIds: Array.isArray(event.tagIds) ? event.tagIds.filter((tagId) => tagId !== id) : [],
    })),
    updatedAt: new Date().toISOString(),
  };
}

function isOfflineRequestError(err) {
  // Native shell talks to the local store over the WebView bridge, not the OS network.
  // WebView2 often reports navigator.onLine === false even when the app works.
  if (!isNativeHost() && !navigator.onLine) return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    message.includes('API 서버')
    || message.includes('Failed to fetch')
    || message.includes('NetworkError')
    || message.includes('Load failed')
    || message.includes('Native bridge timeout')
    || message.includes('Native host unavailable')
    || message.includes('Native bridge error')
  );
}

function mergeCreatedEvent(current, created) {
  if (!created?.id) return current;
  return {
    ...current,
    events: [...(current.events ?? []).filter((event) => event.id !== created.id), created],
    updatedAt: created.updatedAt ?? new Date().toISOString(),
  };
}

function mergeUpdatedEvent(current, updated) {
  if (!updated?.id) return current;
  return {
    ...current,
    events: (current.events ?? []).map((event) => (event.id === updated.id ? updated : event)),
    updatedAt: updated.updatedAt ?? new Date().toISOString(),
  };
}

function mergeDeletedEvent(current, id) {
  return {
    ...current,
    events: (current.events ?? []).filter((event) => event.id !== id),
    updatedAt: new Date().toISOString(),
  };
}

export function useCalendarData() {
  const [store, setStore] = useState(null);
  // Native host: badge = local store reachability, not OS network / navigator.onLine.
  const [online, setOnline] = useState(() => (isNativeHost() ? true : navigator.onLine));
  const [loading, setLoading] = useState(true);
  const [syncInfo, setSyncInfo] = useState(null);
  const history = useHistoryStack();
  const suppressHistoryRef = useRef(false);
  const storeRef = useRef(store);
  const skipRemoteRefreshUntilRef = useRef(0);
  storeRef.current = store;

  const withoutHistory = useCallback(async (fn) => {
    suppressHistoryRef.current = true;
    try {
      return await fn();
    } finally {
      suppressHistoryRef.current = false;
    }
  }, []);

  const recordHistory = useCallback(
    (entry) => {
      if (!suppressHistoryRef.current) history.push(entry);
    },
    [history],
  );

  const applyStore = useCallback(async (nextStore) => {
    setStore(nextStore);
    try {
      await saveOfflineSnapshot(nextStore);
    } catch {
      /* IndexedDB cache is best-effort; do not fail the mutation */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const remote = await fetchStore();
      await applyStore(remote);
      setOnline(true);
    } catch {
      const cached = await loadOfflineSnapshot();
      if (cached) setStore(cached);
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }, [applyStore]);

  const flushQueue = useCallback(async () => {
    const queue = await drainOfflineQueue();
    if (!queue.length) return;

    for (const item of queue) {
      if (item.type === 'create-event') await createEvent(item.payload);
      if (item.type === 'update-event') await updateEvent(item.id, item.payload);
      if (item.type === 'delete-event') await deleteEvent(item.id);
      if (item.type === 'patch-calendar') await patchCalendar(item.id, item.payload);
      if (item.type === 'delete-calendar') await deleteCalendar(item.id);
      if (item.type === 'clear-calendar-events') await clearCalendarEventsApi(item.id);
      if (item.type === 'create-calendar') await createCalendar(item.payload);
      if (item.type === 'import-store') await importStore(item.payload);
      if (item.type === 'patch-settings') await patchSettings(item.payload);
    }
    await clearOfflineQueue();
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();

    const native = isNativeHost();
    const onOnline = () => {
      setOnline(true);
      void flushQueue().then(refresh);
    };
    // Browser-only: OS "offline" must not flip the badge in the WPF shell.
    const onOffline = () => {
      if (!native) setOnline(false);
    };

    if (!native) {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
    }

    const ws = connectSync((msg) => {
      if (msg.type !== 'store-changed' && msg.type !== 'store-updated') {
        return;
      }
      if (Date.now() < skipRemoteRefreshUntilRef.current) return;

      // Native host already includes a store snapshot on store-updated.
      if (msg.type === 'store-updated' && msg.store && typeof msg.store === 'object') {
        void applyStore(msg.store);
        setOnline(true);
        return;
      }

      void refresh();
    });

    if (window.myCalendar?.getSyncInfo) {
      void window.myCalendar.getSyncInfo().then(setSyncInfo);
    }

    const onServerModeChanged = () => {
      if (window.myCalendar?.getSyncInfo) {
        void window.myCalendar.getSyncInfo().then(setSyncInfo);
      }
    };
    window.addEventListener('mycalendar:serverModeChanged', onServerModeChanged);

    const unsubscribeNativeServer = onNativeEvent((data) => {
      if (data?.type === 'server-mode-changed') {
        onServerModeChanged();
      }
    });

    // Keep "브라우저에서 편집" in sync (tray Start/Stop, Host surface).
    const syncPollId = window.setInterval(onServerModeChanged, 5000);

    return () => {
      if (!native) {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
      window.removeEventListener('mycalendar:serverModeChanged', onServerModeChanged);
      unsubscribeNativeServer?.();
      window.clearInterval(syncPollId);
      ws.close();
    };
  }, [applyStore, flushQueue, refresh]);

  const runOrQueue = useCallback(
    async (type, fn, queuePayload, mergeStore) => {
      let succeeded = false;
      let result;
      try {
        result = await fn();
        succeeded = true;
        setOnline(true);
        if (mergeStore && storeRef.current) {
          await applyStore(mergeStore(storeRef.current, result));
          skipRemoteRefreshUntilRef.current = Date.now() + 1000;
        } else {
          // Mutation already succeeded — a follow-up refresh failure must not look like "offline".
          try {
            await refresh();
          } catch {
            /* store-updated / local merge is enough */
          }
        }
        return result;
      } catch (err) {
        if (succeeded) {
          return result;
        }
        if (!isOfflineRequestError(err)) {
          throw err instanceof Error ? err : new Error(String(err ?? '요청에 실패했습니다.'));
        }

        await enqueueOfflineAction({ type, ...queuePayload });
        setOnline(false);
        if (store && type === 'create-event') {
          const calendars = store.calendars ?? [];
          const requestedId = queuePayload.payload?.calendarId;
          const calendarId =
            calendars.find((calendar) => calendar.id === requestedId)?.id
            ?? calendars.find((calendar) => calendar.visible !== false)?.id
            ?? calendars[0]?.id
            ?? requestedId
            ?? 'primary';
          const optimistic = {
            ...queuePayload.payload,
            calendarId,
            id: `offline-${Date.now()}`,
            updatedAt: new Date().toISOString(),
          };
          await applyStore({ ...store, events: [...store.events, optimistic] });
          return optimistic;
        }
        if (store && type === 'create-calendar') {
          const optimistic = {
            ...queuePayload.payload,
            id: `offline-${Date.now()}`,
            dataKey: `offline-${Date.now()}`,
            visible: queuePayload.payload?.visible ?? true,
            custom: queuePayload.payload?.custom ?? true,
          };
          await applyStore(mergeCreatedCalendar(store, optimistic));
          return optimistic;
        }
        throw new Error('오프라인 상태입니다. 변경 사항은 연결 후 동기화됩니다.');
      }
    },
    [applyStore, refresh, store],
  );

  const performCreateEvent = useCallback(
    (payload) =>
      runOrQueue(
        'create-event',
        () => createEvent(payload),
        { payload },
        mergeCreatedEvent,
      ),
    [runOrQueue],
  );

  const performUpdateEvent = useCallback(
    (id, payload) =>
      runOrQueue(
        'update-event',
        () => updateEvent(id, payload),
        { id, payload },
        mergeUpdatedEvent,
      ),
    [runOrQueue],
  );

  const performDeleteEvent = useCallback(
    (id) =>
      runOrQueue(
        'delete-event',
        async () => {
          await deleteEvent(id);
          return id;
        },
        { id },
        (current, deletedId) => mergeDeletedEvent(current, deletedId),
      ),
    [runOrQueue],
  );

  const performPatchCalendar = useCallback(
    (id, payload) =>
      runOrQueue(
        'patch-calendar',
        () => patchCalendar(id, payload),
        { id, payload },
        mergePatchedCalendar,
      ),
    [runOrQueue],
  );

  const addEvent = useCallback(
    async (payload) => {
      const created = await performCreateEvent(payload);
      if (!created?.id) return created;

      const createPayload = eventToMutationPayload(created);
      const state = { eventId: created.id };

      recordHistory({
        undo: async () => {
          await withoutHistory(() => performDeleteEvent(state.eventId));
        },
        redo: async () => {
          const next = await withoutHistory(() => performCreateEvent(createPayload));
          if (next?.id) state.eventId = next.id;
        },
      });

      return created;
    },
    [performCreateEvent, performDeleteEvent, recordHistory, withoutHistory],
  );

  const editEvent = useCallback(
    async (id, payload) => {
      const previous = storeRef.current?.events?.find((event) => event.id === id);
      const result = await performUpdateEvent(id, payload);
      if (!previous) return result;

      const beforePatch = eventToMutationPayload(previous);
      recordHistory({
        undo: async () => {
          await withoutHistory(() => performUpdateEvent(id, beforePatch));
        },
        redo: async () => {
          await withoutHistory(() => performUpdateEvent(id, payload));
        },
      });

      return result;
    },
    [performUpdateEvent, recordHistory, withoutHistory],
  );

  const removeEvent = useCallback(
    async (id) => {
      const previous = storeRef.current?.events?.find((event) => event.id === id);
      await performDeleteEvent(id);
      if (!previous) return;

      const createPayload = eventToMutationPayload(previous);
      const state = { eventId: id };

      recordHistory({
        undo: async () => {
          const restored = await withoutHistory(() => performCreateEvent(createPayload));
          if (restored?.id) state.eventId = restored.id;
        },
        redo: async () => {
          await withoutHistory(() => performDeleteEvent(state.eventId));
        },
      });
    },
    [performCreateEvent, performDeleteEvent, recordHistory, withoutHistory],
  );

  const toggleCalendar = useCallback(
    async (id, visible) => {
      if (store) {
        await applyStore({
          ...store,
          calendars: store.calendars.map((c) =>
            c.id === id ? { ...c, visible } : c,
          ),
        });
      }

      try {
        await patchCalendar(id, { visible });
        await refresh();
      } catch {
        await enqueueOfflineAction({ type: 'patch-calendar', id, payload: { visible } });
      }
    },
    [applyStore, refresh, store],
  );

  const addCalendar = useCallback(
    (payload) =>
      runOrQueue(
        'create-calendar',
        () => createCalendar(payload),
        { payload },
        mergeCreatedCalendar,
      ),
    [runOrQueue],
  );

  const editCalendar = useCallback(
    async (id, payload) => {
      const previous = storeRef.current?.calendars?.find((calendar) => calendar.id === id);
      const result = await performPatchCalendar(id, payload);
      if (!previous) return result;

      const beforePatch = calendarToPatch(previous);
      recordHistory({
        undo: async () => {
          await withoutHistory(() => performPatchCalendar(id, beforePatch));
        },
        redo: async () => {
          await withoutHistory(() => performPatchCalendar(id, payload));
        },
      });

      return result;
    },
    [performPatchCalendar, recordHistory, withoutHistory],
  );

  const removeCalendar = useCallback(
    async (id) => {
      try {
        await deleteCalendar(id);
        if (storeRef.current) {
          await applyStore(mergeDeletedCalendar(storeRef.current, id));
          skipRemoteRefreshUntilRef.current = Date.now() + 1000;
        }
      } catch {
        await enqueueOfflineAction({ type: 'delete-calendar', id });
        if (store) {
          await applyStore(mergeDeletedCalendar(store, id));
        }
      }
    },
    [applyStore, store],
  );

  const clearCalendarEvents = useCallback(
    async (id) => {
      try {
        await clearCalendarEventsApi(id);
      } catch (err) {
        if (isOfflineRequestError(err) && storeRef.current) {
          try {
            await enqueueOfflineAction({ type: 'clear-calendar-events', id });
          } catch {
            /* queue is best-effort while offline */
          }
          await applyStore(mergeClearedCalendarEvents(storeRef.current, id));
          skipRemoteRefreshUntilRef.current = Date.now() + 1000;
          throw new Error('오프라인 상태입니다. 변경 사항은 연결 후 동기화됩니다.');
        }
        throw err instanceof Error ? err : new Error('캘린더를 초기화하지 못했습니다.');
      }

      if (storeRef.current) {
        await applyStore(mergeClearedCalendarEvents(storeRef.current, id));
        skipRemoteRefreshUntilRef.current = Date.now() + 1000;
      }
    },
    [applyStore],
  );

  const addTag = useCallback(
    async (payload) => {
      const created = await createTag(payload);
      if (storeRef.current) {
        await applyStore(mergeCreatedTag(storeRef.current, created));
        skipRemoteRefreshUntilRef.current = Date.now() + 1000;
      }
      return created;
    },
    [applyStore],
  );

  const editTag = useCallback(
    async (id, payload) => {
      const patched = await patchTag(id, payload);
      if (storeRef.current) {
        await applyStore(mergePatchedTag(storeRef.current, patched));
        skipRemoteRefreshUntilRef.current = Date.now() + 1000;
      }
      return patched;
    },
    [applyStore],
  );

  const removeTag = useCallback(
    async (id) => {
      await deleteTag(id);
      if (storeRef.current) {
        await applyStore(mergeDeletedTag(storeRef.current, id));
        skipRemoteRefreshUntilRef.current = Date.now() + 1000;
      }
    },
    [applyStore],
  );

  const replaceStore = useCallback(
    async (payload) => {
      const result = await runOrQueue('import-store', () => importStore(payload), { payload });
      history.clear();
      return result;
    },
    [history, runOrQueue],
  );

  const importEventsIntoCalendar = useCallback(
    async (calendarId, events) => {
      const result = await importIntoCalendar(calendarId, { events });
      if (result?.store) {
        await applyStore(result.store);
        skipRemoteRefreshUntilRef.current = Date.now() + 1000;
      } else {
        await refresh();
      }
      return result;
    },
    [applyStore, refresh],
  );

  const updateSettings = useCallback(
    async (payload) => {
      if (store) {
        await applyStore({
          ...store,
          settings: mergeSettings(store.settings, payload),
        });
      }
      return runOrQueue('patch-settings', () => patchSettings(payload), { payload });
    },
    [applyStore, runOrQueue, store],
  );

  const syncHolidays = useCallback(async (payload = {}) => {
    const result = await syncKoreanHolidays(payload);
    await refresh();
    return result;
  }, [refresh]);

  return {
    store,
    loading,
    online,
    syncInfo,
    refresh,
    addEvent,
    editEvent,
    removeEvent,
    toggleCalendar,
    addCalendar,
    editCalendar,
    removeCalendar,
    clearCalendarEvents,
    importEventsIntoCalendar,
    addTag,
    editTag,
    removeTag,
    replaceStore,
    updateSettings,
    syncHolidays,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    clearHistory: history.clear,
  };
}
