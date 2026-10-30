import { useId, useState, type ReactNode } from 'react';
import type { CommunityReport } from '../community';
import type { FoundationReport } from '../foundation';
import type { PillarBrief } from '../summary';
import { formatCount, MetricList, MetricRow } from './Metrics';
import './TrustScore.css';
import './ScorePanel.css';
import './ScoreBrief.css';

/** The server writes the brief into the scan (scan.ts), so the page doesn't ask for it again. */
export function ScoreBrief({
  brief,
  community,
  foundation,
}: {
  brief: PillarBrief;
  community?: CommunityReport;
  foundation: FoundationReport;
}) {
  return (
    <section className="brief" aria-label="Plain-English summary">
      <div className="brief__block">
        <h3>Security</h3>
        <p>{brief.security}</p>
      </div>
      <BriefDrop title="Community" text={brief.community}>
        <CommunityRows report={community} />
      </BriefDrop>
      <BriefDrop title="Foundation" text={brief.foundation}>
        {foundation.facts.map((fact) => (
          <MetricRow key={fact.id} title={fact.label} note={fact.summary} tone={fact.status} tip={fact.details} />
        ))}
      </BriefDrop>
    </section>
  );
}

function BriefDrop({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="brief__block">
      <h3>{title}</h3>
      <p>{text}</p>
      <button
        type="button"
        className="brief__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide the details' : 'See the details'}
      </button>
      <div id={panelId} hidden={!open}>
        <MetricList>{children}</MetricList>
      </div>
    </div>
  );
}

function CommunityRows({ report }: { report?: CommunityReport }) {
  if (!report?.official) {
    return (
      <>
        <MetricRow
          title="No official Twitter page found"
          tip="Without an official page we can only look at other people talking about the token, which is a weaker signal."
        />
        <MentionRow report={report} />
      </>
    );
  }
  const { official } = report;
  return (
    <>
      <MetricRow
        title={`@${official.handle}`}
        note={`${formatCount(official.followers)} followers`}
        tip="The token’s own page. A large, active page is a better sign than silence, but it can still be faked."
      />
      <MetricRow
        title={`${formatCount(official.averageReplies)} replies per post`}
        tip="Comments on official posts. This counts the most, because it is people talking on the main page."
      />
      <MetricRow
        title={`${formatCount(official.averageLikes)} likes per post`}
        tip="Hearts on recent official posts. Easier to give than a comment, so they count for less."
      />
      <MetricRow
        title={`${formatCount(official.averageReposts)} reposts per post`}
        tip="How often official posts are shared. Useful, but weaker than a reply."
      />
      <MentionRow report={report} />
    </>
  );
}

function MentionRow({ report }: { report?: CommunityReport }) {
  return (
    <MetricRow
      title={
        report?.mentions.counted
          ? `${report.mentions.total ?? report.mentions.counted} other posts this week`
          : 'No recent posts from other accounts'
      }
      note={report?.mentions.ignoredBots ? `${report.mentions.ignoredBots} tiny accounts left out` : undefined}
      tip="Larger accounts count for more. Accounts with fewer than 10 followers are treated as bots and ignored."
    />
  );
}
