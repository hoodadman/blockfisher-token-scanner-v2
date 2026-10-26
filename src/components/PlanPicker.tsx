import { PLANS, PLAN_IDS, type PlanId } from '../plans/plans';
import './PlanPicker.css';

const price = (amount: number) => (amount === 0 ? '£0' : `£${amount.toFixed(2)}`);

/** The mock Scanner Pro: pick a plan to see how each scan differs. No payment is taken. */
export function PlanPicker({ plan, onChange }: { plan: PlanId; onChange: (plan: PlanId) => void }) {
  return (
    <section className="plans" aria-labelledby="plans-title">
      <div className="plans__head">
        <h2 id="plans-title">Scanner plans</h2>
        <p className="plans__mock">Preview: pick a plan to try it. No payment is taken.</p>
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
              onClick={() => onChange(id)}
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
              <span className="plans__choose">{chosen ? 'Scanning with this plan' : `Try ${item.name}`}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
