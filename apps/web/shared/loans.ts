export const loanLenders = {
  santander: { name: 'Santander Consumer USA', url: 'https://myaccount.santanderconsumerusa.com/' },
  synchrony: {
    name: 'Synchrony Pay Later',
    url: 'https://www.synchrony.com/quickaccess/signin/paylater',
  },
  other: { name: 'Other lender', url: null },
} as const;
