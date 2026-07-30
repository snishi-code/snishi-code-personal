/*
 * React から store を読む hook（useSyncExternalStore の薄いラッパ）。
 */
import { useSyncExternalStore } from 'react';
import { getState, subscribe, type StoreState } from '../data/store';

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getState, getState);
}
