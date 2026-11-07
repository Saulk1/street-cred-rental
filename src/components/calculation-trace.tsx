import { useId, useState } from 'react';
import { CalculatorIcon, ChevronDownIcon } from 'lucide-react';
import type { Calculation } from '../../shared/compute';

const number = (value: number) => value.toLocaleString('en-AU', { maximumFractionDigits: 2 });

function CalculationDetails({ calculation }: { calculation: Calculation }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <article className="calculation-card"><h3><button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}><CalculatorIcon aria-hidden="true" /><span>{calculation.id} · {calculation.title}</span><ChevronDownIcon aria-hidden="true" /></button></h3>
    <div id={id} hidden={!expanded} className="calculation-body">
      <dl className="calculation-metrics">{calculation.metrics.map(metric => <div key={metric.key}><dt>{metric.label}</dt><dd>{number(metric.value)} {metric.unit}</dd></div>)}</dl>
      <p className="calculation-caption">Calculated {new Date(calculation.computedAt).toLocaleString('en-AU')} · Version {calculation.version} · Property {calculation.propertyId}</p>
      <section><h4>Your inputs</h4><ul>{calculation.userInputs.map(input => <li key={input.key}>{input.label}: {typeof input.value === 'number' ? number(input.value) : input.value} {input.unit} · You wrote: “{input.quote}”</li>)}</ul></section>
      <section><h4>Property data used</h4><ul>{calculation.apiInputs.map(input => <li key={input.key}>{input.key} [{input.sourceId}] · Retrieved {new Date(input.retrievedAt).toLocaleString('en-AU')}<dl className="calculation-data">{Object.entries(input.data).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value === null ? 'Not supplied' : String(value)}</dd></div>)}</dl><p>{input.coverage}</p></li>)}</ul></section>
      {!!calculation.assumptions.length && <section><h4>Assumptions</h4><ul>{calculation.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      {!!calculation.warnings.length && <section><h4>Limitations</h4><ul>{calculation.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
    </div>
  </article>;
}
export function CalculationTrace({ calculations }: { calculations: Calculation[] }) {
  return <section className="calculation-traces" aria-label="Calculations">{calculations.map(calculation => <CalculationDetails key={calculation.id} calculation={calculation} />)}</section>;
}
