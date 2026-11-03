/**
 * Integration adapter interfaces (CLAUDE.md "Integrations — design now").
 * Real implementations (Uber Eats, Deliveroo, Xero, Dojo ...) plug in here
 * later; the mock adapters let the full flows run end-to-end today.
 */

export interface ParsedWebhookEvent {
  eventId: string;
  externalStoreId: string | null;
  type: 'order.created' | 'order.cancelled' | 'order.updated' | 'other';
  payload: unknown;
}

export interface CatalogItem { productId: string; externalItemId: string | null; name: string; pricePence: number; vatCode: string }
export interface StockChange { productId: string; externalItemId: string | null; available: number }

export interface DeliveryChannelAdapter {
  readonly provider: 'uber_eats' | 'deliveroo' | 'just_eat' | 'snappy_shopper' | 'own_store';
  pushCatalog(connection: ConnectionRef, items: CatalogItem[]): Promise<void>;
  pushStock(connection: ConnectionRef, changes: StockChange[]): Promise<void>;
  acceptOrder(connection: ConnectionRef, externalId: string): Promise<void>;
  updateOrderStatus(connection: ConnectionRef, externalId: string, status: string): Promise<void>;
  /** MUST verify the signature before returning anything. Throws on bad signature. */
  parseWebhook(req: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): ParsedWebhookEvent;
}

export interface ConnectionRef {
  tenantId: string;
  connectionId: string;
  externalStoreId: string | null;
  /** Pointer into the secrets manager — the token itself never touches the DB. */
  credentialsSecretRef: string | null;
  config: Record<string, unknown>;
}

export interface AccountingAdapter {
  readonly provider: 'xero' | 'quickbooks' | 'sage';
  pushDailySales(connection: ConnectionRef, summary: { date: string; netPence: number; vatPence: number; byPaymentMethod: Record<string, number> }): Promise<string>;
  pushExpense(connection: ConnectionRef, expense: { id: string; netPence: number; vatPence: number; accountCode: string | null; date: string; description: string }): Promise<string>;
}

export interface PaymentTerminalAdapter {
  readonly provider: 'dojo' | 'sumup' | 'stripe_terminal' | 'square';
  startPayment(connection: ConnectionRef, req: { amountPence: number; reference: string }): Promise<{ providerTxnRef: string }>;
  getPayment(connection: ConnectionRef, providerTxnRef: string): Promise<{ status: 'pending' | 'approved' | 'declined'; cardBrand?: string; last4?: string; authCode?: string }>;
  refund(connection: ConnectionRef, providerTxnRef: string, amountPence: number): Promise<void>;
}

export interface PayrollExportAdapter {
  readonly target: 'xero' | 'brightpay' | 'sage' | 'quickbooks' | 'csv';
  export(lines: { staffId: string; employeeNumber: string | null; regularHours: number; overtimeHours: number; holidayHours: number; grossPayPence: number }[]): Promise<Buffer>;
}

export interface MessageChannelAdapter {
  readonly channel: 'email' | 'push' | 'sms' | 'whatsapp';
  send(msg: { to: string; subject: string | null; templateCode: string; payload: Record<string, unknown>; locale: string }): Promise<{ providerMessageId: string }>;
}

// ------------------------------------------------------------------ mocks

/** Records calls in memory; used until partner API access is approved. */
export class MockDeliveryAdapter implements DeliveryChannelAdapter {
  readonly calls: { method: string; args: unknown[] }[] = [];
  constructor(readonly provider: DeliveryChannelAdapter['provider'] = 'uber_eats') {}
  async pushCatalog(c: ConnectionRef, items: CatalogItem[]) { this.calls.push({ method: 'pushCatalog', args: [c.connectionId, items] }); }
  async pushStock(c: ConnectionRef, changes: StockChange[]) { this.calls.push({ method: 'pushStock', args: [c.connectionId, changes] }); }
  async acceptOrder(c: ConnectionRef, id: string) { this.calls.push({ method: 'acceptOrder', args: [c.connectionId, id] }); }
  async updateOrderStatus(c: ConnectionRef, id: string, s: string) { this.calls.push({ method: 'updateOrderStatus', args: [c.connectionId, id, s] }); }
  parseWebhook(req: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer }): ParsedWebhookEvent {
    const body = JSON.parse(req.rawBody.toString());
    return { eventId: String(body.event_id), externalStoreId: body.store_id ?? null, type: body.type ?? 'other', payload: body };
  }
}

/** Dev email: logs instead of sending. Swap for Resend/Postmark in production. */
export class LogEmailAdapter implements MessageChannelAdapter {
  readonly channel = 'email' as const;
  readonly sent: { to: string; subject: string | null; templateCode: string }[] = [];
  async send(msg: { to: string; subject: string | null; templateCode: string }) {
    this.sent.push({ to: msg.to, subject: msg.subject, templateCode: msg.templateCode });
    return { providerMessageId: `log-${this.sent.length}` };
  }
}
