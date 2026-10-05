import { createAdvisorModule, type AdvisorSpec } from './advisor-module.js';

/**
 * Every net-new activity agent from docs/build-agents.md. The spine agents
 * (onboarding, sources, brainstorm/build options, planning incl.
 * architecture/marketing/refine-plan, build, refine-app) live in
 * spine-modules.ts; these join them once the session reaches `minPhase`.
 */
export const ADVISOR_SPECS: AdvisorSpec[] = [
  {
    id: 'data-protection',
    label: 'Data protection & filings',
    minPhase: 'planning',
    guidance:
      "Work out what the app's data handling means legally for where the founder operates and sells: personal data collected, lawful basis, a plain-language privacy policy and terms outline, and any registration they likely need (e.g. ICO data protection fee in the UK, GDPR representative for EU users, CCPA notices for California). Say clearly this is orientation, not legal advice, and point to the official regulator pages.",
    requiredSections: [
      { key: 'data_collected', label: 'Personal data collected and why' },
      { key: 'obligations', label: 'Obligations by region (UK/EU/US)' },
      { key: 'filings', label: 'Registrations or filings to make' },
      { key: 'policies', label: 'Privacy policy and T&C outline' },
    ],
  },
  {
    id: 'deployment',
    label: 'Deployment options',
    minPhase: 'planning',
    guidance:
      "Lay out 2-3 realistic ways to host this app given its architecture, audience size and the founder's skills: managed platforms vs. a no-ops option vs. a cheaper DIY route. Compare effort, monthly cost at the cost table's scales, and lock-in. Ground prices in get_pricing_tiers or cited pages.",
    requiredSections: [
      { key: 'options', label: 'Hosting options compared' },
      { key: 'recommendation', label: 'Recommended route and why' },
      { key: 'steps', label: 'First deployment steps' },
    ],
  },
  {
    id: 'paywall-geo',
    label: 'Paywall & pricing by market',
    minPhase: 'planning',
    guidance:
      "Design the app's own paywall for the countries it will sell in: currency, price points that fit each market's purchasing power, tax handling (VAT/GST/sales tax inclusive or exclusive), and which payment methods matter locally. Anchor prices to real competitor pricing found via web_search.",
    requiredSections: [
      { key: 'markets', label: 'Target markets and currencies' },
      { key: 'pricing', label: 'Price points per market' },
      { key: 'tax', label: 'Tax and invoicing handling' },
      { key: 'payments', label: 'Local payment methods' },
    ],
  },
  {
    id: 'launch',
    label: 'Launch plan',
    minPhase: 'refine',
    guidance:
      'Plan how the world finds out the app exists: pre-launch list building, the launch moment (e.g. Product Hunt, Hacker News, relevant communities), press and newsletters that fit the niche, and the first 30 days after. Tie channels to the locked ICP and marketing plan.',
    requiredSections: [
      { key: 'prelaunch', label: 'Pre-launch' },
      { key: 'launch_day', label: 'Launch moment and channels' },
      { key: 'first_30_days', label: 'First 30 days' },
      { key: 'success_metrics', label: 'What success looks like' },
    ],
  },
  {
    id: 'social-seo',
    label: 'Social, SEO & AI search',
    minPhase: 'refine',
    guidance:
      "Pick the social and search channels that fit this app's business model and audience — LinkedIn, Google Ads, Instagram, Facebook, YouTube, TikTok, X or others — and say why each one is or isn't worth it. Include classic SEO (keywords, pages), AI search / AEO (how to get cited by ChatGPT, Perplexity, Gemini) and a starter content cadence.",
    requiredSections: [
      { key: 'channels', label: 'Channels that fit, and why' },
      { key: 'seo', label: 'SEO keywords and pages' },
      { key: 'aeo', label: 'AI search / AEO' },
      { key: 'cadence', label: 'Content cadence' },
    ],
  },
  {
    id: 'spec-pack',
    label: 'Spec pack',
    minPhase: 'refine',
    tierId: 'spec-pack',
    guidance:
      'Turn the locked plan and built app into an engineering spec a developer or coding agent can build from: scope, data model, screens and flows, non-functional requirements and open questions. Use get_manifest as the source of truth.',
    requiredSections: [
      { key: 'scope', label: 'Scope and out-of-scope' },
      { key: 'data_model', label: 'Data model' },
      { key: 'screens', label: 'Screens and flows' },
      { key: 'nfrs', label: 'Non-functional requirements' },
    ],
  },
  {
    id: 'epics-export',
    label: 'Epics & export',
    minPhase: 'refine',
    tierId: 'spec-pack',
    guidance:
      'Break the spec into ordered epics and issues with acceptance criteria and dependencies, written for the chosen audience (human developer or coding agent), ready to export to GitHub or as Markdown.',
    requiredSections: [
      { key: 'epics', label: 'Epics in build order' },
      { key: 'issues', label: 'Issues with acceptance criteria' },
      { key: 'dependencies', label: 'Dependency ordering' },
    ],
  },
  {
    id: 'financial',
    label: 'Financial angle',
    minPhase: 'refine',
    tierId: 'financial-pack',
    guidance:
      'Build a 12-month view from assumptions the founder agrees to: TAM/SAM/SOM with cited sources, CAC by channel, conversion and churn, monthly revenue and cost trajectory, burn and runway, plus kill criteria. Every number must trace to an assumption or a cited source — label estimates as estimates.',
    requiredSections: [
      { key: 'market_size', label: 'TAM / SAM / SOM' },
      { key: 'unit_economics', label: 'CAC, LTV, conversion, churn' },
      { key: 'projection', label: '12-month projection' },
      { key: 'runway', label: 'Burn and runway' },
      { key: 'kill_criteria', label: 'Kill criteria' },
    ],
  },
  {
    id: 'funding',
    label: 'Funding & listing',
    minPhase: 'refine',
    tierId: 'financial-pack',
    guidance:
      "List realistic funding routes for the founder's country and stage — bootstrapping, grants, angels, accelerators, VC, crowdfunding — plus company setup and listing considerations in the US, UK and EU (entity type, tax schemes such as SEIS/EIS, Delaware C-corp norms). Cite official sources; this is orientation, not legal or financial advice.",
    requiredSections: [
      { key: 'routes', label: 'Funding routes ranked' },
      { key: 'jurisdictions', label: 'US / UK / EU setup' },
      { key: 'next_steps', label: 'Next steps' },
    ],
  },
  {
    id: 'pitch-deck',
    label: 'Pitch deck',
    minPhase: 'refine',
    tierId: 'pitch-deck',
    guidance:
      'Draft an investor deck from the locked plan: problem, solution, market, product, business model, traction or validation, go-to-market, competition, team, and the ask. One slide per section, each with a headline and 2-4 supporting points; revenue claims come from the financial agent or are labelled as scenarios.',
    requiredSections: [
      { key: 'problem', label: 'Problem' },
      { key: 'solution', label: 'Solution' },
      { key: 'market', label: 'Market' },
      { key: 'business_model', label: 'Business model' },
      { key: 'gtm', label: 'Go-to-market' },
      { key: 'ask', label: 'The ask' },
    ],
  },
];

export const ADVISOR_MODULES = ADVISOR_SPECS.map(createAdvisorModule);
