import type { OutboxItem, StoredHazardEvent, UnitState } from '../m2/types';

// Wire protocol between the ring client and a storage unit (HTTP/JSON under /u).
export type UnitRow = StoredHazardEvent & { tombstone?: true; merged_into?: string };
export interface UnitDocEntry { key: string; doc: unknown; version: number; deleted?: true }
export interface UnitCtx { fence: number; fenceName: string }
export interface UnitOutboxSpec { mode: 'on_create' | 'on_apply' | 'never'; priority?: 'critical' | 'normal'; correlation_id: string }
export interface UnitIdentity { unit: string; node: string; state: UnitState }
export interface UnitDump { rows: UnitRow[]; docs: Array<UnitDocEntry & { collection: string }>; fences: Record<string, number> }
export interface UnitStats { keys: number; writes_total: number }
export type UnitOutboxItem = OutboxItem;
