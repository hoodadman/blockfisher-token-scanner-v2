import { useId, useState } from 'react';
import { groupSecurity, type GroupedCheck, type TrustReport } from '../scoring';
import { InfoTooltip } from './InfoTooltip';
import { MetricList, MetricRow } from './Metrics';
import { PILLAR_HELP } from './pillarHelp';
import './TrustScore.css';
import './ScorePanel.css';

const DOCS_URL = 'https://docs.example.com/trust-score';

const SEVERITY: Record<string, string> = {
  critical: 'Serious',
  warning: 'Caution',
  minor: 'Small',
};

export function ScorePanel({ security, defaultOpen = true }: { security: TrustReport; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const readMoreTipId = useId();
  const groups = groupSecurity(security);
  const issues = groups.filter((group) => group.status === 'issue');
  const passed = groups.filter((group) => group.status === 'pass');
  const unknown = groups.filter((group) => group.status === 'unknown');
  const toggle =
    issues.length === 0 ? 'What we checked' : `${issues.length} ${issues.length === 1 ? 'warning' : 'warnings'}`;

  return (
    <section className="ts panel" aria-label="Score details">
      <button
        type="button"
        className="ts__summary panel__summary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ts__headline">
          <span className="ts__eyebrow">Security</span>
          <span className="ts__band">What we found</span>
          <span className="ts__tagline">Warning signs first, then the checks that looked fine.</span>
          <span className="ts__toggle">
            {toggle}
            <svg className="ts__chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
      </button>

      <div id={panelId} className="ts__panel panel__body" hidden={!open}>
        <h3 className="panel-section__title">
          Security
          <InfoTooltip label="Security" align="start">
            {PILLAR_HELP.security}
          </InfoTooltip>
        </h3>
        <MetricList>
          {issues.length === 0 && passed.length > 0 && (
            <MetricRow
              title="No warning signs in the checks we could run"
              tone="pass"
              tip="We look for traps such as tokens you can’t sell, hidden admin keys, and unusually high fees."
            />
          )}
          {issues.map((group) => (
            <GroupRow key={group.id} group={group} />
          ))}
          <CheckGroup title="Looks fine" items={passed} />
          <CheckGroup title="Couldn’t check" items={unknown} />
        </MetricList>
      </div>

      <footer className="ts__footer">
        <span className="ts__readmore">
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" aria-describedby={readMoreTipId}>
            Read more
          </a>
          <span role="tooltip" id={readMoreTipId} className="tip">
            How the three scores are worked out, and what each check means.
          </span>
        </span>
        <p className="ts__disclaimer">
          This is a guide, not a guarantee. Automated checks cannot catch every risk. This site is not financial advice — do your own research.
        </p>
      </footer>
    </section>
  );
}

function GroupRow({ group }: { group: GroupedCheck }) {
  return (
    <MetricRow
      title={group.label}
      note={group.status === 'issue' || group.status === 'unknown' ? group.summary : undefined}
      tone={group.severity ?? group.status}
      pill={group.severity ? SEVERITY[group.severity] : undefined}
      experimental={group.experimental}
      tip={group.details}
    />
  );
}

function CheckGroup({ title, items }: { title: string; items: GroupedCheck[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (items.length === 0) return null;
  return (
    <li className="panel-group">
      <button
        type="button"
        className="panel-group__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {title} ({items.length})
      </button>
      {open && (
        <ul id={panelId} className="panel-metrics">
          {items.map((group) => (
            <GroupRow key={group.id} group={group} />
          ))}
        </ul>
      )}
    </li>
  );
}
