import { useRef, useState, type ComponentProps } from "react";
import { Button } from "./Button";
import { TooltipTrigger } from "./TooltipTrigger";
import styles from "./TruncatedButton.module.scss";

/**
 * A button that shows a tooltip with the full text only when the text is truncated with an ellipsis.
 * The button is a flex container and the ellipsis applies to the inner text span;
 * truncation is measured on hover/focus — measuring at mount can give wrong results before fonts load.
 */
export function TruncatedButton({ label, ...props }: ComponentProps<typeof Button> & { label: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  const measure = () => {
    const text = element.current;
    if (text) setTruncated(text.scrollWidth > text.clientWidth);
  };
  const button = <Button {...props} onPointerEnter={measure} onFocus={measure}>
    <span ref={element} className={styles.label}>{label}</span>
  </Button>;
  return truncated ? <TooltipTrigger label={label}>{button}</TooltipTrigger> : button;
}
