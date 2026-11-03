import { ActivityIndicator, View } from 'react-native';
import { t } from '../src/i18n';
import { color } from '../src/ui/theme';

/** The root layout's guard decides where to go (pair -> PIN -> till). */
export default function Index() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={color.primary} accessibilityLabel={t('common.loading')} />
    </View>
  );
}
