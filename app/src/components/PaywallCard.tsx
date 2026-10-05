import { useState } from 'react';
import { Button } from '@forge/shared/ui';
import { createCheckoutSession } from '../api.js';
import { CanvasCard } from './CanvasPane.js';
import type { PaywallCardContent } from './advisor-content.js';
import '../styles/paywall-card.css';

export interface PaywallCardProps {
  content: PaywallCardContent;
  sessionId: string;
  index?: number;
}

function formatPrice(cents: number | null): string | null {
  if (cents === null) return null;
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/**
 * Left on the canvas when a paid agent (pitch deck, spec pack, financial…)
 * is asked for but the user doesn't own its tier — sends them to checkout
 * and back to the exact project via /checkout/return.
 */
export function PaywallCard({ content, sessionId, index }: PaywallCardProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const price = formatPrice(content.priceCents);

  async function handleUnlock() {
    setStarting(true);
    setError(null);
    const origin = window.location.origin;
    const back = `${origin}/checkout/return?tier=${content.tierId}&session=${sessionId}`;
    try {
      const result = await createCheckoutSession(
        content.tierId,
        `${back}&status=success`,
        `${back}&status=cancelled`,
        'agent_paywall',
      );
      if (result.ok === true) {
        window.location.assign((result as { url: string }).url);
        return;
      }
      const failure = (result as { error: string }).error;
      setError(
        failure === 'disclaimer_not_accepted'
          ? 'Accept the assumptions disclaimer first, then try again.'
          : failure === 'velocity_limit_exceeded'
            ? 'Too many checkout attempts. Wait a minute and try again.'
            : "Checkout isn't available right now. Nothing was charged.",
      );
    } catch {
      setError("Couldn't reach checkout. Check your connection and try again.");
    }
    setStarting(false);
  }

  const sameName = content.agentLabel.toLowerCase() === content.tierName.toLowerCase();

  return (
    <CanvasCard title={`Unlock ${content.agentLabel}`} index={index} status="draft" accent="signal">
      <div className="paywall-card">
        <p className="paywall-card__lead">
          {sameName ? (
            <>The {content.tierName} is a paid unlock</>
          ) : (
            <>
              {content.agentLabel} is included in the <strong>{content.tierName}</strong>
            </>
          )}
          {price && (
            <>
              {' '}
              for <span className="paywall-card__price">{price}</span>
            </>
          )}
          .
        </p>
        {content.description && <p className="paywall-card__description">{content.description}</p>}
        <Button variant="primary" size="sm" onClick={handleUnlock} disabled={starting}>
          {starting ? 'Opening checkout…' : `Unlock ${content.tierName}`}
        </Button>
        {error && (
          <p className="paywall-card__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </CanvasCard>
  );
}
