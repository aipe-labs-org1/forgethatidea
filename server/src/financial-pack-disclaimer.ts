/**
 * Financial & Strategy pack disclaimer (Epic 6.9, #105): the assumptions/
 * not-advice gate before this specific tier can be purchased. Versioned so
 * a future copy change (legal review, #106) can force re-acceptance —
 * bump this whenever the disclaimer text changes in a way that could
 * affect what the user is agreeing to, date + incrementing suffix, same
 * convention as CODEGEN_CONTRACT_VERSION/SYSTEM_PROMPT_VERSION.
 */
export const FINANCIAL_PACK_DISCLAIMER_ID = 'financial-pack-assumptions';
export const FINANCIAL_PACK_DISCLAIMER_VERSION = '2026-01.1';

export const FINANCIAL_PACK_DISCLAIMER_TEXT =
  'The Financial & Strategy pack generates a financial model and growth strategy grounded in ' +
  'assumptions you provide and real, cited sources — it is not financial, legal, or investment ' +
  'advice, and Forge does not guarantee any outcome. You are responsible for your own business ' +
  'decisions and should consult a qualified professional before acting on anything in this pack.';
