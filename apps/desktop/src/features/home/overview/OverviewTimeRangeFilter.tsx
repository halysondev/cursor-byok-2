import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseTimeInput } from "../../../shared/utils/parseTimeInput";
import controls from "../../../shared/ui/Controls.module.scss";
import { Icon } from "../../../shared/ui/Icon";
import { ModelSelect, type ModelSelectOption } from "../../../shared/ui/ModelSelect";
import { TooltipTrigger } from "../../../shared/ui/TooltipTrigger";
import { refreshIcon } from "../../../shared/ui/icons";
import styles from "./OverviewTimeRangeFilter.module.scss";

export type OverviewRangePreset = "ten-minutes" | "hour" | "today" | "week" | "month" | "custom";
export type QuickPreset = "four-hours" | "twenty-four-hours";

export function OverviewTimeRangeFilter({ value, quick, customOpen, customStart, customEnd, modelOptions, selectedModels, busy, onSelect, onQuickSelect, onCustomOpenChange, onCustomStartChange, onCustomEndChange, onSelectedModelsChange, onCustomApply, onRefresh }: {
  value: OverviewRangePreset;
  quick: QuickPreset | null;
  customOpen: boolean;
  customStart: string;
  customEnd: string;
  modelOptions: ModelSelectOption[];
  selectedModels: string[];
  busy: boolean;
  onSelect: (value: Exclude<OverviewRangePreset, "custom">) => void;
  onQuickSelect: (durationMs: number) => void;
  onCustomOpenChange: (open: boolean) => void;
  onCustomStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
  onSelectedModelsChange: (value: string[]) => void;
  onCustomApply: () => void;
  onRefresh: () => void;
}) {
  const presets: Array<{ value: Exclude<OverviewRangePreset, "custom">; label: string }> = [
    { value: "hour", label: "Last hour" },
    { value: "today", label: "Last calendar day" },
    { value: "ten-minutes", label: "Last 10 minutes" },
    { value: "week", label: "Last week" },
    { value: "month", label: "Last month" },
  ];
  const quickPresets: Array<{ value: QuickPreset; label: string }> = [
    { value: "four-hours", label: "Last 4 hours" },
    { value: "twenty-four-hours", label: "Last 24 hours" },
  ];
  const customButton = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, width: 300, maxHeight: 480 });

  useLayoutEffect(() => {
    if (!customOpen || !customButton.current || !popover.current) return;
    return autoUpdate(customButton.current, popover.current, () => void computePosition(customButton.current!, popover.current!, {
      placement: "bottom-end",
      middleware: [offset(5), flip({ padding: 10 }), shift({ padding: 10 }), size({
        padding: 10,
        apply: ({ availableHeight }) => setPosition((current) => ({
          ...current,
          maxHeight: Math.max(240, availableHeight),
        })),
      })],
    }).then(({ x, y }) => setPosition((current) => ({ ...current, left: x, top: y }))));
  }, [customOpen]);

  useEffect(() => {
    if (!customOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!customButton.current?.contains(target) && !popover.current?.contains(target)) onCustomOpenChange(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [customOpen, onCustomOpenChange]);

  const parsedStart = parseTimeInput(customStart);
  const parsedEnd = parseTimeInput(customEnd);
  const customValid = parsedStart !== null && parsedEnd !== null && parsedStart < parsedEnd;
  return <div className={styles.root} aria-label={"Overview time range"}>
    <div className={styles.presets}>
      {presets.map((preset) => <button
        key={preset.value}
        type="button"
        aria-pressed={value === preset.value}
        onClick={() => onSelect(preset.value)}
      >{preset.label}</button>)}
      <button
        ref={customButton}
        type="button"
        aria-haspopup="dialog"
        aria-controls={customOpen ? popoverId : undefined}
        aria-expanded={customOpen}
        aria-pressed={value === "custom"}
        onClick={() => onCustomOpenChange(!customOpen)}
      >{"Custom"}</button>
    </div>
    <TooltipTrigger label={"Refresh"}><button className={controls.iconButton} aria-label={"Refresh"} disabled={busy} onClick={onRefresh}>
      <Icon className={busy ? controls.spin : ""} icon={refreshIcon} size="1.1em" />
    </button></TooltipTrigger>
    {customOpen && createPortal(<div
      id={popoverId}
      ref={popover}
      className={styles.popover}
      role="dialog"
      aria-label={"Custom overview filters"}
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCustomOpenChange(false);
          customButton.current?.focus();
        }
      }}
    >
      <div className={styles.quickPresets} aria-label={"Quick time ranges"}>
        {quickPresets.map((preset) => <button
          key={preset.value}
          type="button"
          aria-pressed={quick === preset.value}
          onClick={() => onQuickSelect(preset.value === "four-hours" ? 4 * 60 * 60_000 : 24 * 60 * 60_000)}
        >{preset.label}</button>)}
      </div>
      <label><span>{"Start time"}</span><input type="text" placeholder={"For example: 2026-08-23 09:00, 1 hour ago"} value={customStart} onChange={(event) => onCustomStartChange(event.target.value)} /></label>
      <label><span>{"End time"}</span><input type="text" placeholder={"For example: now, 2026-08-23 18:00"} value={customEnd} onChange={(event) => onCustomEndChange(event.target.value)} /></label>
      <div className={styles.filterRow}><ModelSelect mode="multiple" label={"Model"} value={selectedModels} options={modelOptions} onChange={onSelectedModelsChange} /></div>
      <div className={styles.popoverActions}>
        <button type="button" className={controls.secondary} onClick={() => onCustomOpenChange(false)}>{"Cancel"}</button>
        <button type="button" className={controls.primary} disabled={!customValid} onClick={onCustomApply}>{"Apply"}</button>
      </div>
    </div>, document.body)}
  </div>;
}
