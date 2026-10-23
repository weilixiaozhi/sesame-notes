type AaMember = { id: string; displayName: string; linkedAccountId: string | null };
type AaTransaction = {
  nativeAmount: string;
  aaMode: number | null;
  payerMemberId: string | null;
  splits: Array<{ memberId: string; amount: string }>;
};
const SCALE = 10000000000n;
const CENT = 100000000n;

/** 以十位定点数对齐移动端 AA 口径：均摊到分、余数给付款人，历史退出成员仍参与。 */
export function aaStatistics(members: AaMember[], transactions: AaTransaction[], userId: string) {
  const totals = new Map(
    members.map((member) => [
      member.id,
      {
        member_id: member.id,
        display_name: member.displayName || '未知',
        is_self: member.linkedAccountId === userId,
        paid: 0n,
        should: 0n,
        nonSplit: 0n,
      },
    ]),
  );
  const participants = members.map((member) => member.id);
  let included = 0;
  let excluded = 0;
  let skipped = 0;
  /** 保留历史未知成员，不把其金额错误归属给当前登录用户。 */
  function member(id: string) {
    let value = totals.get(id);
    if (!value) {
      value = { member_id: id, display_name: '未知', is_self: false, paid: 0n, should: 0n, nonSplit: 0n };
      totals.set(id, value);
    }
    return value;
  }
  for (const transaction of transactions) {
    const total = units(transaction.nativeAmount);
    const payer = transaction.payerMemberId;
    if (transaction.aaMode === 1) {
      excluded++;
      if (payer && total !== null) member(payer).nonSplit += total;
      continue;
    }
    if (!payer || total === null || !participants.length) {
      skipped++;
      continue;
    }
    let shares: Map<string, bigint>;
    if (transaction.aaMode === 2) {
      shares = new Map();
      let invalid = false;
      for (const split of transaction.splits) {
        const amount = units(split.amount);
        if (amount === null || shares.has(split.memberId)) {
          invalid = true;
          break;
        }
        shares.set(split.memberId, amount);
      }
      if (invalid || !shares.size || [...shares.values()].reduce((a, b) => a + b, 0n) !== total) {
        skipped++;
        continue;
      }
    } else {
      if (!participants.includes(payer)) {
        skipped++;
        continue;
      }
      const base = (total / CENT / BigInt(participants.length)) * CENT;
      shares = new Map(participants.map((id) => [id, base]));
      shares.set(payer, base + total - base * BigInt(participants.length));
    }
    member(payer).paid += total;
    for (const [id, amount] of shares) member(id).should += amount;
    included++;
  }
  const nets = new Map(
    [...totals].map(([id, value]) => [id, value.paid - value.should]).filter(([, value]) => value !== 0n) as Array<
      [string, bigint]
    >,
  );
  const transfers: Array<{ from_member_id: string; to_member_id: string; amount: string; exact_amount: string }> = [];
  while (nets.size) {
    let debtor: string | undefined, creditor: string | undefined;
    for (const [id, value] of nets) {
      if (value < 0n && (!debtor || value < nets.get(debtor)!)) debtor = id;
      if (value > 0n && (!creditor || value > nets.get(creditor)!)) creditor = id;
    }
    if (!debtor || !creditor) break;
    const due = -nets.get(debtor)!;
    const owed = nets.get(creditor)!;
    const amount = due < owed ? due : owed;
    transfers.push({
      from_member_id: debtor,
      to_member_id: creditor,
      amount: format(halfEvenCents(amount)),
      exact_amount: format(amount),
    });
    nets.set(debtor, nets.get(debtor)! + amount);
    nets.set(creditor, nets.get(creditor)! - amount);
    if (nets.get(debtor) === 0n) nets.delete(debtor);
    if (nets.get(creditor) === 0n) nets.delete(creditor);
  }
  return {
    transaction_count: included,
    excluded_count: excluded,
    skipped_count: skipped,
    participants: [...totals.values()].map((value) => ({
      member_id: value.member_id,
      display_name: value.display_name,
      is_self: value.is_self,
      total_paid: format(value.paid),
      total_should_pay: format(value.should),
      net: format(value.paid - value.should),
      non_split_paid: format(value.nonSplit),
    })),
    transfers,
  };
}
/** 严格解析非负业务金额，避免浮点误差和损坏数据污染其他成员。 */
function units(value: string): bigint | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,10})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole! + fraction.padEnd(10, '0'));
}
/** 输出规范十进制，包括应付净额的负号。 */
function format(value: bigint): string {
  const abs = value < 0n ? -value : value;
  const fraction = (abs % SCALE).toString().padStart(10, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${abs / SCALE}${fraction ? `.${fraction}` : ''}`;
}
/** 转账展示金额采用手机同款银行家舍入，另保留精确值用于审阅。 */
function halfEvenCents(value: bigint): bigint {
  let cents = value / CENT;
  const remainder = value % CENT;
  if (remainder * 2n > CENT || (remainder * 2n === CENT && cents % 2n === 1n)) cents++;
  return cents * CENT;
}
