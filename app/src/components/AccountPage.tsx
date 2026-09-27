import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@forge/shared/ui';
import {
  getMe,
  getEntitlements,
  cancelSubscription,
  requestDataExport,
  type TierId,
} from '../api.js';
import '../styles/account-page.css';

const TIER_LABELS: Record<TierId, string> = {
  'app-refinement-topup': 'App Refinement Top-Up',
  'spec-pack': 'Spec Pack',
  'pitch-deck': 'Pitch Deck',
  'financial-pack': 'Financial & Strategy Pack',
};

/**
 * Account & billing page (Epic 6.8): owned products, subscription status,
 * a link out to Stripe's own hosted customer portal (for invoices/payment
 * method management — never reimplemented here), and a data-export
 * request path. No Stripe customer-portal session creation exists yet
 * (same deferred-pending-a-live-key gap as every other Stripe integration
 * point) — the portal link degrades to a disabled, clearly-labeled state
 * rather than a broken link or a fake success.
 */
export function AccountPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [owned, setOwned] = useState<TierId[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [exportRequested, setExportRequested] = useState(false);

  useEffect(() => {
    getMe().then((result) => {
      if (result.ok) setEmail(result.data.email);
    });
    getEntitlements().then((result) => {
      setOwned(result.owned ?? []);
    });
  }, []);

  const hasSubscription = owned.includes('app-refinement-topup');

  async function handleCancel() {
    setCancelling(true);
    const result = await cancelSubscription();
    setCancelling(false);
    if (result.ok) {
      setCancelMessage(result.policy);
    } else {
      setCancelMessage("Something went wrong — your subscription hasn't been changed.");
    }
  }

  async function handleExportRequest() {
    const result = await requestDataExport();
    if (result.ok) setExportRequested(true);
  }

  return (
    <div className="account-page">
      <button type="button" className="account-page__back" onClick={() => navigate('/app')}>
        ← Back to your project
      </button>

      <h1>Account &amp; billing</h1>
      {email && <p className="account-page__email">{email}</p>}

      <section className="account-page__section">
        <h2>Owned products</h2>
        {owned.length === 0 ? (
          <p className="account-page__empty">You haven&apos;t purchased anything yet.</p>
        ) : (
          <ul className="account-page__tiers">
            {owned.map((tierId) => (
              <li key={tierId}>{TIER_LABELS[tierId]}</li>
            ))}
          </ul>
        )}
      </section>

      {hasSubscription && (
        <section className="account-page__section">
          <h2>Subscription</h2>
          <p>App Refinement Top-Up — active</p>
          <Button onClick={handleCancel} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel subscription'}
          </Button>
          {cancelMessage && <p className="account-page__cancel-message">{cancelMessage}</p>}
        </section>
      )}

      <section className="account-page__section">
        <h2>Invoices &amp; payment method</h2>
        <p className="account-page__empty">
          Manage invoices and your payment method via Stripe&apos;s billing portal.
        </p>
        <Button disabled title="Available once billing is fully connected">
          Open billing portal
        </Button>
      </section>

      <section className="account-page__section">
        <h2>Your data</h2>
        <p>Request a full export of everything associated with your account.</p>
        <Button onClick={handleExportRequest} disabled={exportRequested}>
          {exportRequested ? 'Export requested' : 'Request data export'}
        </Button>
      </section>
    </div>
  );
}
