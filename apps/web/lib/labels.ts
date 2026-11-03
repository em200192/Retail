export const INVOICE_STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'warning' | 'success' | 'danger' }> = {
  uploaded: { label: 'Waiting to be read', tone: 'neutral' }, processing: { label: 'Reading…', tone: 'brand' },
  needs_review: { label: 'Needs checking', tone: 'warning' }, approved: { label: 'Ready to post', tone: 'brand' },
  posted: { label: 'In stock', tone: 'success' }, rejected: { label: 'Rejected', tone: 'danger' }, failed: { label: 'Could not read', tone: 'danger' },
};
