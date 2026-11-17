const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Store only the opaque server session, never login credentials. */
export function createSessionStore({persistent, temporary, key = 'emoteclub.session.v1', now = Date.now}) {
  function session(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const {token, expiresAt} = value;
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    if (typeof expiresAt !== 'string' || !ISO_DATE.test(expiresAt)) return null;
    const expires = Date.parse(expiresAt);
    const current = now();
    if (!Number.isFinite(expires) || !Number.isFinite(current) || expires <= current) return null;
    return {token, expiresAt};
  }

  function clearBoth() {
    let cleared = true;
    for (const storage of [temporary, persistent]) {
      try { storage.removeItem(key); } catch { cleared = false; }
    }
    return cleared;
  }

  function readFrom(storage) {
    let raw;
    try { raw = storage.getItem(key); } catch { return null; }
    if (raw == null) return null;
    let value = null;
    try { value = session(JSON.parse(raw)); } catch { /* Invalid stored data is discarded. */ }
    if (!value) {
      try { storage.removeItem(key); } catch { /* Storage can be unavailable. */ }
    }
    return value;
  }

  return {
    read() {
      const temporarySession = readFrom(temporary);
      const persistentSession = readFrom(persistent);
      return temporarySession || persistentSession;
    },
    save(value, remember) {
      // Clear both locations so changing this preference cannot leave a stale copy.
      if (!clearBoth()) return false;
      try {
        const clean = session(value);
        if (!clean) return false;
        (remember === true ? persistent : temporary).setItem(key, JSON.stringify(clean));
        return true;
      } catch { return false; }
    },
    clear() { clearBoth(); },
  };
}
