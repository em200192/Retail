import { Platform, type TextStyle, type ViewStyle } from 'react-native';

/** Counter design tokens — shared with the web back-office. */
export const color = {
  primary: '#0B6E69',
  primaryPressed: '#095854',
  primaryTint: '#E6F2F1',
  ink: '#0F172A',
  muted: '#475569',
  border: '#E2E8F0',
  surface: '#F7F8FA',
  card: '#FFFFFF',
  accent: '#F2A900',
  accentInk: '#0F172A',
  success: '#16794C',
  successTint: '#E8F3EE',
  warning: '#B45309',
  warningTint: '#FDF3E7',
  danger: '#C62828',
  dangerTint: '#FBEAEA',
  focus: '#FFDD00',
  overlay: 'rgba(15, 23, 42, 0.55)',
} as const;

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const touch = { min: 48, till: 64 } as const;

export const font = {
  family: Platform.select({
    web: 'Inter, "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif',
    default: undefined,
  }),
};

export const money: TextStyle = { fontVariant: ['tabular-nums'], fontWeight: '700', color: color.ink };

export const shadow: ViewStyle = Platform.select<ViewStyle>({
  web: { boxShadow: '0 1px 2px rgba(15,23,42,0.06), 0 4px 12px rgba(15,23,42,0.05)' } as ViewStyle,
  default: { shadowColor: '#0F172A', shadowOpacity: 0.08, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
})!;

export const shadowLg: ViewStyle = Platform.select<ViewStyle>({
  web: { boxShadow: '0 12px 40px rgba(15,23,42,0.22)' } as ViewStyle,
  default: { shadowColor: '#0F172A', shadowOpacity: 0.2, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8 },
})!;

/** Web-only global CSS: GOV.UK-style focus ring, font smoothing, no tap highlight. */
export const WEB_CSS = `
  html, body, #root { height: 100%; background: ${color.surface}; }
  body { margin: 0; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  * { -webkit-tap-highlight-color: transparent; }
  [role="button"]:focus, a:focus, input:focus, textarea:focus, [tabindex]:focus { outline: none; }
  [role="button"]:focus-visible, [role="tab"]:focus-visible, [role="switch"]:focus-visible, [role="radio"]:focus-visible,
  [role="checkbox"]:focus-visible, a:focus-visible, [tabindex]:focus-visible {
    outline: 3px solid ${color.focus} !important; outline-offset: 0;
    box-shadow: inset 0 0 0 2px ${color.ink} !important;
  }
  input:focus-visible, textarea:focus-visible {
    outline: 3px solid ${color.focus} !important; outline-offset: 0;
    box-shadow: inset 0 0 0 2px ${color.ink} !important;
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
