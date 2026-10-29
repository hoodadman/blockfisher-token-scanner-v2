import { useEffect, useMemo, useRef, useState } from 'react';
import { ScanRefused, scanOnServer } from './api/client';
import { LookupError, isTokenAddress } from './api/lookup';
import type { ScanReport } from './api/scan';
import { AccountBar, Checkout } from './components/Checkout';
import { PlanPicker } from './components/PlanPicker';
import type { AccountView } from './billing/accounts';
import type { TokenTier } from './billing/catalog';
import { billingConfig, claimCheckout, currentAccount, redeemSignIn, type BillingConfig } from './billing/client';
import { ScoreBrief } from './components/ScoreBrief';
import { ScorePanel } from './components/ScorePanel';
import { ScoreTriangle } from './components/ScoreTriangle';
import { TokenSearch } from './components/TokenSearch';
import { PLANS, PLAN_IDS, type PlanId } from './plans/plans';
import { averageScore } from './scoring';
import { summaryFacts } from './summary/facts';

const PLAN_KEY = 'blockfisher-plan';

function savedPlan(): PlanId {
  try {
    const value = localStorage.getItem(PLAN_KEY);
    return value && (PLAN_IDS as readonly string[]).includes(value) ? (value as PlanId) : 'free';
  } catch {
    return 'free';
  }
}

const MESSAGES = {
  invalid: 'That doesn’t look like a token address. Check you’ve copied all of it.',
  unavailable: 'We couldn’t reach the market data service. Check your connection and try again.',
  unexpected: 'Something went wrong. Please try again.',
};

type View =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; report: ScanReport };

export function App() {
  const [view, setView] = useState<View>({ status: 'idle' });
  const [plan, setPlan] = useState<PlanId>(savedPlan);
  const inFlight = useRef<AbortController | null>(null);
  const [billing, setBilling] = useState<BillingConfig>();
  const [account, setAccount] = useState<AccountView>();
  const [tier, setTier] = useState<TokenTier>('pro');
  // Checkout opens once Pro or Ultra is picked, so it doesn't sit between the visitor and the scan box.
  const [shopping, setShopping] = useState(false);
  const [banner, setBanner] = useState<string>();
  const buying = billing?.checkout === true;

  useEffect(() => {
    void (async () => {
      setBilling(await billingConfig());
      // Back from Stripe, or from the emailed sign-in link: swap it for an access key.
      const params = new URLSearchParams(location.search);
      const sessionId = params.get('session_id');
      const signin = params.get('signin');
      const signedIn = sessionId ? await claimCheckout(sessionId) : signin ? await redeemSignIn(signin) : undefined;
      if (params.get('checkout') === 'cancelled') setBanner('Checkout cancelled. Nothing was charged.');
      if (typeof signedIn === 'string') setBanner(signedIn);
      else if (signedIn) setBanner(sessionId ? 'Thank you. Your plan is active on this browser.' : 'Signed in.');
      if (sessionId || signin || params.has('checkout')) history.replaceState(null, '', location.pathname);
      setAccount(typeof signedIn === 'object' ? signedIn : await currentAccount().catch(() => undefined));
    })();
  }, []);

  function choosePlan(next: PlanId) {
    setPlan(next);
    try {
      localStorage.setItem(PLAN_KEY, next);
    } catch {
      // Private windows may refuse; the choice still holds for this visit.
    }
  }

  async function check(address: string, refresh = false) {
    inFlight.current?.abort();
    if (!isTokenAddress(address)) {
      setView({ status: 'error', message: MESSAGES.invalid });
      return;
    }

    const controller = new AbortController();
    inFlight.current = controller;
    setView({ status: 'loading' });
    try {
      const report = await scanOnServer(address, buying ? undefined : plan, refresh, controller.signal);
      if (controller.signal.aborted) return;
      setView({ status: 'done', report });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!(error instanceof LookupError) && !(error instanceof ScanRefused)) console.error(error);
      setView({ status: 'error', message: errorMessage(error) });
    }
  }

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="site-header">
        <div className="header-inner">
          <a className="logo" href="#main" aria-label="Blockfisher token scanner">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="M8 20c0-6 4-10 10-10 4 0 6 2 6 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              <path d="M22 11c2 1 4 3 4 6 0 2-1.2 3.2-2.8 3.2-1.4 0-2.4-1-2.4-2.2" fill="none" stroke="#3c7dff" strokeWidth="2.2" strokeLinecap="round" />
              <circle cx="22.2" cy="15.2" r="1.2" fill="#3c7dff" />
            </svg>
            Blockfisher
          </a>
          <span className="product-name">Token scanner</span>
        </div>
      </header>
    <main id="main" className="page">
      <header className="page__intro">
        <p className="kicker">Token scanner</p>
        <h1>Spot the <em>hook</em> before you bite.</h1>
        <p className="lede">Paste a token address. The scan shows what it found, then a short brief.</p>
      </header>

      {banner && (
        <p className="notice" role="status">
          {banner}
        </p>
      )}
      {buying ? (
        <>
          <PlanPicker mode="buy" plan={tier} current={account?.plan ?? 'free'} onChange={(next) => {
              if (next === 'free') return;
              setTier(next);
              setShopping(true);
            }}
          />
          <AccountBar account={account} onSignedOut={() => setAccount(undefined)} />
          {shopping && !account?.paying && <Checkout tier={tier} onTier={setTier} />}
        </>
      ) : (
        <PlanPicker plan={plan} onChange={choosePlan} />
      )}

      <TokenSearch onSearch={(address) => check(address)} error={view.status === 'error' ? view.message : undefined} />

      <p className="visually-hidden" role="status">
        {view.status === 'loading' && 'Checking this token…'}
        {view.status === 'done' && `Results for ${view.report.name ?? 'this token'} on ${view.report.chain.name}.`}
      </p>

      {view.status === 'loading' && (
        <div className="loading" aria-hidden="true">
          <span className="loading__spinner" />
          Checking this token…
        </div>
      )}
      {view.status === 'done' && <Result report={view.report} onRecheck={() => check(view.report.address, true)} />}
    </main>
    </>
  );
}

function Result({ report: scan, onRecheck }: { report: ScanReport; onRecheck: () => void }) {
  const { name, symbol, chain, address, failures, community, foundation, security: report } = scan;
  const holdersNeedKey = failures.some(({ source, status }) => source === 'holders' && (status === 401 || status === 403));
  const twitterNeedKey = failures.some(({ source, status }) => source === 'community' && (status === 401 || status === 403));
  const showSymbol = symbol && symbol !== name;
  const overall = averageScore([report.score, community?.score, foundation.score]);
  const facts = useMemo(
    () => summaryFacts({ name, overall, security: report, community, foundation }),
    [name, overall, report, community, foundation],
  );

  return (
    <div className="result">
      <div className="token">
        <p className="token__name">
          {name ?? 'Unnamed token'}
          {showSymbol && <span className="token__symbol">{symbol}</span>}
        </p>
        <p className="token__meta">
          {chain.name} ·{' '}
          <span className="token__address" title={address}>
            {address.slice(0, 6)}…{address.slice(-4)}
          </span>
        </p>
      </div>

      {failures.length > 0 && (
        <p className="notice">
          {import.meta.env.DEV && holdersNeedKey
            ? 'Developer note: holder checks need an InsightX key. Add INSIGHTX_API_KEY to .env.local, then restart the dev server. The security score still ran.'
            : import.meta.env.DEV && twitterNeedKey
              ? 'Developer note: Twitter rejected the request. Check the bearer token in .env.local, then restart the dev server.'
              : 'Some checks couldn’t run because part of the data was unavailable. Try again in a minute.'}
        </p>
      )}

      <PlanNotes report={scan} onRecheck={onRecheck} />

      <div className="result__split">
        <div className="result__visual">
          <ScoreTriangle
            overall={overall}
            pillars={[
              { id: 'security', label: 'Security', score: report.score },
              { id: 'community', label: 'Community', score: community?.score ?? null },
              { id: 'foundation', label: 'Foundation', score: foundation.score },
            ]}
          />
          <ScoreBrief facts={facts} community={community} foundation={foundation} />
        </div>
        <ScorePanel security={report} />
      </div>
    </div>
  );
}

const MINUTE = 60_000;

function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / MINUTE));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const SOURCE_TEXT: Record<ScanReport['communitySource'], (from?: ScanReport['communityFrom']) => string> = {
  fetched: () => '',
  library: (from) => (from === 'basic' ? ' (a saved basic check)' : ` (from a saved ${from === 'ultra' ? 'Ultra' : 'Pro'} scan)`),
  expanded: () => ' (a recent Pro scan, read on to Ultra depth)',
  basic: () => ' (basic check)',
  skipped: () => '',
};

/** Which plan ran, how old the shared parts are, Ultra's second opinion, and Re-check. */
function PlanNotes({ report, onRecheck }: { report: ScanReport; onRecheck: () => void }) {
  const plan = PLANS[report.plan];
  const community =
    report.communitySource === 'skipped'
      ? 'Community not checked'
      : report.checked.community !== undefined
        ? `Community checked ${ago(report.checked.community)}${SOURCE_TEXT[report.communitySource](report.communityFrom)}`
        : 'Community checked now';
  const opinion = report.secondOpinion;
  return (
    <div className="plan-notes">
      <div className="plan-notes__row">
        <p>
          <strong>{plan.name} scan.</strong> Security checked now. {community}.
        </p>
        <button
          type="button"
          className="plan-notes__recheck"
          onClick={onRecheck}
          disabled={plan.rechecks === 0}
          title={plan.rechecks === 0 ? 'Re-check is part of Pro and Ultra' : undefined}
        >
          {plan.rechecks === 0 ? 'Re-check: Pro' : 'Re-check'}
        </button>
      </div>
      {report.notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {opinion && (
        <>
          <p>
            <strong>Second opinion from {opinion.source}:</strong>{' '}
            {!opinion.ok ? 'it didn’t answer this time.' : opinion.findings.length === 0 ? 'nothing found.' : 'it found:'}
          </p>
          {opinion.ok && opinion.findings.length > 0 && (
            <ul>
              {opinion.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ScanRefused) return error.message;
  if (!(error instanceof LookupError)) return MESSAGES.unexpected;
  if (error.reason === 'not-found') {
    const chains = new Intl.ListFormat('en-GB', { type: 'disjunction' }).format(error.searched.map((chain) => chain.name));
    return `We couldn’t find this token on ${chains}. Check the address, or it may not be trading yet.`;
  }
  return MESSAGES[error.reason];
}
