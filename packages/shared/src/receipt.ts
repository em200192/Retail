/** Receipt number generated offline on the device: '{branch_code}-{device_no}-{seq}'. */
export function formatReceiptNumber(branchCode: string, deviceNo: number, seq: number): string {
  if (!/^[A-Za-z0-9]+$/.test(branchCode)) throw new RangeError('branch code must be alphanumeric');
  if (!Number.isInteger(deviceNo) || deviceNo <= 0) throw new RangeError('device number must be a positive integer');
  if (!Number.isInteger(seq) || seq <= 0) throw new RangeError('sequence must be a positive integer');
  return `${branchCode}-${deviceNo}-${seq}`;
}

export function parseReceiptNumber(receipt: string): { branchCode: string; deviceNo: number; seq: number } | null {
  const m = /^([A-Za-z0-9]+)-(\d+)-(\d+)$/.exec(receipt);
  if (!m) return null;
  return { branchCode: m[1]!, deviceNo: Number(m[2]), seq: Number(m[3]) };
}
