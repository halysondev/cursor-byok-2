const RELATIVE_UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 60 * 60_000,
  hr: 60 * 60_000,
  hrs: 60 * 60_000,
  hour: 60 * 60_000,
  hours: 60 * 60_000,
  d: 24 * 60 * 60_000,
  day: 24 * 60 * 60_000,
  days: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  weeks: 7 * 24 * 60 * 60_000,
};

function localDate(parts: RegExpMatchArray) {
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = parts;
  const value = new Date(+year, +month - 1, +day, +hour, +minute, +second);
  return value.getFullYear() === +year
    && value.getMonth() === +month - 1
    && value.getDate() === +day
    && value.getHours() === +hour
    && value.getMinutes() === +minute
    && value.getSeconds() === +second
    ? value.getTime()
    : null;
}

export function parseTimeInput(input: string, now = new Date()): number | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;
  if (value === "now") return now.getTime();

  if (value === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  if (value === "yesterday") {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }

  const relative = value.match(/^(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\s*ago$/);
  if (relative) return now.getTime() - Number(relative[1]) * RELATIVE_UNIT_MS[relative[2]];

  if (/^\d{10}$/.test(value)) return Number(value) * 1_000;
  if (/^\d{13}$/.test(value)) return Number(value);

  const normalized = value.replace(/\//g, "-").trim();
  const local = normalized.match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})(?:[ t]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/);
  if (local) return localDate(local);

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatTimeInput(date: Date) {
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}
