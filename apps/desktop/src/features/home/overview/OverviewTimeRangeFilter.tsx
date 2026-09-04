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

export type OverviewRangePreset =
  | "hour"
  | "four-hours"
  | "twenty-four-hours"
  | "today"
  | "yesterday"
  | "week"
  | "month"
  | "custom";

export function OverviewTimeRangeFilter({ value, granularity, customOpen, customStart, customEnd, modelOptions, selectedModels, busy, onSelect, onGranularitySelect, onCustomOpenChange, onCustomStartChange, onCustomEndChange, onSelectedModelsChange, onCustomApply, onRefresh }: {
  value: OverviewRangePreset;
  granularity: number | undefined;
  customOpen: boolean;
  customStart: string;
  customEnd: string;
  modelOptions: ModelSelectOption[];
  selectedModels: string[];
  busy: boolean;
  onSelect: (value: Exclude<OverviewRangePreset, "custom">) => void;
  onGranularitySelect: (bucketMs: number | undefined) => void;
  onCustomOpenChange: (open: boolean) => void;
  onCustomStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
  onSelectedModelsChange: (value: string[]) => void;
  onCustomApply: () => void;
  onRefresh: () => void;
}) {
  const presets: Array<{ value: Exclude<OverviewRangePreset, "custom">; label: string }> = [
    { value: "hour", label: "Last hour" },
    { value: "four-hours", label: "Last 4 hours" },
    { value: "twenty-four-hours", label: "Last 24 hours" },
    { value: "today", label: "Today" },
    { value: "yesterday", label: "Yesterday" },
    { value: "week", label: "Last week" },
    { value: "month", label: "Last month" },
  ];
  const granularityOptions = [
    { bucketMs: undefined, label: "Auto" },
    { bucketMs: 60_000, label: "1 minute" },
    { bucketMs: 15 * 60_000, label: "15 minutes" },
    { bucketMs: 30 * 60_000, label: "30 minutes" },
    { bucketMs: 60 * 60_000, label: "1 hour" },
  ];
  const customButton = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const granularityButton = useRef<HTMLButtonElement>(null);
  const granularityMenu = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const granularityMenuId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, width: 300, maxHeight: 480 });
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [granularityOpen, setGranularityOpen] = useState(false);

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

  useLayoutEffect(() => {
    if (!granularityOpen || !granularityButton.current || !granularityMenu.current) return;
    return autoUpdate(granularityButton.current, granularityMenu.current, () =>
      void computePosition(granularityButton.current!, granularityMenu.current!, {
        placement: "bottom-start",
        middleware: [offset(4), flip({ padding: 10 }), shift({ padding: 10 })],
      }).then(({ x, y }) => setMenuPosition({ left: x, top: y })));
  }, [granularityOpen]);

  useEffect(() => {
    if (!granularityOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!granularityButton.current?.contains(target) && !granularityMenu.current?.contains(target)) setGranularityOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [granularityOpen]);

  useEffect(() => {
    if (!customOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !customButton.current?.contains(target)
        && !popover.current?.contains(target)
      ) onCustomOpenChange(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [customOpen, onCustomOpenChange]);

  const parsedStart = parseTimeInput(customStart);
  const parsedEnd = parseTimeInput(customEnd);
  const customValid = parsedStart !== null && parsedEnd !== null && parsedStart < parsedEnd;
  const selectedGranularity = granularityOptions.find((option) => option.bucketMs === granularity) ?? granularityOptions[0];

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
    <button
      ref={granularityButton}
      className={styles.granularityButton}
      aria-label={"Granularity"}
      aria-haspopup="menu"
      aria-controls={granularityOpen ? granularityMenuId : undefined}
      aria-expanded={granularityOpen}
      onClick={() => setGranularityOpen((current) => !current)}
    >{selectedGranularity.label}</button>
    <TooltipTrigger label={"Refresh"}><button className={controls.iconButton} aria-label={"Refresh"} disabled={busy} onClick={onRefresh}>
      <Icon className={busy ? controls.spin : ""} icon={refreshIcon} size="1.1em" />
    </button></TooltipTrigger>
    {granularityOpen && createPortal(<div
      id={granularityMenuId}
      ref={granularityMenu}
      className={styles.granularityMenu}
      role="menu"
      aria-label={"Granularity"}
      style={menuPosition}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setGranularityOpen(false);
          granularityButton.current?.focus();
        }
      }}
    >
      {granularityOptions.map((option) => <button
        key={String(option.bucketMs)}
        type="button"
        role="menuitem"
        aria-pressed={option.bucketMs === granularity}
        onClick={() => {
          setGranularityOpen(false);
          granularityButton.current?.focus();
          onGranularitySelect(option.bucketMs);
        }}
      >{option.label}</button>)}
    </div>, document.body)}
    {customOpen && createPortal(<div
      id={popoverId}
      ref={popover}
      className={styles.popover}
      role="dialog"
      aria-label={"Custom overview filters"}
      onPointerDown={(event) => event.stopPropagation()}
      style={position}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCustomOpenChange(false);
          customButton.current?.focus();
        }
      }}
    >
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
