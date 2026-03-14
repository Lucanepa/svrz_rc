export default function SvrzLogo({ className = 'h-16' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 320 70"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Swiss Volley Region Zürich"
    >
      {/* "Swiss" in red italic bold */}
      <text
        x="10"
        y="42"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="48"
        fontWeight="900"
        fontStyle="italic"
        fill="#DC2626"
      >
        Swiss
      </text>

      {/* "Volley" in grey italic */}
      <text
        x="142"
        y="42"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="48"
        fontWeight="700"
        fontStyle="italic"
        fill="#A0A0A0"
      >
        Volley
      </text>

      {/* "REGION ZÜRICH" subtitle */}
      <text
        x="160"
        y="62"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="16"
        fontWeight="800"
        fill="#3A3A3A"
        textAnchor="middle"
        letterSpacing="4"
      >
        REGION ZÜRICH
      </text>
    </svg>
  );
}
