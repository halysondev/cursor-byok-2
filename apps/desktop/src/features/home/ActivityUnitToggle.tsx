import type { ActivityUnit } from "./charts/ContributionCalendarChart";
import styles from "./ActivityUnitToggle.module.scss";

export function ActivityUnitToggle({ value, onChange }: { value: ActivityUnit; onChange: (unit: ActivityUnit) => void }) {
  const options: Array<{ value: ActivityUnit; label: string }> = [
    { value: "hour", label: "Hour" },
    { value: "day", label: "Day" },
  ];
  return <div className={styles.root} role="group" aria-label="Activity heatmap unit">
    {options.map((option) => <button
      key={option.value}
      type="button"
      aria-pressed={value === option.value}
      onClick={() => onChange(option.value)}
    >{option.label}</button>)}
  </div>;
}
