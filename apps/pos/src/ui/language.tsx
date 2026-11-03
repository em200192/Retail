import { Pressable, type StyleProp, Text, View, type ViewStyle } from 'react-native';
import { type Lang, LANGS, LANGUAGES, setLanguage, t, useLang } from '../i18n';
import { color, font, radius, shadow } from './theme';

/**
 * "English | العربية". Each option is written in its own language, so anyone
 * can find theirs whatever the till is showing. The group label is bilingual too.
 */
export function LanguageSwitch({ style, testID = 'language-switch', onChange }: { style?: StyleProp<ViewStyle>; testID?: string; onChange?: (l: Lang) => void }) {
  const lang = useLang();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={lang === 'en' ? 'Language' : `${t('lang.label')} · Language`} testID={testID}
      style={[{ flexDirection: 'row', backgroundColor: '#EEF1F5', borderRadius: radius.md, padding: 4, gap: 4, alignSelf: 'flex-start' }, style]}>
      {LANGS.map((l) => {
        const on = l === lang;
        const info = LANGUAGES[l];
        return (
          <Pressable key={l} testID={`lang-${l}`} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={info.nativeName}
            accessibilityLanguage={info.htmlLang}
            onPress={() => { setLanguage(l); onChange?.(l); }}
            style={[{ minHeight: 44, minWidth: 96, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
              on && { backgroundColor: color.card, ...shadow }]}>
            {/* each option in its own writing direction */}
            <Text style={{ fontSize: 15, fontWeight: '700', color: on ? color.primary : color.muted, fontFamily: font.family, writingDirection: info.dir }}>
              {on ? '● ' : ''}{info.nativeName}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
