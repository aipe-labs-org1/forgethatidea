import { describe, expect, it, vi } from 'vitest';
import { emitAnalyticsEvent } from './analytics.js';

describe('emitAnalyticsEvent (#42)', () => {
  it('logs a phase_entered event with a marker field and event type in the message', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, { type: 'phase_entered', sessionId: 'session-1', phase: 'sources' });

    expect(logger.info).toHaveBeenCalledWith(
      { analytics_event: true, type: 'phase_entered', sessionId: 'session-1', phase: 'sources' },
      'analytics.phase_entered',
    );
  });

  it('logs a refinement_used event with round/limit', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, {
      type: 'refinement_used',
      sessionId: 'session-1',
      kind: 'app',
      round: 1,
      limit: 3,
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        analytics_event: true,
        type: 'refinement_used',
        sessionId: 'session-1',
        kind: 'app',
        round: 1,
        limit: 3,
      },
      'analytics.refinement_used',
    );
  });

  it('logs a session_converted event', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, { type: 'session_converted', sessionId: 'session-1' });

    expect(logger.info).toHaveBeenCalledWith(
      { analytics_event: true, type: 'session_converted', sessionId: 'session-1' },
      'analytics.session_converted',
    );
  });

  it('logs an app_exported event with the exported version', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, { type: 'app_exported', sessionId: 'session-1', version: 3 });

    expect(logger.info).toHaveBeenCalledWith(
      { analytics_event: true, type: 'app_exported', sessionId: 'session-1', version: 3 },
      'analytics.app_exported',
    );
  });

  it('logs an app_exported event with fromGate when exported from a gated state (#95)', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, {
      type: 'app_exported',
      sessionId: 'session-1',
      version: 3,
      fromGate: true,
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        analytics_event: true,
        type: 'app_exported',
        sessionId: 'session-1',
        version: 3,
        fromGate: true,
      },
      'analytics.app_exported',
    );
  });

  it('logs a content_screened event without leaking the refusal reason text', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, {
      type: 'content_screened',
      sessionId: 'session-1',
      allowed: false,
    });

    expect(logger.info).toHaveBeenCalledWith(
      { analytics_event: true, type: 'content_screened', sessionId: 'session-1', allowed: false },
      'analytics.content_screened',
    );
  });

  it('logs a gate_shown event when a refinement round limit gate fires (#87)', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, {
      type: 'gate_shown',
      sessionId: 'session-1',
      kind: 'app',
      rounds: 3,
      limit: 3,
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        analytics_event: true,
        type: 'gate_shown',
        sessionId: 'session-1',
        kind: 'app',
        rounds: 3,
        limit: 3,
      },
      'analytics.gate_shown',
    );
  });

  it('logs a build_failed event with archetype/cause/repairRounds (#83)', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, {
      type: 'build_failed',
      sessionId: 'session-1',
      archetype: 'crud-tracker',
      cause: 'validation_failed_after_repairs',
      repairRounds: 2,
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        analytics_event: true,
        type: 'build_failed',
        sessionId: 'session-1',
        archetype: 'crud-tracker',
        cause: 'validation_failed_after_repairs',
        repairRounds: 2,
      },
      'analytics.build_failed',
    );
  });

  it('logs a build_succeeded event with archetype/repairRounds (#83)', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, {
      type: 'build_succeeded',
      sessionId: 'session-1',
      archetype: 'dashboard',
      repairRounds: 0,
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        analytics_event: true,
        type: 'build_succeeded',
        sessionId: 'session-1',
        archetype: 'dashboard',
        repairRounds: 0,
      },
      'analytics.build_succeeded',
    );
  });

  it('logs a data_export_requested event with the requesting userId (#104)', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, { type: 'data_export_requested', userId: 'user-1' });

    expect(logger.info).toHaveBeenCalledWith(
      { analytics_event: true, type: 'data_export_requested', userId: 'user-1' },
      'analytics.data_export_requested',
    );
  });

  it('logs a checkout_started event with userId/tierId/surface (#108)', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, {
      type: 'checkout_started',
      userId: 'user-1',
      tierId: 'spec-pack',
      surface: 'refinement_gate',
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        analytics_event: true,
        type: 'checkout_started',
        userId: 'user-1',
        tierId: 'spec-pack',
        surface: 'refinement_gate',
      },
      'analytics.checkout_started',
    );
  });

  it('logs a purchase_completed event with userId/tierId/amountCents (#108)', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, {
      type: 'purchase_completed',
      userId: 'user-1',
      tierId: 'spec-pack',
      amountCents: 1900,
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        analytics_event: true,
        type: 'purchase_completed',
        userId: 'user-1',
        tierId: 'spec-pack',
        amountCents: 1900,
      },
      'analytics.purchase_completed',
    );
  });

  it('never includes anything beyond sessionId, event-specific structural fields, and the type', () => {
    const logger = { info: vi.fn() };

    emitAnalyticsEvent(logger, {
      type: 'phase_entered',
      sessionId: 'session-1',
      phase: 'onboarding',
    });

    const [payload] = logger.info.mock.calls[0]!;
    expect(Object.keys(payload).sort()).toEqual(['analytics_event', 'phase', 'sessionId', 'type']);
  });
});
