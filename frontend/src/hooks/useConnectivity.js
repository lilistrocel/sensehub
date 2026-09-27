import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '../utils/connectivity';

/**
 * Live connectivity snapshot: { status: 'ok'|'offline'|'reconnecting'|'down', online, hidden, lastOkAt, ... }.
 * See utils/connectivity.js.
 */
export function useConnectivity() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export default useConnectivity;
