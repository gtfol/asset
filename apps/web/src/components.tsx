import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Info,
  House,
  ShoppingBasket,
  Utensils,
  Coffee,
  Car,
  ShoppingBag,
  Heart,
  Ticket,
  Plane,
  Banknote,
  Zap,
  BookOpen,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import { money, shiftMonth, type Category } from '../shared/core';
import { categoryIconKey, type CategoryIconKey } from '../shared/category-icons';

const categorySymbols: Record<CategoryIconKey, LucideIcon> = {
  home: House,
  groceries: ShoppingBasket,
  restaurants: Utensils,
  coffee: Coffee,
  transport: Car,
  shopping: ShoppingBag,
  health: Heart,
  fun: Ticket,
  travel: Plane,
  income: Banknote,
  utilities: Zap,
  education: BookOpen,
  other: Tag,
};

export function CategorySymbol({ category }: { category?: Pick<Category, 'id' | 'icon'> }) {
  const Icon = categorySymbols[categoryIconKey(category)];
  return (
    <Icon
      className="category-symbol"
      data-tone={categoryIconKey(category)}
      size={16}
      strokeWidth={1.5}
      aria-hidden="true"
    />
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  suspended = false,
  className = '',
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  suspended?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement;
    return () => previous?.focus();
  }, []);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (suspended) dialog?.close();
    else if (!dialog?.open) dialog?.showModal();
  }, [suspended]);
  return (
    <dialog
      ref={ref}
      className={[wide ? 'wide' : '', className].filter(Boolean).join(' ')}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button aria-label="Close dialog" className="icon-button" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function Badge({ category }: { category: Category | undefined }) {
  return (
    <span className="category-badge" data-tone={categoryIconKey(category)}>
      <CategorySymbol category={category} />
      <span>{category?.name ?? 'Other'}</span>
    </span>
  );
}
export const Status = ({ status }: { status: string }) => (
  <span
    className={
      'status ' +
      (status === 'Over budget'
        ? 'red'
        : status === 'At risk'
          ? 'amber'
          : status === 'On pace' || status === 'healthy'
            ? 'green'
            : 'muted')
    }
  >
    {status.replaceAll('_', ' ')}
  </span>
);
export function MonthControl({
  month,
  setMonth,
}: {
  month: string;
  setMonth: (m: string) => void;
}) {
  return (
    <div className="month-control">
      <button aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
        <ChevronLeft size={16} />
      </button>
      <input
        aria-label="Selected month"
        type="month"
        value={month}
        onChange={(e) => e.target.value && setMonth(e.target.value)}
      />
      <button aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Help({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="calculation-info"
        aria-label="About spending calculations"
        onClick={() => setOpen(true)}
      >
        <Info size={14} />
      </button>
      {open && (
        <Modal title="Spending calculations" onClose={() => setOpen(false)}>
          <p className="muted">{children}</p>
        </Modal>
      )}
    </>
  );
}
export type Point = { date: string; value: number | null; ideal?: number | null };
export function LineChart({
  points,
  currency = 'USD',
  forecast,
  budget,
  compact = false,
  label = 'Balance history',
  color = 'var(--accent)',
}: {
  points: Point[];
  currency?: string;
  forecast?: number | null;
  budget?: number | null;
  compact?: boolean;
  label?: string;
  color?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const known = points.filter((p) => p.value !== null);
  const w = 640,
    h = compact ? 150 : 210,
    pad = 20;
  const vals = points.flatMap((p) => [p.value ?? 0, p.ideal ?? 0]);
  if (forecast !== null && forecast !== undefined) vals.push(forecast);
  const min = Math.min(0, ...vals),
    max = Math.max(100, ...vals),
    range = max - min;
  const x = (i: number) => pad + (i * (w - 2 * pad)) / Math.max(1, points.length - 1),
    y = (v: number) => h - pad - ((v - min) / range) * (h - 2 * pad);
  const path = (field: 'value' | 'ideal') => {
    let started = false;
    return points
      .map((p, i) => {
        if (p[field] === null || p[field] === undefined) return '';
        const segment = `${started ? 'L' : 'M'}${x(i)},${y(p[field]!)}`;
        started = true;
        return segment;
      })
      .join(' ');
  };
  const lastIndex = points.reduce((index, p, i) => (p.value !== null ? i : index), -1);
  const selected = active === null ? null : points[active];
  return (
    <div className="line-chart" onPointerLeave={() => setActive(null)}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${w} ${h}`}
        onPointerMove={(e) => {
          const transform = e.currentTarget.getScreenCTM();
          if (!transform || !points.length) return;
          const cursor = new DOMPoint(e.clientX, e.clientY).matrixTransform(transform.inverse());
          setActive(
            Math.max(
              0,
              Math.min(
                points.length - 1,
                Math.round(((cursor.x - pad) / (w - 2 * pad)) * (points.length - 1)),
              ),
            ),
          );
        }}
      >
        <line x1={pad} y1={y(0)} x2={w - pad} y2={y(0)} stroke="var(--chart-grid)" />
        {budget !== undefined && budget !== null && (
          <line
            x1={pad}
            y1={y(budget)}
            x2={w - pad}
            y2={y(budget)}
            stroke="var(--chart-reference)"
            strokeDasharray="3 5"
          />
        )}
        <path
          d={path('ideal')}
          fill="none"
          stroke="var(--chart-reference)"
          strokeWidth="1.5"
          strokeDasharray="3 5"
        />
        <path
          d={path('value')}
          fill="none"
          stroke={color}
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {forecast !== undefined && forecast !== null && lastIndex >= 0 && (
          <path
            d={`M${x(lastIndex)},${y(points[lastIndex].value!)} L${x(points.length - 1)},${y(forecast)}`}
            stroke="var(--chart-estimate)"
            strokeWidth="2"
            strokeDasharray="6 5"
            fill="none"
          />
        )}
        {forecast != null && lastIndex >= 0 && (
          <>
            <line
              x1={x(lastIndex)}
              y1={15}
              x2={x(lastIndex)}
              y2={h - pad}
              stroke="var(--chart-reference)"
              strokeDasharray="2 5"
            />
            <text x={x(lastIndex) + 7} y={18} fill="currentColor" fontSize={14}>
              Today
            </text>
          </>
        )}
        {lastIndex >= 0 && (
          <circle
            cx={x(lastIndex)}
            cy={y(points[lastIndex].value!)}
            r="4"
            fill="var(--canvas)"
            stroke={color}
            strokeWidth="2.5"
          />
        )}
        {selected && (
          <line
            x1={x(active!)}
            y1={10}
            x2={x(active!)}
            y2={h - pad}
            stroke="var(--chart-reference)"
            strokeDasharray="3 4"
          />
        )}
      </svg>
      <div className="chart-dates">
        <span>{points[0]?.date ?? 'No snapshots'}</span>
        <span>{points.at(-1)?.date}</span>
      </div>
      <input
        className="chart-scrubber"
        aria-label={`${label}: select a date to read exact values`}
        type="range"
        min={0}
        max={Math.max(0, points.length - 1)}
        value={active ?? Math.max(0, lastIndex)}
        onChange={(e) => setActive(Number(e.target.value))}
        onBlur={() => setActive(null)}
      />
      <div className="chart-readout">
        {selected && (
          <output aria-live="polite">
            {selected.date} ·{' '}
            {selected.value === null ? 'No actual yet' : money(selected.value, currency)}
            {selected.ideal != null && ` · Ideal ${money(selected.ideal, currency)}`}
          </output>
        )}
      </div>
      <span className="sr-only">
        {known.length
          ? `${known.length} observed values. Latest ${money(known.at(-1)!.value, currency)} on ${known.at(-1)!.date}.`
          : 'No observed history.'}
        {forecast != null ? ` Estimated month end ${money(forecast, currency)}.` : ''}
      </span>
    </div>
  );
}
export function RangeControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="range-control">
      {['1M', '3M', 'YTD', '1Y', 'ALL'].map((v) => (
        <button
          className={v === value ? 'active' : ''}
          aria-pressed={v === value}
          key={v}
          onClick={() => onChange(v)}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
export function filterHistory<T extends { date: string }>(
  points: T[],
  range: string,
  asOf: string,
) {
  const start =
    range === '1M'
      ? shiftMonth(asOf.slice(0, 7), -1) + '-01'
      : range === '3M'
        ? shiftMonth(asOf.slice(0, 7), -3) + '-01'
        : range === 'YTD'
          ? asOf.slice(0, 4) + '-01-01'
          : range === '1Y'
            ? shiftMonth(asOf.slice(0, 7), -12) + '-01'
            : '0000-01-01';
  return points.filter((p) => p.date >= start && p.date <= asOf);
}
