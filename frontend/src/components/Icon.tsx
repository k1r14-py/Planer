// Небольшой набор иконок в стиле lucide (stroke 2, 24×24)
const PATHS: Record<string, string> = {
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
  "chevron-right": "M9 18l6-6-6-6",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-left": "M15 18l-6-6 6-6",
  check: "M20 6L9 17l-5-5",
  hourglass: "M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4",
  play: "M7 4l13 8-13 8z",
  pause: "M8 4v16M16 4v16",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  plus: "M12 5v14M5 12h14",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  skip: "M5 4l10 8-10 8zM19 5v14",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4",
  flag: "M4 22V4s1.5-1 5-1 5 2 8 2 3-1 3-1v11s-1 1-3 1-5-2-8-2-5 1-5 1",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  corner: "M9 10l-5 5 5 5M20 4v7a4 4 0 0 1-4 4H4",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  square: "M6 6h12v12H6z",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  unlock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.9-1",
  calendar: "M3 5h18v16H3zM16 3v4M8 3v4M3 10h18",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  columns: "M3 4h18v16H3zM12 4v16",
  chart: "M3 3v18h18M8 17V11M13 17V7M18 17v-4",
  x: "M18 6L6 18M6 6l12 12",
  forward: "M15 17l5-5-5-5M4 18v-2a4 4 0 0 1 4-4h12",
  text: "M4 6h16M4 12h16M4 18h10",
  loader: "M21 12a9 9 0 1 1-6.2-8.6",
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      className={`icon icon-${name}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
