import { CanvasCard, type CardAccent, type CardStatus } from './CanvasPane.js';
import type { AdvisorCardContent } from './advisor-content.js';
import '../styles/advisor-card.css';

export interface AdvisorCardProps {
  status: CardStatus;
  content: AdvisorCardContent;
  index?: number;
  accent?: CardAccent;
}

/**
 * One activity agent's output (launch plan, pitch deck, financial angle, …)
 * — the same layout for every agent so the canvas reads as one system:
 * summary, the agent's required sections, then the assumptions and cited
 * sources behind it.
 */
export function AdvisorCard({ status, content, index, accent = 'neutral' }: AdvisorCardProps) {
  return (
    <CanvasCard title={content.label} index={index} status={status} accent={accent}>
      <p className="advisor-card__summary">{content.summary}</p>

      <div className="advisor-card__sections">
        {content.sections.map((section) => (
          <section key={section.key} className="advisor-card__section">
            <h4>{section.title}</h4>
            <p>{section.body}</p>
            {section.items && section.items.length > 0 && (
              <ul>
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      {content.assumptions.length > 0 && (
        <details className="advisor-card__meta">
          <summary>Assumptions ({content.assumptions.length})</summary>
          <ul>
            {content.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </details>
      )}

      {content.sources.length > 0 && (
        <details className="advisor-card__meta">
          <summary>Sources ({content.sources.length})</summary>
          <ul>
            {content.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </CanvasCard>
  );
}
