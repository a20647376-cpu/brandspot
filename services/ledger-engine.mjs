import crypto from 'node:crypto';

// Double-Entry Financial Ledger Engine
// Every journal entry MUST balance: sum(debit_pkr) === sum(credit_pkr).

export function postJournalEntry(db, { referenceType, referenceId, description, postings }) {
  const totalDebit = postings.reduce((s, p) => s + (p.debitPkr || 0), 0);
  const totalCredit = postings.reduce((s, p) => s + (p.creditPkr || 0), 0);
  if (totalDebit !== totalCredit || totalDebit <= 0) {
    throw new Error(`Unbalanced journal entry: debit=${totalDebit}, credit=${totalCredit}`);
  }

  const entryId = 'je_' + crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO ledger_journal_entries (id, reference_type, reference_id, description, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(entryId, referenceType, referenceId, description, now);

  const stmt = db.prepare(
    'INSERT INTO ledger_postings (id, journal_entry_id, account_code, seller_id, debit_pkr, credit_pkr) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const p of postings) {
    stmt.run(
      'lp_' + crypto.randomUUID().slice(0, 12),
      entryId,
      p.accountCode,
      p.sellerId || null,
      p.debitPkr || 0,
      p.creditPkr || 0
    );
  }
  return entryId;
}

export function verifyLedgerBalance(db) {
  const row = db.prepare('SELECT COALESCE(SUM(debit_pkr), 0) AS debits, COALESCE(SUM(credit_pkr), 0) AS credits FROM ledger_postings').get();
  return {
    balanced: row.debits === row.credits,
    totalDebitsPkr: row.debits,
    totalCreditsPkr: row.credits
  };
}
