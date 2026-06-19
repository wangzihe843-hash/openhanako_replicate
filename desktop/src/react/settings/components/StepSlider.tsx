import React, { type CSSProperties } from 'react';
import styles from './settings-components.module.css';

export interface StepSliderOption {
  value: string;
  label: React.ReactNode;
  valueLabel: string;
}

interface StepSliderProps {
  ariaLabel: string;
  value: string;
  options: StepSliderOption[];
  onChange: (value: string) => void;
}

export function StepSlider({
  ariaLabel,
  value,
  options,
  onChange,
}: StepSliderProps) {
  if (options.length === 0) return null;

  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const selected = options[selectedIndex] ?? options[0];
  const max = Math.max(0, options.length - 1);
  const progress = max === 0 ? 0 : (selectedIndex / max) * 100;

  const sliderStyle = {
    '--step-slider-progress': `${progress}%`,
  } as CSSProperties;

  const tickStyle = {
    gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
  } as CSSProperties;

  return (
    <div className={styles.stepSlider} style={sliderStyle}>
      <div className={styles.stepSliderTop}>
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={selectedIndex}
          className={styles.stepSliderInput}
          aria-label={ariaLabel}
          aria-valuetext={selected.valueLabel}
          onChange={(event) => {
            const index = Number(event.target.value);
            const option = options[index];
            if (option) onChange(option.value);
          }}
        />
        <span className={styles.stepSliderValue}>{selected.valueLabel}</span>
      </div>
      <div className={styles.stepSliderTicks} style={tickStyle} aria-hidden="true">
        {options.map((option, index) => (
          <span
            key={option.value}
            className={index === selectedIndex ? styles.stepSliderTickActive : undefined}
          >
            {option.label}
          </span>
        ))}
      </div>
    </div>
  );
}
