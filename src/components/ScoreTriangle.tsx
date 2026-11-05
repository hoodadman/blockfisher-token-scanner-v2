import { useEffect, useId, useRef, useState } from 'react';
import { toneFor, type ScoreTone } from '../scoring';
import { PILLAR_HELP } from './pillarHelp';
import './ScoreTriangle.css';

export interface PillarScore {
  id: 'security' | 'community' | 'foundation';
  label: string;
  score: number | null;
}

interface ScoreTriangleProps {
  overall: number | null;
  pillars: readonly PillarScore[];
}

const CX = 180;
const CY = 168;
const TIP = 128;
const INNER = 62;
const SPREAD = 34;

function polar(radius: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

function points(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y}`;
}

const ANGLES: Record<PillarScore['id'], number> = {
  security: 0,
  community: 120,
  foundation: 240,
};

export function ScoreTriangle({ overall, pillars }: ScoreTriangleProps) {
  const [hover, setHover] = useState<string | null>(null);
  const tone = toneFor(overall);
  const helpId = useId();
  const box = useRef<HTMLElement>(null);

  // A tapped petal stays open until the next tap elsewhere, or Escape.
  useEffect(() => {
    if (!hover) return;
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && setHover(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.tri-petal') || !box.current?.contains(event.target)) setHover(null);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [hover]);

  return (
    <section ref={box} className={`tri tri--${tone}`} aria-label="Overall token score">
      <svg className="tri__svg" viewBox="0 0 360 340" role="presentation">
        {pillars.map((pillar) => {
          const angle = ANGLES[pillar.id];
          const tip = polar(TIP, angle);
          const left = polar(INNER, angle - SPREAD);
          const right = polar(INNER, angle + SPREAD);
          const mid = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
          const fill = (pillar.score ?? 0) / 100;
          const fillTip = { x: mid.x + (tip.x - mid.x) * fill, y: mid.y + (tip.y - mid.y) * fill };
          const label = polar(TIP + 22, angle);
          const petalTone = toneFor(pillar.score);
          const active = hover === pillar.id;

          return (
            <g
              key={pillar.id}
              className={`tri-petal tri-petal--${petalTone}`}
              data-active={active || undefined}
              tabIndex={0}
              role="img"
              aria-label={
                pillar.score === null
                  ? `${pillar.label}: no score yet`
                  : `${pillar.label}: ${pillar.score} out of 100`
              }
              aria-describedby={`${helpId}-${pillar.id}`}
              onPointerEnter={(event) => event.pointerType === 'mouse' && setHover(pillar.id)}
              onPointerUp={(event) => event.pointerType !== 'mouse' && setHover((value) => (value === pillar.id ? null : pillar.id))}
              onPointerLeave={(event) => event.pointerType === 'mouse' && setHover((value) => (value === pillar.id ? null : value))}
              onFocus={(event) => event.currentTarget.matches(':focus-visible') && setHover(pillar.id)}
              onBlur={() => setHover((value) => (value === pillar.id ? null : value))}
            >
              <polygon className="tri-petal__track" points={points(tip, left, right)} />
              {pillar.score !== null && pillar.score > 0 && (
                <polygon className="tri-petal__fill" points={points(fillTip, left, right)} />
              )}
              <text className="tri-petal__label" x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle">
                {pillar.label}
              </text>
            </g>
          );
        })}
        <circle className="tri__ring-track" cx={CX} cy={CY} r="50" />
        <circle className="tri__core" cx={CX} cy={CY} r="46" />
      </svg>

      <div className="tri__score" aria-hidden={overall !== null ? undefined : true}>
        {overall === null ? (
          <>
            <span className="tri__number">?</span>
            <span className="tri__max">no score</span>
          </>
        ) : (
          <>
            <span className="tri__number">{overall}</span>
            <span className="tri__max">out of 100</span>
          </>
        )}
      </div>

      {pillars.map((pillar) => {
        if (hover !== pillar.id) return null;
        const angle = ANGLES[pillar.id];
        const spot = polar((INNER + TIP) / 2, angle);
        // Centred across the triangle at the petal's height, so the longer text never runs off a phone screen.
        return (
          <div key={`${pillar.id}-hover`} className="tri__hover" style={{ top: `${(spot.y / 340) * 100}%` }} aria-hidden="true">
            <strong>
              {pillar.label}: {pillar.score === null ? 'no score yet' : `${pillar.score} / 100`}
            </strong>
            <span>{PILLAR_HELP[pillar.id]}</span>
          </div>
        );
      })}
      {pillars.map((pillar) => (
        <span key={`${pillar.id}-help`} id={`${helpId}-${pillar.id}`} className="tri__sr">
          {PILLAR_HELP[pillar.id]}
        </span>
      ))}
    </section>
  );
}

export type { ScoreTone };
