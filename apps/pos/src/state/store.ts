import {
  type AgeCheckRecord, type ApprovalRecord, buildSalePayload, formatReceiptNumber, type PaymentInput, type SalePayload, uuidv7,
} from '@retail/shared';
import { useSyncExternalStore } from 'react';
import { apiRequest, ApiError } from '../api';
import { type Basket, newBasket, priceOf, toSaleInput } from '../logic/basket';
import {
  applyPull, type BranchInfo, type CatalogState, type DeviceInfo, emptyCatalog, type PullResponse, type StaffMember, type StaffTile,
  type TenantHeader, type Till,
} from '../logic/catalog';
import { decodePairingCode, type Pairing } from '../logic/pairing';
import type { PushResponse } from '../logic/queue';
import { SyncQueue } from '../logic/queue';
import type { RefundPayload } from '../logic/refund';
import { kv } from '../storage/kv';
import { createQueueStore } from '../storage/queueStore';
import { secure, sha256Hex } from '../storage/secure';

export interface Hello { tenant: TenantHeader; branch: BranchInfo; device: DeviceInfo; till: Till | null; staff: StaffTile[] }
export interface Session { token: string; staff: StaffMember; startedAt: string; offline: boolean }
export interface TillSessionInfo { id: string; openedAt: string; openingFloatPence: number }
export interface Receipt {
  sale: SalePayload;
  servedBy: string;
  shop: { name: string; legalName: string; address: string[]; vatNumber: string | null };
  tillName: string;
}

export interface AppState {
  booted: boolean;
  pairing: Pairing | null;
  hello: Hello | null;
  catalog: CatalogState;
  session: Session | null;
  locked: boolean;
  tillSession: TillSessionInfo | null;
  training: boolean;
  basket: Basket;
  online: boolean;
  lastSyncAt: string | null;
  syncError: string | null;
  queue: { pending: number; rejected: number };
  lastReceipt: Receipt | null;
  popularity: Record<string, number>;
  voidCounts: Record<string, number>;
  toast: { id: number; text: string; tone: 'success' | 'danger' | 'neutral' } | null;
}

const initial: AppState = {
  booted: false, pairing: null, hello: null, catalog: emptyCatalog(), session: null, locked: false, tillSession: null,
  training: false, basket: newBasket(), online: false, lastSyncAt: null, syncError: null, queue: { pending: 0, rejected: 0 },
  lastReceipt: null, popularity: {}, voidCounts: {}, toast: null,
};

/** Transient flags that are not UI state (e.g. the card terminal is busy: don't auto-lock). */
export const runtime = { cardInProgress: false };

// ------------------------------------------------------------------ store plumbing
let state: AppState = initial;
const listeners = new Set<() => void>();

export function getState(): AppState { return state; }
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
  persist(p);
}
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

/** Which bits of state survive a restart (catalogue, till session, basket, counters). */
const PERSISTED: (keyof AppState)[] = ['hello', 'catalog', 'tillSession', 'training', 'basket', 'lastReceipt', 'popularity', 'voidCounts'];
function persist(p: Partial<AppState>) {
  for (const k of PERSISTED) if (k in p) void kv.set(`state.${k}`, state[k]);
}

export const queue = new SyncQueue(createQueueStore());
queue.onChange(() => { void refreshQueueCounts(); });

async function refreshQueueCounts() {
  setState({ queue: await queue.counts() });
}

let toastSeq = 0;
export function toast(text: string, tone: 'success' | 'danger' | 'neutral' = 'neutral') {
  const id = ++toastSeq;
  setState({ toast: { id, text, tone } });
  setTimeout(() => { if (state.toast?.id === id) setState({ toast: null }); }, 2500);
}

// ------------------------------------------------------------------ API helpers
function base(): string {
  if (!state.pairing) throw new Error('This till is not paired');
  return state.pairing.api;
}

export async function api<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  try {
    const r = await apiRequest<T>(base(), method, path, body, { token: state.session?.token ?? (await syncToken()), ...opts });
    if (!state.online) setState({ online: true });
    return r;
  } catch (err) {
    if (err instanceof ApiError && err.offline && state.online) setState({ online: false });
    if (err instanceof ApiError && err.status === 401 && state.session && !path.startsWith('/v1/auth')) {
      // Token expired: back to the PIN screen; the basket is kept.
      setState({ locked: true });
    }
    throw err;
  }
}

/** The most recent valid staff token, so the queue can sync while the till is locked. */
async function syncToken(): Promise<string | null> {
  return state.session?.token ?? (await secure.get('sync_token'));
}

// ------------------------------------------------------------------ boot & pairing
export async function boot() {
  const raw = await secure.get('pairing');
  const pairing = raw ? (JSON.parse(raw) as Pairing) : null;
  const restored: Partial<AppState> = {};
  for (const k of PERSISTED) {
    const v = await kv.get(`state.${k}`);
    if (v !== null) (restored as Record<string, unknown>)[k] = v;
  }
  state = { ...state, ...restored, pairing, booted: true };
  for (const l of listeners) l();
  await refreshQueueCounts();
  if (pairing) void refreshHello().catch(() => {});
}

export async function pairDevice(code: string): Promise<Hello> {
  const pairing = decodePairingCode(code);
  const hello = await apiRequest<Hello>(pairing.api, 'POST', '/v1/devices/hello',
    { device_id: pairing.device_id, device_secret: pairing.device_secret }, { timeoutMs: 10_000 });
  await secure.set('pairing', JSON.stringify(pairing));
  await bumpSeqFloor(hello.device.last_receipt_seq ?? 0);
  setState({ pairing, hello, online: true, catalog: emptyCatalog(), tillSession: null, basket: newBasket() });
  return hello;
}

export async function unpairDevice() {
  await secure.del('pairing');
  await secure.del('sync_token');
  for (const k of PERSISTED) await kv.del(`state.${k}`);
  state = { ...initial, booted: true };
  for (const l of listeners) l();
}

export async function refreshHello(): Promise<Hello | null> {
  const p = state.pairing;
  if (!p) return null;
  try {
    const hello = await apiRequest<Hello>(p.api, 'POST', '/v1/devices/hello', { device_id: p.device_id, device_secret: p.device_secret }, { timeoutMs: 6000 });
    await bumpSeqFloor(hello.device.last_receipt_seq ?? 0);
    setState({ hello, online: true });
    // Pick up a till session opened elsewhere (or closed in the back office).
    const open = hello.till?.open_session_id ?? null;
    if (open && state.tillSession?.id !== open) setState({ tillSession: { id: open, openedAt: new Date().toISOString(), openingFloatPence: 0 } });
    if (!open && state.tillSession && state.queue.pending === 0) setState({ tillSession: null });
    return hello;
  } catch (err) {
    if (err instanceof ApiError && err.offline) setState({ online: false });
    throw err;
  }
}

// ------------------------------------------------------------------ staff login
const pinKey = (staffId: string) => `pin.${staffId}`;
const verifier = (staffId: string, pin: string) => sha256Hex(`${state.pairing?.device_id}:${staffId}:${pin}`);

export function staffTiles(): StaffTile[] {
  if (state.hello?.staff.length) return state.hello.staff;
  return state.catalog.staff.map((s) => ({ id: s.id, display_name: s.display_name, role_key: s.role_key }));
}

/**
 * PIN login. Online: POST /v1/auth/pin-login, then a pull so the till has the
 * catalogue and this person's permissions. Offline: only staff who have logged
 * in on this till before can unlock (a salted SHA-256 verifier is cached).
 */
export async function login(staffId: string, pin: string): Promise<Session> {
  const p = state.pairing!;
  let token: string | null = null;
  let offline = false;
  try {
    const r = await apiRequest<{ token: string }>(p.api, 'POST', '/v1/auth/pin-login',
      { device_id: p.device_id, device_secret: p.device_secret, staff_id: staffId, pin }, { timeoutMs: 10_000 });
    token = r.token;
    await secure.set(pinKey(staffId), await verifier(staffId, pin));
    await secure.set(`token.${staffId}`, token);
    await secure.set('sync_token', token);
    setState({ online: true });
  } catch (err) {
    if (!(err instanceof ApiError) || !err.offline) throw err;
    const cached = await secure.get(pinKey(staffId));
    if (!cached) throw new Error('Offline: this person has not logged in on this till before, so their PIN cannot be checked.');
    if (cached !== (await verifier(staffId, pin))) throw new Error('PIN is incorrect');
    token = await secure.get(`token.${staffId}`);
    offline = true;
    setState({ online: false });
  }
  const session: Session = { token: token ?? '', staff: placeholderStaff(staffId), startedAt: new Date().toISOString(), offline };
  setState({ session, locked: false });
  if (!offline) {
    try { await pull(true); } catch { /* keep the cached catalogue */ }
  }
  const staff = state.catalog.staff.find((s) => s.id === staffId);
  if (!staff) {
    setState({ session: null });
    throw new Error('Your permissions have not been downloaded to this till yet. Connect to the internet and try again.');
  }
  const full = { ...session, staff };
  setState({ session: full, training: state.training && staff.permissions.includes('pos.training_mode') });
  await adoptOpenTillSession();
  return full;
}

function placeholderStaff(id: string): StaffMember {
  return state.catalog.staff.find((s) => s.id === id) ?? { id, display_name: '', role_key: null, permissions: [], limits: {} };
}

/** Offline-capable PIN check of another person (manager approval). Returns true/false, or null if it cannot be checked here. */
export async function checkPinOffline(staffId: string, pin: string): Promise<boolean | null> {
  const cached = await secure.get(pinKey(staffId));
  if (!cached) return null;
  return cached === (await verifier(staffId, pin));
}

export function lock() { if (state.session) setState({ locked: true }); }
export function logout() { setState({ session: null, locked: false }); }

// ------------------------------------------------------------------ catalogue pull
let lastFullPull = 0;
export async function pull(full = false) {
  const since = !full && state.catalog.serverTime && Date.now() - lastFullPull < 6 * 3600_000 ? state.catalog.serverTime : null;
  const r = await api<PullResponse>('GET', `/v1/sync/pull${since ? `?since=${encodeURIComponent(since)}` : ''}`, undefined, { timeoutMs: 20_000 });
  if (r.full) lastFullPull = Date.now();
  const catalog = applyPull(state.catalog, r);
  const me = state.session ? catalog.staff.find((s) => s.id === state.session!.staff.id) : null;
  setState({ catalog, ...(me && state.session ? { session: { ...state.session, staff: me } } : {}) });
}

// ------------------------------------------------------------------ till session
async function adoptOpenTillSession() {
  const tillId = state.hello?.till?.id;
  const fromPull = state.catalog.tills.find((t) => t.id === tillId)?.open_session_id;
  const open = fromPull ?? state.hello?.till?.open_session_id ?? null;
  if (open && state.tillSession?.id !== open) setState({ tillSession: { id: open, openedAt: new Date().toISOString(), openingFloatPence: 0 } });
}

export async function openTill(openingFloatPence: number): Promise<TillSessionInfo> {
  const tillId = state.hello?.till?.id;
  if (!tillId) throw new Error('No till is linked to this device. Link one in the back office.');
  const id = uuidv7();
  try {
    const s = await api<{ id: string; opened_at: string; opening_float_pence: number }>('POST', '/v1/till-sessions',
      { id, till_id: tillId, opening_float_pence: openingFloatPence });
    const info = { id: s.id, openedAt: s.opened_at, openingFloatPence: s.opening_float_pence };
    setState({ tillSession: info, voidCounts: {} });
    return info;
  } catch (err) {
    const open = (err as ApiError).details as { till_session_id?: string } | undefined;
    if (err instanceof ApiError && err.status === 409 && open?.till_session_id) {
      const info = { id: open.till_session_id, openedAt: new Date().toISOString(), openingFloatPence: 0 };
      setState({ tillSession: info });
      return info;
    }
    throw err;
  }
}

export function clearTillSession() { setState({ tillSession: null, voidCounts: {} }); }

// ------------------------------------------------------------------ receipts & sales
async function bumpSeqFloor(floor: number) {
  const cur = (await kv.get<number>('receipt_seq')) ?? 0;
  if (floor > cur) await kv.set('receipt_seq', floor);
}

async function nextReceiptNumber(): Promise<string> {
  const c = state.catalog;
  const branchCode = c.branch?.code ?? state.hello?.branch.code;
  const deviceNo = c.device?.device_no ?? state.hello?.device.device_no;
  if (!branchCode || !deviceNo) throw new Error('This till has no branch code / device number yet');
  const seq = ((await kv.get<number>('receipt_seq')) ?? 0) + 1;
  await kv.set('receipt_seq', seq);            // persisted BEFORE use: numbers only ever go up
  return formatReceiptNumber(branchCode, deviceNo, seq);
}

export function shopHeader(): Receipt['shop'] {
  const t = state.catalog.tenant ?? state.hello?.tenant;
  const b = state.catalog.branch ?? state.hello?.branch;
  return {
    name: t?.trading_name || t?.legal_name || 'Counter',
    legalName: t?.legal_name ?? '',
    address: [b?.address_line1, b?.address_line2, [b?.city, b?.postcode].filter(Boolean).join(' ')].filter((x): x is string => !!x),
    vatNumber: t?.vat_registered ? t?.vat_number ?? null : null,
  };
}

/**
 * Completes the sale: builds the payload with the shared builder, stores it in
 * the offline queue FIRST (durable), then shows the receipt and tries to sync.
 */
export async function completeSale(payments: PaymentInput[]): Promise<Receipt> {
  const s = state.session;
  if (!s) throw new Error('Nobody is logged in');
  const b = state.basket;
  const receiptNumber = await nextReceiptNumber();
  const completedAt = new Date().toISOString();
  const sale = buildSalePayload(toSaleInput(b, {
    receiptNumber, staffId: s.staff.id, tillSessionId: state.tillSession?.id ?? null, isTraining: state.training, payments, completedAt,
  }));
  await queue.enqueue('sale', sale, receiptNumber);
  const receipt: Receipt = { sale, servedBy: s.staff.display_name, shop: shopHeader(), tillName: state.hello?.till?.name ?? state.catalog.device?.name ?? 'Till' };
  const recent = ((await kv.get<SalePayload[]>('recent_sales')) ?? []).filter((x) => x.id !== sale.id);
  await kv.set('recent_sales', [sale, ...recent].slice(0, 100));
  const popularity = { ...state.popularity };
  if (!state.training) for (const l of sale.lines) if (l.product_id && !l.is_voided) popularity[l.product_id] = (popularity[l.product_id] ?? 0) + 1;
  setState({ lastReceipt: receipt, basket: newBasket(), popularity });
  void syncNow();
  return receipt;
}

/** Cancels the basket as a voided sale (kept for loss prevention, never charged, no stock moves). */
export async function voidSale(voidedBy: string, reason: string, approval?: ApprovalRecord) {
  const s = state.session;
  if (!s) throw new Error('Nobody is logged in');
  const b = state.basket;
  const receiptNumber = await nextReceiptNumber();
  const now = new Date().toISOString();
  const input = toSaleInput(approval ? { ...b, approvals: [...b.approvals, approval] } : b, {
    receiptNumber, staffId: s.staff.id, tillSessionId: state.tillSession?.id ?? null, isTraining: state.training, payments: [], completedAt: now,
  });
  const sale = buildSalePayload({ ...input, status: 'voided', completedAt: null, voidedAt: now, voidedBy, voidReason: reason });
  await queue.enqueue('sale', sale, `${receiptNumber} (voided)`);
  setState({ basket: newBasket() });
  void syncNow();
}

export async function recentSale(receiptNumber: string): Promise<SalePayload | null> {
  return ((await kv.get<SalePayload[]>('recent_sales')) ?? []).find((s) => s.receipt_number === receiptNumber) ?? null;
}

export async function queueRefund(payload: RefundPayload, label: string) {
  await queue.enqueue('refund', payload as unknown as { id: string }, label);
  void syncNow();
}

export function setBasket(fn: (b: Basket) => Basket) {
  setState((s) => ({ basket: fn(s.basket) }));
}

export function basketTotals() { return priceOf(state.basket).totals; }

export function newApproval(partial: Omit<ApprovalRecord, 'id' | 'occurredAt'>): ApprovalRecord {
  return { id: uuidv7(), occurredAt: new Date().toISOString(), ...partial };
}
export function newAgeCheck(partial: Omit<AgeCheckRecord, 'id' | 'occurredAt'>): AgeCheckRecord {
  return { id: uuidv7(), occurredAt: new Date().toISOString(), ...partial };
}

export function countVoid(staffId: string): number {
  const key = `${state.tillSession?.id ?? 'none'}:${staffId}`;
  const n = (state.voidCounts[key] ?? 0) + 1;
  setState({ voidCounts: { ...state.voidCounts, [key]: n } });
  return n;
}
export function voidsSoFar(staffId: string): number {
  return state.voidCounts[`${state.tillSession?.id ?? 'none'}:${staffId}`] ?? 0;
}

// ------------------------------------------------------------------ background sync
export async function syncNow(): Promise<void> {
  if (!state.pairing) return;
  const token = await syncToken();
  if (!token) return;
  const r = await queue.flush((body) => apiRequest<PushResponse>(base(), 'POST', '/v1/sync/push', body, { token, timeoutMs: 20_000 }));
  if (r.failure) {
    const e = r.failure;
    const offline = e instanceof ApiError && e.offline;
    setState({ online: !offline && state.online, syncError: offline ? null : (e as Error).message });
  } else {
    setState({ online: true, lastSyncAt: new Date().toISOString(), syncError: null });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticks = 0;

/** Every ~10 s: check the connection, push the queue; every minute: delta pull. */
export function startBackgroundSync() {
  if (timer) return;
  const tick = async () => {
    if (!state.pairing) return;
    ticks++;
    try {
      await apiRequest(base(), 'GET', '/health', undefined, { timeoutMs: 4000 });
      if (!state.online) setState({ online: true });
    } catch {
      if (state.online) setState({ online: false });
      return;
    }
    await syncNow().catch(() => {});
    if (ticks % 6 === 0) {
      if (state.session && !state.locked) await pull().catch(() => {});
      else await refreshHello().catch(() => {});
    }
  };
  timer = setInterval(() => { void tick(); }, 10_000);
  void tick();
  const w = globalThis as unknown as { addEventListener?: (e: string, f: () => void) => void };
  w.addEventListener?.('online', () => { void tick(); });
  w.addEventListener?.('offline', () => setState({ online: false }));
}
