import { useId, useState } from 'react';
import type { ActivityBand, CommunityReport } from '../community';
import { InfoTooltip } from './InfoTooltip';
import './TrustScore.css';
import './CommunityScore.css';

const BAND_COPY: Record<ActivityBand, { label: string; tagline: string }> = {
  active: { label: 'Active community', tagline: 'The official page is busy, with people talking there' },
  warming: { label: 'Some activity', tagline: 'There is conversation, but it is not very busy' },
  quiet: { label: 'Quiet so far', tagline: 'Little recent talk on the official page' },
};

const NO_SCORE = { label: 'No community page', tagline: 'We couldn’t find recent Twitter activity for this token' };

export function CommunityScore({ report, defaultOpen = false }: { report: CommunityReport; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const { score, band, official, mentions, telegram, discord } = report;
  const copy = band ? BAND_COPY[band] : NO_SCORE;

  return (
    <section className={`ts cs ts--${band ?? 'none'}`} aria-label="Community score">
      <button
        type="button"
        className="ts__summary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ts-ring">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle className="ts-ring__track" cx="50" cy="50" r="42" />
            {score !== null && score > 0 && (
              <circle
                className="ts-ring__value"
                cx="50"
                cy="50"
                r="42"
                strokeDasharray={2 * Math.PI * 42}
                strokeDashoffset={2 * Math.PI * 42 * (1 - score / 100)}
              />
            )}
          </svg>
          {score === null ? (
            <span className="ts-ring__label">
              <span className="ts-ring__score" aria-hidden="true">?</span>
              <span className="ts-visually-hidden">No score</span>
            </span>
          ) : (
            <span className="ts-ring__label">
              <span className="ts-ring__score">{score}</span>
              <span className="ts-ring__max">out of 100</span>
            </span>
          )}
        </span>
        <span className="ts__headline">
          <span className="ts__eyebrow">Community</span>
          <span className="ts__band">{copy.label}</span>
          <span className="ts__tagline">{copy.tagline}</span>
          <span className="ts__toggle">
            {open ? 'Hide the breakdown' : 'See what we measured'}
            <svg className="ts__chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
      </button>

      <div id={panelId} className="ts__panel" hidden={!open}>
        {official ? (
          <div className="cs-block">
            <p className="cs-block__title">
              Official page
              <span className="ts-pill">Main</span>
            </p>
            <p className="cs-block__lead">
              <a href={`https://x.com/${official.handle}`} target="_blank" rel="noopener noreferrer">
                @{official.handle}
              </a>
              {official.name && official.name !== official.handle ? ` · ${official.name}` : ''}
            </p>
            <ul className="cs-stats">
              <li>
                <strong>{formatCount(official.followers)}</strong>
                followers
                <InfoTooltip label="Followers">How many people follow the token’s own page. This is the main sign that a real community exists.</InfoTooltip>
              </li>
              <li>
                <strong>{formatCount(official.averageReplies)}</strong>
                replies per post
                <InfoTooltip label="Replies">Comments on the official posts. This counts the most, because it is people talking on the main page.</InfoTooltip>
              </li>
              <li>
                <strong>{formatCount(official.averageLikes)}</strong>
                likes per post
                <InfoTooltip label="Likes">Hearts on recent official posts. Easier to give than a comment, so they count for less.</InfoTooltip>
              </li>
              <li>
                <strong>{formatCount(official.averageReposts)}</strong>
                reposts per post
                <InfoTooltip label="Reposts">How often official posts are shared. Useful, but weaker than a reply.</InfoTooltip>
              </li>
            </ul>
            <p className="cs-note">Based on {official.tweetsLookedAt} recent official posts, not including replies or reposts.</p>
          </div>
        ) : (
          <p className="cs-note">No official Twitter page was listed for this token, so we only looked at other people talking about it.</p>
        )}

        <div className="cs-block">
          <p className="cs-block__title">Other accounts</p>
          <p className="cs-block__lead">
            {mentions.counted === 0
              ? 'No recent posts from real accounts.'
              : mentions.total !== undefined
                ? `${mentions.total} ${mentions.total === 1 ? 'post' : 'posts'} in the last 7 days. We looked closely at the ${mentions.counted} most recent from real accounts.`
                : `${mentions.counted} recent ${mentions.counted === 1 ? 'post' : 'posts'} from other accounts.`}
          </p>
          <p className="cs-note">
            Larger accounts count for more. Accounts with fewer than 10 followers are treated as bots and ignored
            {mentions.ignoredBots > 0 ? ` (${mentions.ignoredBots} left out)` : ''}.
          </p>
        </div>

        {(telegram || discord) && (
          <div className="cs-block">
            <p className="cs-block__title">Telegram and Discord</p>
            {[
              { name: 'Telegram', chat: telegram },
              { name: 'Discord', chat: discord },
            ].map(({ name, chat }) =>
              chat ? (
                <p key={name} className="cs-block__lead">
                  {`${name}: ${(chat.members ?? 0).toLocaleString('en-GB')} members`}
                  {chat.online !== undefined ? `, ${chat.online.toLocaleString('en-GB')} online now` : ''}.
                  {chat.quiet ? ' Very few are online for a group this size, which can mean bought members.' : ''}
                </p>
              ) : null,
            )}
            <p className="cs-note">People online count for more than members, because members are cheap to fake.</p>
          </div>
        )}
      </div>

      <footer className="ts__footer">
        <p className="ts__disclaimer">
          This is a snapshot of recent Twitter talk, not a measure of whether the token is safe. Fake or paid posts can still look busy.
        </p>
      </footer>
    </section>
  );
}

function formatCount(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return Number(value.toFixed(value >= 10 ? 0 : 1)).toString();
}
