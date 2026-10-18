import {
  emptyState,
  monthDays,
  monthEnd,
  shiftMonth,
  today,
  validateState,
  type State,
  type Transaction,
} from './core.js';
export function defaultCategories(): State["categories"] {
  return [
    ['home', 'Home', 'home', '#73849a', 'Essentials'],
    ['groceries', 'Groceries', 'groceries', '#8d9b8a', 'Food & drink'],
    ['restaurants', 'Restaurants', 'restaurants', '#9d8f83', 'Food & drink'],
    ['coffee', 'Coffee', 'coffee', '#91877c', 'Food & drink'],
    ['transport', 'Transportation', 'transport', '#7e98a1', 'Everyday'],
    ['shopping', 'Shopping', 'shopping', '#8b87a0', 'Everyday'],
    ['health', 'Health', 'health', '#a08c8c', 'Everyday'],
    ['fun', 'Entertainment', 'fun', '#7b8faa', 'Everyday'],
    ['travel', 'Travel', 'travel', '#829894', 'Lifestyle'],
    ['other', 'Other', 'other', '#92979e', 'Everyday'],
  ].map(([id, name, icon, color, group]) => ({ id, name, icon, color, group, archived: false }));
}
export function createDemo(asOf = today()): State {
  const s = emptyState();
  s.settings.demo = true;
  const now = asOf + 'T16:00:00Z';
  s.categories = defaultCategories();
  s.accounts = [
    ['checking', 'Everyday Checking', 'checking', 1284563, '4821'],
    ['savings', 'High Yield Savings', 'savings', 2468000, '7402'],
    ['card', 'Everyday Card', 'credit', 184672, '0951'],
    ['broker', 'Investment Account', 'investment', 5965250, '3086'],
    ['ira', 'Roth IRA', 'investment', 2178800, '8812'],
    ['loan', 'Student Loan', 'loan', 825000, '6340'],
  ].map(([id, name, type, balance, mask]) => ({
    id: String(id),
    name: String(name),
    type: type as any,
    balance: Number(balance),
    mask: String(mask),
    currency: 'USD',
    includeInNetWorth: true,
    enabled: true,
    source: 'demo',
    updatedAt: id === 'ira' ? shiftMonth(asOf.slice(0, 7), -1) + '-20T16:00:00Z' : now,
    coverageStart: '2024-01-01',
    coverageEnd: asOf,
    coverageComplete: true,
  }));
  const amounts: Record<string, number> = {
    home: 220000,
    groceries: 55000,
    restaurants: 45000,
    coffee: 12000,
    transport: 28000,
    shopping: 40000,
    health: 22000,
    fun: 22000,
    travel: 42000,
    other: 14000,
  };
  let i = 0;
  const add = (
    date: string,
    name: string,
    amount: number,
    categoryId: string,
    kind: Transaction['kind'] = 'spending',
    accountId = 'card',
    extra: Partial<Transaction> = {},
  ) => {
    s.transactions.push({
      id: 'demo-t-' + i++,
      name,
      date,
      amount,
      categoryId,
      kind,
      accountId,
      currency: 'USD',
      notes: '',
      excluded: false,
      reviewed: true,
      pending: false,
      removed: false,
      source: 'demo',
      importedAt: date + 'T16:00:00Z',
      edits: {},
      splits: [],
      ...extra,
    });
  };
  for (let month = '2024-01'; month <= asOf.slice(0, 7); month = shiftMonth(month, 1)) {
    const factor = 1 + (Number(month.slice(0, 4)) - 2024) * 0.02;
    for (const c of s.categories)
      s.budgets.push({ month, categoryId: c.id, amount: amounts[c.id] });
    for (let day = 1; day <= monthDays(month); day++) {
      const date = month + '-' + String(day).padStart(2, '0');
      if (date > asOf) break;
      if (day === 1) add(date, 'Home rent', 210000, 'home', 'spending', 'checking');
      if (day === 1 || day === 15)
        add(date, 'Northstar payroll', 465000, 'other', 'income', 'checking');
      if (day % 5 === 0)
        add(date, 'Greenmarket', Math.round((6700 + day * 67) * factor), 'groceries');
      if (day % 3 === 0)
        add(
          date,
          ['Noodle House', 'Little Bird', 'Sunday Table'][(day % 7) % 3],
          Math.round((2400 + day * 83) * factor),
          'restaurants',
        );
      if (day % 2 === 0) add(date, 'Daybreak Coffee', 650 + day * 11, 'coffee');
      if (day % 7 === 0) add(date, 'City Transit', 3500, 'transport');
      if (day === 8) add(date, 'Neighborhood Books', 4280, 'shopping');
      if (day === 11) add(date, 'Everlane', 18750, 'shopping');
      if (day === 13) add(date, 'Local Pharmacy', 2870, 'health');
      if (day === 18) add(date, 'Cinema Social', 3800, 'fun');
      if (day === 21) add(date, 'Card payment', 210000, 'other', 'card_payment', 'checking');
      if (day === 21) add(date, 'Payment received', 210000, 'other', 'card_payment', 'card');
      if (day === 22)
        add(date, 'Investment contribution', 50000, 'other', 'investment_transfer', 'checking');
      if (day === 24) add(date, 'Savings transfer', 80000, 'other', 'transfer', 'checking');
      if (day === 24) add(date, 'Savings transfer', 80000, 'other', 'transfer', 'savings');
      if (day === 25) add(date, 'Everlane return', 4200, 'shopping', 'refund');
      if (day === 26)
        add(date, 'Work supplies', 6550, 'shopping', 'spending', 'card', {
          excluded: true,
          notes: 'Reimbursable work purchase; excluded from budget.',
        });
    }
    const date = monthEnd(month) > asOf ? asOf : monthEnd(month);
    const index = (Number(month.slice(0, 4)) - 2024) * 12 + Number(month.slice(5, 7));
    for (const a of s.accounts) {
      const isDebt = a.type === 'credit' || a.type === 'loan';
      const balance =
        date === asOf
          ? a.balance!
          : Math.round(a.balance! * (isDebt ? 1 + (34 - index) * 0.01 : 0.55 + index * 0.013));
      s.snapshots.push({
        id: `${a.id}-${date}`,
        accountId: a.id,
        date,
        balance,
        currency: 'USD',
        source: 'demo',
      });
    }
  }
  const current = s.transactions.filter(
    (t) => t.date.startsWith(asOf.slice(0, 7)) && t.kind === 'spending',
  );
  current.slice(-8).forEach((t) => (t.reviewed = false));
  add(asOf, 'Weekend Escape', 46500, 'travel', 'spending', 'card', { reviewed: false });
  add(asOf, 'Corner Store', 2640, 'groceries', 'spending', 'card', {
    pending: true,
    reviewed: false,
  });
  add(asOf, 'Market & Home', 8890, 'groceries', 'spending', 'card', {
    reviewed: false,
    splits: [
      { id: 'demo-split-food', categoryId: 'groceries', amount: 5890, excluded: false },
      { id: 'demo-split-home', categoryId: 'home', amount: 3000, excluded: false },
    ],
  });
  s.holdings = [
    [
      'vti',
      'broker',
      'VTI',
      'Vanguard Total Stock Market ETF',
      '100',
      29125,
      2912500,
      2340000,
      'ETF',
    ],
    [
      'vxus',
      'broker',
      'VXUS',
      'Vanguard Total International Stock ETF',
      '200',
      6890,
      1378000,
      1220000,
      'ETF',
    ],
    ['aapl', 'broker', 'AAPL', 'Apple', '50', 22595, 1129750, 910000, 'Equity'],
    ['cash', 'broker', 'USD', 'Cash balance', '5450', 100, 545000, 545000, 'Cash'],
    [
      'bnd',
      'ira',
      'BND',
      'Vanguard Total Bond Market ETF',
      '200',
      7334,
      1466800,
      1500000,
      'Fixed income',
    ],
    ['voo', 'ira', 'VOO', 'Vanguard S&P 500 ETF', '14', 50857, 712000, 560000, 'ETF'],
  ].map(([id, accountId, symbol, name, quantity, price, marketValue, costBasis, type]) => ({
    id: String(id),
    accountId: String(accountId),
    symbol: String(symbol),
    name: String(name),
    quantity: String(quantity),
    price: Number(price),
    marketValue: Number(marketValue),
    costBasis: Number(costBasis),
    type: String(type),
    currency: 'USD',
    priceAt: accountId === 'ira' ? shiftMonth(asOf.slice(0, 7), -1) + '-20T20:00:00Z' : now,
    source: 'demo',
  }));
  s.rules = [
    {
      id: 'rule-coffee',
      merchant: 'Daybreak Coffee',
      match: 'exact',
      accountId: null,
      categoryId: 'coffee',
    },
  ];
  return validateState(s);
}
