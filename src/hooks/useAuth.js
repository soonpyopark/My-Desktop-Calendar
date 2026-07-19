import { useCallback, useEffect, useState } from 'react';
import { isNativeHost, nativeRequest, onNativeEvent } from '../lib/nativeHost.js';

const AUTH_STORAGE_KEY = 'my-calendar-auth-user';
const AUTH_TOKEN_STORAGE_KEY = 'my-calendar-auth-token';
const AUTH_REMEMBER_KEY = 'my-calendar-auth-remember';
const AUTH_ROLE_KEY = 'my-calendar-auth-role';
const AUTH_SUPER_KEY = 'my-calendar-auth-super';

/**
 * @param {string} key
 */
function readAuthItem(key) {
  try {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 */
function removeAuthItem(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * @param {boolean} rememberMe
 * @param {string} username
 * @param {string | null} token
 * @param {{ role?: string | null, isSuperAdmin?: boolean, updatePreference?: boolean }} [options]
 */
function writeAuthSession(rememberMe, username, token, options = {}) {
  const updatePreference = options.updatePreference !== false;
  const primary = rememberMe ? localStorage : sessionStorage;
  const secondary = rememberMe ? sessionStorage : localStorage;
  const role = options.role ?? 'member';
  const isSuper = options.isSuperAdmin === true || role === 'super_admin';
  try {
    primary.setItem(AUTH_STORAGE_KEY, username);
    primary.setItem(AUTH_ROLE_KEY, role);
    primary.setItem(AUTH_SUPER_KEY, isSuper ? '1' : '0');
    if (token) {
      primary.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    } else {
      primary.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
    if (updatePreference) {
      localStorage.setItem(AUTH_REMEMBER_KEY, rememberMe ? '1' : '0');
    }
  } catch {
    /* ignore */
  }
  try {
    secondary.removeItem(AUTH_STORAGE_KEY);
    secondary.removeItem(AUTH_TOKEN_STORAGE_KEY);
    secondary.removeItem(AUTH_ROLE_KEY);
    secondary.removeItem(AUTH_SUPER_KEY);
  } catch {
    /* ignore */
  }
}

function clearAuthSession() {
  removeAuthItem(AUTH_STORAGE_KEY);
  removeAuthItem(AUTH_TOKEN_STORAGE_KEY);
  removeAuthItem(AUTH_ROLE_KEY);
  removeAuthItem(AUTH_SUPER_KEY);
}

export function getAdminAuthToken() {
  return readAuthItem(AUTH_TOKEN_STORAGE_KEY);
}

export function getRememberMePreference() {
  try {
    const stored = localStorage.getItem(AUTH_REMEMBER_KEY);
    if (stored === null) return true;
    return stored === '1';
  } catch {
    return true;
  }
}

/**
 * @param {{ authenticated?: boolean, username?: string|null, loginId?: string|null, token?: string|null, remember?: boolean, role?: string|null, isSuperAdmin?: boolean, admin?: boolean }} body
 * @param {(user: string|null) => void} setUser
 * @param {(role: string|null) => void} setRole
 * @param {(value: boolean) => void} setIsSuperAdmin
 */
function applyAuthPayload(body, setUser, setRole, setIsSuperAdmin) {
  if (body?.authenticated && body?.token) {
    const username = body.loginId || body.username || 'admin';
    const role = body.role === 'super_admin' || body.isSuperAdmin || body.admin ? 'super_admin' : (body.role || 'member');
    const isSuper = role === 'super_admin' || body.isSuperAdmin === true || body.admin === true;
    writeAuthSession(Boolean(body.remember), username, body.token, {
      role,
      isSuperAdmin: isSuper,
      updatePreference: false,
    });
    setUser(username);
    setRole(role);
    setIsSuperAdmin(isSuper);
    return;
  }
  if (body && body.authenticated === false) {
    clearAuthSession();
    setUser(null);
    setRole(null);
    setIsSuperAdmin(false);
  }
}

function readStoredRole() {
  const role = readAuthItem(AUTH_ROLE_KEY);
  return role === 'super_admin' ? 'super_admin' : role === 'member' ? 'member' : null;
}

function readStoredIsSuper() {
  return readAuthItem(AUTH_SUPER_KEY) === '1' || readStoredRole() === 'super_admin';
}

export function useAuth() {
  const [user, setUser] = useState(() => {
    try {
      const storedUser = readAuthItem(AUTH_STORAGE_KEY);
      const storedToken = readAuthItem(AUTH_TOKEN_STORAGE_KEY);
      if (storedUser && storedToken) return storedUser;
      if (storedUser) removeAuthItem(AUTH_STORAGE_KEY);
      return null;
    } catch {
      return null;
    }
  });
  const [role, setRole] = useState(() => (readAuthItem(AUTH_TOKEN_STORAGE_KEY) ? readStoredRole() : null));
  const [isSuperAdmin, setIsSuperAdmin] = useState(() =>
    (readAuthItem(AUTH_TOKEN_STORAGE_KEY) ? readStoredIsSuper() : false),
  );
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    if (!isNativeHost()) return undefined;
    return onNativeEvent((data) => {
      if (!data || data.type !== 'auth-changed') return;
      applyAuthPayload(data, setUser, setRole, setIsSuperAdmin);
    });
  }, []);

  useEffect(() => {
    if (!isNativeHost()) return undefined;

    let cancelled = false;
    void (async () => {
      try {
        const body = await nativeRequest('GET', '/api/auth/session');
        if (cancelled) return;
        if (body?.authenticated && body?.token) {
          applyAuthPayload(body, setUser, setRole, setIsSuperAdmin);
          return;
        }
        if (body && body.authenticated === false && getAdminAuthToken()) {
          clearAuthSession();
          setUser(null);
          setRole(null);
          setIsSuperAdmin(false);
        }
      } catch {
        /* keep optimistic session while offline/starting */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const token = getAdminAuthToken();
    if (!token || !user) return;

    let cancelled = false;
    void (async () => {
      try {
        if (isNativeHost()) {
          const body = await nativeRequest('GET', '/api/auth/session');
          if (cancelled) return;
          if (!body?.authenticated) {
            clearAuthSession();
            setUser(null);
            setRole(null);
            setIsSuperAdmin(false);
          } else {
            applyAuthPayload({ ...body, token: body.token || token }, setUser, setRole, setIsSuperAdmin);
          }
          return;
        }
        const response = await fetch('/api/auth/session', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!response.ok) {
          clearAuthSession();
          setUser(null);
          setRole(null);
          setIsSuperAdmin(false);
          return;
        }
        const body = await response.json().catch(() => ({}));
        if (body?.authenticated) {
          applyAuthPayload({ ...body, token: body.token || token }, setUser, setRole, setIsSuperAdmin);
        }
      } catch {
        /* keep optimistic session while offline/starting */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const login = useCallback(async (id, password, rememberMe = true) => {
    setLoggingIn(true);
    try {
      if (isNativeHost()) {
        const body = await nativeRequest('POST', '/api/auth/login', {
          id,
          password,
          persistent: Boolean(rememberMe),
          remember: Boolean(rememberMe),
        });
        const username = body.loginId ?? body.username ?? id;
        const token = body.token ?? null;
        const nextRole = body.role === 'super_admin' || body.isSuperAdmin || body.admin
          ? 'super_admin'
          : 'member';
        const isSuper = nextRole === 'super_admin';
        writeAuthSession(Boolean(rememberMe), username, token, {
          role: nextRole,
          isSuperAdmin: isSuper,
        });
        setUser(username);
        setRole(nextRole);
        setIsSuperAdmin(isSuper);
        return username;
      }

      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, password, rememberMe: Boolean(rememberMe) }),
      });
      const contentType = response.headers.get('Content-Type') ?? '';
      const body = contentType.includes('application/json')
        ? await response.json().catch(() => ({}))
        : {};
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('로그인 API를 사용할 수 없습니다. 앱을 완전히 종료한 뒤 다시 실행해 주세요.');
        }
        throw new Error(body.error ?? '로그인에 실패했습니다.');
      }
      const username = body.loginId ?? body.username ?? id;
      const token = body.token ?? null;
      const nextRole = body.role === 'super_admin' || body.isSuperAdmin || body.admin
        ? 'super_admin'
        : 'member';
      const isSuper = nextRole === 'super_admin';
      writeAuthSession(Boolean(rememberMe), username, token, {
        role: nextRole,
        isSuperAdmin: isSuper,
      });
      setUser(username);
      setRole(nextRole);
      setIsSuperAdmin(isSuper);
      return username;
    } finally {
      setLoggingIn(false);
    }
  }, []);

  const logout = useCallback(() => {
    const token = getAdminAuthToken();
    clearAuthSession();
    setUser(null);
    setRole(null);
    setIsSuperAdmin(false);
    if (!token) return;
    if (isNativeHost()) {
      void nativeRequest('POST', '/api/auth/logout').catch(() => {});
      return;
    }
    void fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }, []);

  return {
    user,
    role,
    isSuperAdmin,
    isLoggedIn: Boolean(user),
    loggingIn,
    login,
    logout,
  };
}
