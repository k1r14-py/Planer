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
  folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  tag: "M3 12V4h8l10 10-8 8zM7.5 7.5h.01",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  indent: "M3 6h18M9 12h12M9 18h12M3 10l3 2-3 2",
  outdent: "M3 6h18M9 12h12M9 18h12M6 10l-3 2 3 2",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  sparkles: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8zM5 2l.6 1.4L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.6z",
  steps: "M4 6h4v4H4zM10 8h10M4 14h4v4H4zM10 16h10",
  review: "M4 4h16v12H8l-4 4zM8 9h8M8 12h5",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
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
