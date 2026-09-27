import { useEffect, useState } from 'react';
import i18n from '../i18n';

/**
 * Loads an image that lives behind bearer-token auth.
 *
 * `<img src>` cannot send an Authorization header, so we fetch the bytes with
 * the token from localStorage ('token'), turn them into an object URL and hand
 * that to the <img>. The object URL is revoked whenever the URL changes, on
 * unmount, and on each refresh tick.
 *
 * @param {string|null} url         image URL (null/undefined disables the fetch)
 * @param {object} [options]
 * @param {boolean} [options.enabled=true]
 * @param {number}  [options.refreshMs=0]  re-fetch on an interval (0 = never)
 * @returns {{ src: string|null, loading: boolean, error: string|null, reload: () => void }}
 */
export function useAuthedImage(url, { enabled = true, refreshMs = 0 } = {}) {
  const [src, setSrc] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!refreshMs || refreshMs <= 0) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  useEffect(() => {
    if (!url || !enabled) {
      setSrc(null);
      setError(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    let objectUrl = null;
    const controller = new AbortController();

    let token = null;
    try { token = localStorage.getItem('token'); } catch { /* storage unavailable */ }

    setLoading(true);
    setError(null);

    fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const j = await res.json();
            msg = j.message || j.error || msg;
          } catch { /* not JSON */ }
          throw new Error(msg);
        }
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setSrc(null);
        setError(err.message || i18n.t('cameras:snapshot.loadFailed'));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, enabled, tick]);

  const reload = () => setTick((t) => t + 1);

  return { src, loading, error, reload };
}

export default useAuthedImage;
