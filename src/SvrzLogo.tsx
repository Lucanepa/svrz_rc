export default function SvrzLogo({ className = 'h-16' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 320 200"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Swiss Volley Region Zürich"
    >
      {/* Player figure — stylized volleyball player */}
      {/* Ball */}
      <circle cx="175" cy="28" r="14" fill="#A0A0A0" />

      {/* Head / upper body arc */}
      <path
        d="M120 62 C125 40, 145 30, 160 38"
        stroke="#A0A0A0"
        strokeWidth="12"
        strokeLinecap="round"
        fill="none"
      />

      {/* Swooping arm / orbit ellipse */}
      <ellipse
        cx="168"
        cy="58"
        rx="72"
        ry="22"
        fill="none"
        stroke="#A0A0A0"
        strokeWidth="10"
        transform="rotate(-12, 168, 58)"
      />

      {/* Body / leg */}
      <path
        d="M125 65 C118 80, 105 95, 95 105"
        stroke="#A0A0A0"
        strokeWidth="10"
        strokeLinecap="round"
        fill="none"
      />

      {/* "Swiss" in red italic bold */}
      <text
        x="10"
        y="158"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="52"
        fontWeight="900"
        fontStyle="italic"
        fill="#DC2626"
      >
        Swiss
      </text>

      {/* "Volley" in grey italic */}
      <text
        x="152"
        y="158"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="52"
        fontWeight="700"
        fontStyle="italic"
        fill="#A0A0A0"
      >
        Volley
      </text>

      {/* "REGION ZÜRICH" subtitle */}
      <text
        x="160"
        y="185"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="18"
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
