import { type ReactNode, useEffect, useRef } from 'react';
import {
  type AccessibilityRole, Modal, Platform, Pressable, ScrollView, type StyleProp, StyleSheet, Text, type TextProps, TextInput,
  type TextInputProps, type TextStyle, View, type ViewStyle,
} from 'react-native';
import { color, font, radius, shadow, shadowLg, space, touch } from './theme';

// ------------------------------------------------------------------ text
type Variant = 'display' | 'title' | 'h2' | 'h3' | 'body' | 'label' | 'small' | 'caption';
const textStyles: Record<Variant, TextStyle> = {
  display: { fontSize: 40, fontWeight: '800', letterSpacing: -0.5 },
  title: { fontSize: 26, fontWeight: '700', letterSpacing: -0.3 },
  h2: { fontSize: 20, fontWeight: '700' },
  h3: { fontSize: 17, fontWeight: '600' },
  body: { fontSize: 16 },
  label: { fontSize: 15, fontWeight: '600' },
  small: { fontSize: 14 },
  caption: { fontSize: 12, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' },
};

export function T({ v = 'body', muted, tone, style, ...rest }: TextProps & { v?: Variant; muted?: boolean; tone?: string }) {
  return <Text {...rest} style={[{ color: tone ?? (muted ? color.muted : color.ink), fontFamily: font.family }, textStyles[v], style]} />;
}

export function Money({ pence, size = 16, style, tone }: { pence: string; size?: number; style?: StyleProp<TextStyle>; tone?: string }) {
  return (
    <Text style={[{ fontFamily: font.family, fontVariant: ['tabular-nums'], fontWeight: '700', fontSize: size, color: tone ?? color.ink }, style]}>
      {pence}
    </Text>
  );
}

// ------------------------------------------------------------------ button
type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'success';
const kinds: Record<ButtonKind, { bg: string; bgPressed: string; fg: string; border: string }> = {
  primary: { bg: color.primary, bgPressed: color.primaryPressed, fg: '#FFFFFF', border: color.primary },
  secondary: { bg: color.card, bgPressed: color.primaryTint, fg: color.ink, border: color.border },
  ghost: { bg: 'transparent', bgPressed: color.primaryTint, fg: color.primary, border: 'transparent' },
  danger: { bg: color.card, bgPressed: color.dangerTint, fg: color.danger, border: '#E9B4B4' },
  accent: { bg: color.accent, bgPressed: '#D99700', fg: color.accentInk, border: color.accent },
  success: { bg: color.success, bgPressed: '#11603C', fg: '#FFFFFF', border: color.success },
};

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  kind?: ButtonKind;
  size?: 'md' | 'lg' | 'xl';
  disabled?: boolean;
  icon?: string;
  hint?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  sub?: string;
  role?: AccessibilityRole;
  selected?: boolean;
}

export function Button({ label, onPress, kind = 'primary', size = 'md', disabled, icon, hint, accessibilityLabel, style, testID, sub, role = 'button', selected }: ButtonProps) {
  const k = kinds[kind];
  const h = size === 'xl' ? 76 : size === 'lg' ? touch.till : touch.min;
  const fs = size === 'xl' ? 22 : size === 'lg' ? 18 : 16;
  return (
    <Pressable
      testID={testID}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled, selected }}
      style={({ pressed }) => [
        styles.btn,
        { minHeight: h, backgroundColor: pressed ? k.bgPressed : k.bg, borderColor: k.border },
        kind === 'secondary' && !disabled ? shadow : null,
        disabled && styles.btnDisabled,
        style,
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        {icon ? <Text style={{ color: k.fg, fontSize: fs + 2, fontFamily: font.family }} aria-hidden>{icon}</Text> : null}
        <Text style={{ color: k.fg, fontSize: fs, fontWeight: '700', fontFamily: font.family, textAlign: 'center' }}>{label}</Text>
      </View>
      {sub ? <Text style={{ color: k.fg, opacity: 0.85, fontSize: 13, marginTop: 2, fontFamily: font.family }}>{sub}</Text> : null}
    </Pressable>
  );
}

// ------------------------------------------------------------------ layout
export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  return <View style={[styles.card, padded && { padding: space.lg }, style]}>{children}</View>;
}

export function Row({ children, gap = space.sm, style, wrap }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle>; wrap?: boolean }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: wrap ? 'wrap' : 'nowrap' }, style]}>{children}</View>;
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: 1, backgroundColor: color.border, marginVertical: space.sm }, style]} />;
}

// ------------------------------------------------------------------ status
type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'accent';
const tones: Record<Tone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: '#F1F5F9', fg: color.muted, border: color.border },
  primary: { bg: color.primaryTint, fg: color.primary, border: '#B9DAD7' },
  success: { bg: color.successTint, fg: color.success, border: '#B7D9C8' },
  warning: { bg: color.warningTint, fg: color.warning, border: '#F0CFA6' },
  danger: { bg: color.dangerTint, fg: color.danger, border: '#EDB9B9' },
  accent: { bg: '#FFF4D1', fg: '#6B4A00', border: '#F2D27A' },
};

/** A small label. Always text (+ optional symbol), never colour alone. */
export function Badge({ label, tone = 'neutral', symbol, style }: { label: string; tone?: Tone; symbol?: string; style?: StyleProp<ViewStyle> }) {
  const t = tones[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg, borderColor: t.border }, style]} accessibilityLabel={label}>
      {symbol ? <Text style={{ color: t.fg, fontSize: 12, fontWeight: '800', fontFamily: font.family }}>{symbol}</Text> : null}
      <Text style={{ color: t.fg, fontSize: 12, fontWeight: '700', fontFamily: font.family }}>{label}</Text>
    </View>
  );
}

export function Banner({ text, tone = 'warning', symbol = '!', action }: { text: string; tone?: Tone; symbol?: string; action?: ReactNode }) {
  const t = tones[tone];
  return (
    <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: t.bg, borderColor: t.border }]}>
      <View style={[styles.bannerIcon, { backgroundColor: t.fg }]}><Text style={{ color: '#fff', fontWeight: '800', fontFamily: font.family }}>{symbol}</Text></View>
      <T v="label" tone={t.fg} style={{ flex: 1 }}>{text}</T>
      {action}
    </View>
  );
}

// ------------------------------------------------------------------ inputs
export function Field({ label, error, style, inputStyle, ...rest }: TextInputProps & { label: string; error?: string | null; inputStyle?: StyleProp<TextStyle> }) {
  return (
    <View style={[{ gap: 6 }, style]}>
      <T v="label">{label}</T>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#8A94A6"
        {...rest}
        style={[styles.input, error ? { borderColor: color.danger } : null, inputStyle]}
      />
      {error ? <T v="small" tone={color.danger}>! {error}</T> : null}
    </View>
  );
}

export function Segmented<V extends string>({ options, value, onChange, label }: { options: { value: V; label: string }[]; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.segment}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            style={[styles.segmentItem, on && { backgroundColor: color.card, ...shadow }]}>
            <T v="label" tone={on ? color.primary : color.muted}>{on ? '● ' : ''}{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

// ------------------------------------------------------------------ keypad
export function Keypad({ onKey, keys, size = 64, testIDPrefix = 'key' }: { onKey: (k: string) => void; keys?: string[]; size?: number; testIDPrefix?: string }) {
  const layout = keys ?? ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];
  const label = (k: string) => (k === '⌫' ? 'Delete' : k === 'C' ? 'Clear' : k === '00' ? 'Double zero' : k);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, width: size * 3 + space.sm * 2 }}>
      {layout.map((k) => (
        <Pressable key={k} testID={`${testIDPrefix}-${k}`} accessibilityRole="button" accessibilityLabel={label(k)} onPress={() => onKey(k)}
          style={({ pressed }) => [styles.key, { width: size, height: size }, pressed && { backgroundColor: color.primaryTint, transform: [{ scale: 0.97 }] }]}>
          <Text style={{ fontSize: k.length > 1 && k !== '00' ? 18 : 26, fontWeight: '600', color: k === 'C' ? color.danger : color.ink, fontFamily: font.family }}>{k}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Applies a keypad key to an amount typed in pence ("1", "12", "125" -> £1.25). */
export function applyAmountKey(current: string, k: string, max = 9): string {
  if (k === 'C') return '';
  if (k === '⌫') return current.slice(0, -1);
  const next = (current + k).replace(/^0+/, '');
  return next.length > max ? current : next;
}

// ------------------------------------------------------------------ sheet (modal)
export function Sheet({ visible, onClose, title, children, width = 560, footer, testID }: {
  visible: boolean; onClose?: () => void; title: string; children: ReactNode; width?: number; footer?: ReactNode; testID?: string;
}) {
  useEscape(visible ? onClose : undefined);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <View testID={testID} accessibilityViewIsModal accessibilityLabel={title} style={[styles.sheet, { maxWidth: width }]} role="dialog" aria-modal>
          <Row style={{ justifyContent: 'space-between', marginBottom: space.md }}>
            <T v="h2" accessibilityRole="header" style={{ flex: 1 }}>{title}</T>
            {onClose ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.close}>
                <Text style={{ fontSize: 22, color: color.muted, fontFamily: font.family }}>×</Text>
              </Pressable>
            ) : null}
          </Row>
          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space.md }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
          {footer ? <View style={{ marginTop: space.lg, gap: space.sm }}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

function useEscape(fn?: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (Platform.OS !== 'web' || !fn) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [!!fn]);
}

export function Screen({ children, scroll = true, style }: { children: ReactNode; scroll?: boolean; style?: StyleProp<ViewStyle> }) {
  if (!scroll) return <View style={[{ flex: 1, padding: space.xl, gap: space.lg }, style]}>{children}</View>;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={[{ padding: space.xl, gap: space.lg, maxWidth: 1200, width: '100%', alignSelf: 'center' }, style]}
      keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  btn: { borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space.lg, paddingVertical: space.sm, alignItems: 'center', justifyContent: 'center' },
  btnDisabled: { opacity: 0.45 },
  card: { backgroundColor: color.card, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, ...shadow },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderRadius: radius.md, padding: space.md },
  bannerIcon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  input: {
    minHeight: touch.min, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: radius.sm, paddingHorizontal: space.md, fontSize: 17,
    backgroundColor: color.card, color: color.ink, fontFamily: font.family,
  },
  segment: { flexDirection: 'row', backgroundColor: '#EEF1F5', borderRadius: radius.md, padding: 4, gap: 4 },
  segmentItem: { flex: 1, minHeight: 44, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md },
  key: { borderRadius: radius.md, backgroundColor: color.card, borderWidth: 1, borderColor: color.border, alignItems: 'center', justifyContent: 'center', ...shadow },
  overlay: { flex: 1, backgroundColor: color.overlay, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  sheet: { width: '100%', maxHeight: '92%', backgroundColor: color.card, borderRadius: radius.lg, padding: space.xl, ...shadowLg },
  close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
