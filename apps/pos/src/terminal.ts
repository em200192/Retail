/**
 * Card terminal adapter (CLAUDE.md: PaymentTerminalAdapter — Dojo / SumUp /
 * Stripe Terminal later). Only the mock exists today: it "waits for the card"
 * and approves, so the whole payment flow is testable end to end.
 */
import { t } from './i18n';
export interface TerminalResult {
  status: 'approved' | 'declined';
  provider: string;
  providerTxnRef: string;
  cardBrand: string | null;
  cardLast4: string | null;
  authCode: string | null;
  message?: string;
}

export interface PaymentTerminalAdapter {
  readonly name: string;
  charge(amountPence: number, opts?: { signal?: AbortSignal }): Promise<TerminalResult>;
}

export class MockTerminal implements PaymentTerminalAdapter {
  readonly name = 'mock';
  constructor(private delayMs = 1800) {}

  charge(amountPence: number, opts: { signal?: AbortSignal } = {}): Promise<TerminalResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const rnd = (n: number) => Math.floor(Math.random() * n);
        resolve({
          status: 'approved',
          provider: 'mock',
          providerTxnRef: `mock_${Date.now().toString(36)}_${amountPence}`,
          cardBrand: ['visa', 'mastercard', 'amex'][rnd(3)]!,
          cardLast4: String(1000 + rnd(9000)),
          authCode: String(100000 + rnd(900000)),
        });
      }, this.delayMs);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error(t('error.cardCancelled')));
      });
    });
  }
}

export const terminal: PaymentTerminalAdapter = new MockTerminal();
