import { Box, Lightbulb } from "lucide-react";

export function PatentTypeIcon({ type }: { type: "invention" | "utility-model" | "design" }) {
  if (type === "design") {
    return (
      <Box className="library-patent-type-icon" size={21} strokeWidth={1.7} aria-hidden="true" />
    );
  }
  if (type === "invention") {
    return (
      <Lightbulb
        className="library-patent-type-icon"
        size={21}
        strokeWidth={1.7}
        aria-hidden="true"
      />
    );
  }

  return (
    <svg
      className="library-patent-type-icon"
      width={21}
      height={21}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.80 6.01L13.07 6.83L14.52 6.97L14.52 9.03L13.07 9.17L12.80 9.99L12.41 10.76L13.34 11.88L11.88 13.34L10.76 12.41L9.99 12.80L9.17 13.07L9.03 14.52L6.97 14.52L6.83 13.07L6.01 12.80L5.24 12.41L4.12 13.34L2.66 11.88L3.59 10.76L3.20 9.99L2.93 9.17L1.48 9.03L1.48 6.97L2.93 6.83L3.20 6.01L3.59 5.24L2.66 4.12L4.12 2.66L5.24 3.59L6.01 3.20L6.83 2.93L6.97 1.48L9.03 1.48L9.17 2.93L9.99 3.20L10.76 3.59L11.88 2.66L13.34 4.12L12.41 5.24Z" />
      <circle cx={8} cy={8} r={2} />
      <path d="M20.80 16.50L20.74 17.21L21.95 17.81L21.27 19.43L20.00 19.00L19.54 19.54L19.00 20.00L19.43 21.27L17.81 21.95L17.21 20.74L16.50 20.80L15.79 20.74L15.19 21.95L13.57 21.27L14.00 20.00L13.46 19.54L13.00 19.00L11.73 19.43L11.05 17.81L12.26 17.21L12.20 16.50L12.26 15.79L11.05 15.19L11.73 13.57L13.00 14.00L13.46 13.46L14.00 13.00L13.57 11.73L15.19 11.05L15.79 12.26L16.50 12.20L17.21 12.26L17.81 11.05L19.43 11.73L19.00 13.00L19.54 13.46L20.00 14.00L21.27 13.57L21.95 15.19L20.74 15.79Z" />
      <circle cx={16.5} cy={16.5} r={1.7} />
    </svg>
  );
}
