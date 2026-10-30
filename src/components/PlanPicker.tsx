import { PLANS, PLAN_IDS, type PlanId } from '../plans/plans';
import './PlanPicker.css';

const price = (amount: number) => (amount === 0 ? '£0' : `£${amount.toFixed(2)}`);

/**
 * The three plans. 'try' (the mock Scanner Pro): pick a plan to see how each scan differs,
 * no payment taken. 'buy' (paid plans open): picking Pro or Ultra chooses what checkout
 * sells; `current` is the plan the signed-in account pays for.
 */
export function PlanPicker({
  plan,
  onChange,
  mode = 'try',
  current,
}: {
  plan: PlanId;
  onChange: (plan: PlanId) => void;
  mode?: 'try' | 'buy';
  current?: PlanId;
}) {
  return (
    <section className="plans" aria-labelledby="plans-title">
      <div className="plans__head">
        <h2 id="plans-title">Scanner plans</h2>
        <p className="plans__mock">
          {mode === 'try' ? 'Preview: pick a plan to try it. No payment is taken.' : 'Free needs no account. Pro and Ultra are monthly; cancel any time.'}
        </p>
      </div>
      <div className="plans__grid" role="radiogroup" aria-labelledby="plans-title">
        {PLAN_IDS.map((id) => {
          const item = PLANS[id];
          const chosen = id === plan;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={chosen}
              className={`plans__card${chosen ? ' plans__card--chosen' : ''}`}
              onClick={() => (mode === 'try' || id !== 'free' ? onChange(id) : undefined)}
            >
              <span className="plans__name">{item.name}</span>
              <span className="plans__price">
                {price(item.monthlyPrice)}
                {item.monthlyPrice > 0 && <span className="plans__per"> a month</span>}
              </span>
              <span className="plans__tagline">{item.tagline}</span>
              <ul className="plans__features">
                {item.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <span className="plans__choose">{chooseText(mode, id, chosen, current)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function chooseText(mode: 'try' | 'buy', id: PlanId, chosen: boolean, current: PlanId | undefined): string {
  if (mode === 'try') return chosen ? 'Scanning with this plan' : `Try ${PLANS[id].name}`;
  if (id === current) return 'Your plan';
  if (id === 'free') return 'No account needed';
  return chosen ? 'Selected below' : `Choose ${PLANS[id].name}`;
}
