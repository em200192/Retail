import type { LimitCode, Permission } from '@retail/shared';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ApiError, errorMessage } from '../api';
import { LTR, t, useLang } from '../i18n';
import { eligibleApprovers } from '../logic/permissions';
import { api, checkPinOffline, useApp } from '../state/store';
import { Banner, Button, Keypad, Row, Sheet, T } from './components';
import { color, font, radius, space } from './theme';

export interface ApprovalRequest {
  action: Permission;
  limit?: { code: LimitCode; value: number };
  title: string;
  description: string;
  /**
   * 'verify' (default): the till checks the approver's PIN (online via the API,
   * offline against the PIN verifier cached on this till) and records the
   * approval in the sale. 'collect': the endpoint being called checks the PIN
   * itself (e.g. cash movements), so just hand it over.
   */
  mode?: 'verify' | 'collect';
}

export interface ApprovalResult { approverId: string; approverName: string; pin: string; verified: 'online' | 'offline' | 'unverified' | 'server' }

export function ApprovalSheet({ request, onCancel, onApproved }: {
  request: ApprovalRequest | null; onCancel: () => void; onApproved: (r: ApprovalResult) => void;
}) {
  useLang();
  const staff = useApp((s) => s.catalog.staff);
  const me = useApp((s) => s.session?.staff.id ?? '');
  const [approverId, setApproverId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offlineNote, setOfflineNote] = useState<string | null>(null);

  useEffect(() => { setApproverId(null); setPin(''); setError(null); setOfflineNote(null); }, [request]);
  if (!request) return null;
  const approvers = eligibleApprovers(staff, me, request.action, request.limit);
  const approver = approvers.find((a) => a.id === approverId);

  const confirm = async () => {
    if (!approver) return;
    setBusy(true);
    setError(null);
    try {
      if (request.mode === 'collect') {
        onApproved({ approverId: approver.id, approverName: approver.display_name, pin, verified: 'server' });
        return;
      }
      try {
        await api('POST', '/v1/pos/verify-approval', {
          action_code: request.action, limit_code: request.limit?.code, value: request.limit?.value ?? 0,
          approver_staff_id: approver.id, approver_pin: pin,
        }, { timeoutMs: 6000 });
        onApproved({ approverId: approver.id, approverName: approver.display_name, pin, verified: 'online' });
      } catch (e) {
        if (!(e instanceof ApiError && e.offline)) throw e;
        // Offline: check against this till's cached PIN verifier if the manager has logged in here before.
        const ok = await checkPinOffline(approver.id, pin);
        if (ok === false) throw new Error(t('error.pinIncorrect'));
        if (ok === null && !offlineNote) {
          setOfflineNote(t('approval.offlineUnknown', { name: approver.display_name }));
          return;
        }
        onApproved({ approverId: approver.id, approverName: approver.display_name, pin, verified: ok ? 'offline' : 'unverified' });
      }
    } catch (e) {
      setError(errorMessage(e));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible title={request.title} onClose={onCancel} width={640} testID="approval-sheet">
      <Banner tone="warning" symbol="!" text={request.description} />
      <T v="label">{t('approval.choose')}</T>
      <Row wrap gap={space.sm}>
        {approvers.map((a) => {
          const on = a.id === approverId;
          return (
            <Pressable key={a.id} testID={`approver-${a.display_name}`} accessibilityRole="radio" accessibilityState={{ checked: on }}
              accessibilityLabel={a.display_name} onPress={() => { setApproverId(a.id); setPin(''); setError(null); }}
              style={{ minHeight: 56, paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: 2, justifyContent: 'center',
                borderColor: on ? color.primary : color.border, backgroundColor: on ? color.primaryTint : color.card }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: on ? color.primary : color.ink, fontFamily: font.family }}>{on ? '✓ ' : ''}{a.display_name}</Text>
            </Pressable>
          );
        })}
        {approvers.length === 0 ? <T muted>{t('approval.nobody')}</T> : null}
      </Row>
      {approver ? (
        <View style={{ alignItems: 'center', gap: space.md }}>
          <Row gap={12} style={LTR}>
            {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
              <View key={i} style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: color.primary, backgroundColor: i < pin.length ? color.primary : 'transparent' }} />
            ))}
          </Row>
          <Keypad testIDPrefix="approve" size={64} onKey={(k) => setPin((p) => (k === 'C' ? '' : k === '⌫' ? p.slice(0, -1) : p.length >= 8 ? p : p + k))} />
        </View>
      ) : null}
      {offlineNote ? <Banner tone="accent" text={offlineNote} /> : null}
      {error ? <Banner tone="danger" text={error} /> : null}
      <Row>
        <Button kind="secondary" label={t('common.cancel')} onPress={onCancel} style={{ flex: 1 }} />
        <Button testID="approve-confirm" label={busy ? t('common.checking') : t('approval.approve')} disabled={!approver || pin.length < 4 || busy} onPress={confirm} style={{ flex: 2 }} />
      </Row>
    </Sheet>
  );
}
