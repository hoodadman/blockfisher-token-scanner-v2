import { useMemo, useState } from 'react';
import type { AccountView } from '../billing/accounts';
import { SCANNERS, poundsText, quote, type ScannerId, type TokenTier } from '../billing/catalog';
import { askForSignIn, openPortal, savedKey, signOut, startCheckout } from '../billing/client';
import { PLANS } from '../plans/plans';
import './Checkout.css';

/**
 * Buying a package: tick the scanners, see each one's price and discount, then pay on
 * Stripe. Scanners that haven't launched show as "Coming later" and can't be ticked.
 */
export function Checkout({ tier, onTier }: { tier: TokenTier; onTier: (tier: TokenTier) => void }) {
  const [ticked, setTicked] = useState<ScannerId[]>(['token']);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const priced = useMemo(() => quote({ scanners: ticked, tier }), [ticked, tier]);

  function toggle(id: ScannerId) {
    setTicked((now) => (now.includes(id) ? now.filter((item) => item !== id) : [...now, id]));
  }

  async function pay(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(await startCheckout(ticked, tier, email));
    setBusy(false);
  }

  const lineOf = (id: ScannerId) => priced.lines.find((line) => line.scanner === id);

  return (
    <form className="checkout" onSubmit={pay} aria-labelledby="checkout-title">
      <h3 id="checkout-title">Choose your scanners</h3>
      <ul className="checkout__list">
        {SCANNERS.map((scanner) => {
          const line = lineOf(scanner.id);
          return (
            <li key={scanner.id} className={`checkout__item${scanner.launched ? '' : ' checkout__item--later'}`}>
              <label>
                <input type="checkbox" checked={ticked.includes(scanner.id)} disabled={!scanner.launched} onChange={() => toggle(scanner.id)} />
                <span className="checkout__name">{scanner.name}</span>
              </label>
              {scanner.id === 'token' && ticked.includes('token') && (
                <span className="checkout__tiers" role="radiogroup" aria-label="Token scanner plan">
                  {(['pro', 'ultra'] as const).map((id) => (
                    <button key={id} type="button" role="radio" aria-checked={tier === id} className={tier === id ? 'checkout__tier checkout__tier--on' : 'checkout__tier'} onClick={() => onTier(id)}>
                      {PLANS[id].name}
                    </button>
                  ))}
                </span>
              )}
              <span className="checkout__price">
                {!scanner.launched
                  ? 'Coming later'
                  : line
                    ? `${poundsText(line.price)}${line.discountPercent > 0 ? `, ${line.discountPercent}% discount` : ''}`
                    : poundsText(scanner.id === 'token' ? PLANS[tier].monthlyPrice : scanner.monthlyPrice)}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="checkout__note">Each extra scanner in one package gets a bigger discount: 10% on the second, 20% on the third, 30% on the fourth. The portfolio scanner will be priced on its own.</p>
      <p className="checkout__total">
        <span>Total</span>
        <strong>
          {poundsText(priced.total)} <span className="checkout__per">a month</span>
        </strong>
      </p>
      {priced.fullTotal > priced.total && <p className="checkout__saving">You save {poundsText(priced.fullTotal - priced.total)} a month.</p>}
      <label className="checkout__email">
        Email
        <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <button className="checkout__pay" type="submit" disabled={busy || ticked.length === 0}>
        {busy ? 'Opening checkout…' : 'Continue to payment'}
      </button>
      <p className="checkout__note">Payment is taken by Stripe. Cancel any time from Manage billing.</p>
      {message && (
        <p className="checkout__message" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}

/** Signed in: who, which plan, and the way to billing. Signed out: sign in by email. */
export function AccountBar({ account, onSignedOut }: { account?: AccountView; onSignedOut: () => void }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string>();
  const [copied, setCopied] = useState(false);

  if (account) {
    return (
      <div className="account">
        <p>
          Signed in as <strong>{account.email}</strong>. {account.paying ? `Scans run on ${PLANS[account.plan].name}.` : 'Your plan has ended, so scans run on Free.'}
        </p>
        <div className="account__actions">
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(savedKey() ?? '');
              setCopied(true);
            }}
          >
            {copied ? 'Key copied' : 'Copy key for the extension'}
          </button>
          <button type="button" onClick={async () => setMessage(await openPortal())}>
            Manage billing
          </button>
          <button
            type="button"
            onClick={async () => {
              await signOut();
              onSignedOut();
            }}
          >
            Sign out
          </button>
        </div>
        {message && <p role="alert">{message}</p>}
      </div>
    );
  }
  return (
    <form
      className="account"
      onSubmit={async (event) => {
        event.preventDefault();
        setMessage(await askForSignIn(email));
      }}
    >
      <label>
        Already paid? Sign in with your email
        <span className="account__row">
          <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          <button type="submit">Email me a link</button>
        </span>
      </label>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
