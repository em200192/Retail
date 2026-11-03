import { describe, expect, it } from 'vitest';
import { ar } from '../src/i18n/ar';
import {
  arabicPlural, interpolate, isLang, isolateLtr, LANGS, LANGUAGES, placeholders, translate, translatePlural,
} from '../src/i18n/core';
import { en } from '../src/i18n/en';

const FSI = '⁨';
const LRI = '⁦';
const PDI = '⁩';
const strip = (s: string) => s.replace(/[⁦-⁩]/g, '');

describe('translate', () => {
  it('returns English and fills placeholders', () => {
    expect(translate('en', 'sell.payAmount', { amount: '£3.20' })).toBe('Pay £3.20');
    expect(translate('en', 'login.pinFor', { name: 'Sam' })).toBe('PIN for Sam');
  });

  it('returns Arabic, isolating inserted values so £ amounts and receipt numbers stay left-to-right', () => {
    expect(translate('ar', 'sell.payAmount', { amount: '£3.20' })).toBe(`الدفع ${FSI}£3.20${PDI}`);
    expect(strip(translate('ar', 'receipt.number', { number: 'MAN1-1-1083' }))).toBe('إيصال MAN1-1-1083');
  });

  it('falls back to English when an Arabic key is missing', () => {
    expect(ar['vat.short.S']).toBeUndefined();
    expect(translate('ar', 'vat.short.S')).toBe('20%');
    // English fallback text is not wrapped in isolates
    expect(translate('ar', 'sell.added', { name: 'Milk', amount: '£1.00' })).toContain('Milk');
  });

  it('leaves unknown placeholders alone and ignores extra variables', () => {
    expect(interpolate('Hi {name} {missing}', { name: 'Mo', extra: 1 }, 'en')).toBe('Hi Mo {missing}');
    expect(interpolate('No vars', undefined, 'ar')).toBe('No vars');
    expect(translate('en', 'z.voided', { sales: 2, lines: 0 })).toBe('Voided sales (2) · lines (0)');
  });

  it('uses Western digits (0-9) in Arabic', () => {
    for (const [key, value] of Object.entries(ar)) {
      expect(value, key).not.toMatch(/[٠-٩۰-۹]/); // Western digits only
    }
  });
});

describe('plurals', () => {
  it('uses one/other in English', () => {
    expect(translatePlural('en', 'sell.items', 1)).toBe('1 item');
    expect(translatePlural('en', 'sell.items', 3)).toBe('3 items');
    expect(translatePlural('en', 'sell.items', 0)).toBe('0 items');
    expect(translatePlural('en', 'sell.items', 1.5, { count: '1.5' })).toBe('1.5 items');
  });

  it('follows the CLDR Arabic rules', () => {
    expect([0, 1, 2, 3, 10, 11, 99, 100, 101, 102, 103, 111, 1.5].map(arabicPlural)).toEqual(
      ['zero', 'one', 'two', 'few', 'few', 'many', 'many', 'other', 'other', 'other', 'few', 'many', 'other']);
    expect(translatePlural('ar', 'sell.items', 1)).toBe('صنف واحد');
    expect(translatePlural('ar', 'sell.items', 2)).toBe('صنفان');
    expect(strip(translatePlural('ar', 'sell.items', 5))).toBe('5 أصناف');
    expect(strip(translatePlural('ar', 'sell.items', 12))).toBe('12 صنفًا');
    expect(strip(translatePlural('ar', 'sell.items', 100))).toBe('100 صنف');
  });

  it('falls back to .other in the same language, then to English', () => {
    expect(strip(translatePlural('ar', 'sync.attempts', 1))).toBe('المحاولات: 1'); // Arabic has only .other
    expect(strip(translatePlural('ar', 'sell.matches', 0))).toBe('0 نتيجة');       // no .zero -> .other
  });
});

describe('dictionaries', () => {
  const enKeys = new Set(Object.keys(en));
  const base = (k: string) => k.replace(/\.(zero|one|two|few|many|other)$/, '');

  it('every Arabic key exists in English (or is an extra plural form of one)', () => {
    for (const k of Object.keys(ar)) expect(enKeys.has(k) || enKeys.has(`${base(k)}.other`), k).toBe(true);
  });

  it('Arabic uses the same placeholders as English', () => {
    for (const [k, v] of Object.entries(ar)) {
      const plural = !enKeys.has(k) || /\.(one|other)$/.test(k) && enKeys.has(`${base(k)}.other`) && enKeys.has(`${base(k)}.one`);
      const source = (en as Record<string, string>)[k] ?? (en as Record<string, string>)[`${base(k)}.other`]!;
      const want = placeholders(source);
      const got = placeholders(v!);
      if (plural) {
        // a plural form may spell the number out ("صنف واحد") but must not invent new placeholders
        for (const p of got) expect(want, `${k}: {${p}}`).toContain(p);
        for (const p of want.filter((x) => x !== 'count')) expect(got, `${k}: missing {${p}}`).toContain(p);
      } else {
        expect(got, k).toEqual(want);
      }
    }
  });

  it('has no empty Arabic strings, and covers almost every English key', () => {
    for (const [k, v] of Object.entries(ar)) expect(v!.trim().length, k).toBeGreaterThan(0);
    const missing = [...enKeys].filter((k) => !(k in ar) && !/\.one$/.test(k) && !/^vat\.short\.[SRZ]$/.test(k) && en[k as keyof typeof en] !== '');
    expect(missing).toEqual([]);
  });

  it('keeps the agreed UK retail terms', () => {
    expect(ar['menu.cashUp']).toBe('تسوية الصندوق');
    expect(ar['openTill.float']).toBe('الرصيد الافتتاحي');
    expect(ar['menu.training']).toBe('وضع التدريب');
    expect(ar['approval.title']).toBe('موافقة المدير');
    expect(ar['tile.priceMarked']).toBe('سعر مطبوع على العبوة');
    expect(ar['c25.title']).toContain('Challenge 25');
    expect(ar['vat.line']).toContain('ضريبة القيمة المضافة (VAT)');
    expect(ar['line.void']).toBe('إلغاء');
    expect(ar['menu.refund']).toBe('استرداد');
  });
});

describe('current language', () => {
  it('t() follows the chosen language and device-made errors are translated', async () => {
    const { getLang, setCurrentLang, t, tn } = await import('../src/i18n/current');
    const { decodePairingCode } = await import('../src/logic/pairing');
    expect(getLang()).toBe('en');
    expect(() => decodePairingCode('')).toThrow('Paste the pairing code from the back office');
    setCurrentLang('ar');
    try {
      expect(t('topbar.menu')).toBe('القائمة');
      expect(strip(tn('status.issues', 3))).toBe('3 مشكلات مزامنة');
      expect(() => decodePairingCode('not a code')).toThrow('هذا لا يبدو رمز ربط صحيحًا');
    } finally {
      setCurrentLang('en');
    }
  });
});

describe('languages', () => {
  it('registers English and Arabic with direction and date locale', () => {
    expect(LANGS).toEqual(['en', 'ar']);
    expect(LANGUAGES.ar.dir).toBe('rtl');
    expect(LANGUAGES.en.dir).toBe('ltr');
    expect(LANGUAGES.ar.dateLocale).toBe('ar-GB-u-nu-latn');
    expect(isLang('ar')).toBe(true);
    expect(isLang('fr')).toBe(false);
    expect(isLang('toString')).toBe(false);
  });

  it('isolates LTR values only in RTL languages', () => {
    expect(isolateLtr('−£1.20', 'en')).toBe('−£1.20');
    expect(isolateLtr('−£1.20', 'ar')).toBe(`${LRI}−£1.20${PDI}`);
  });
});
