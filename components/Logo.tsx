interface LogoProps {
  size?: "sm" | "md" | "lg";
}

const sizes = {
  sm: { tile: 26, mark: "text-[10px]", title: "text-xs", subtitle: "text-[10px]" },
  md: { tile: 32, mark: "text-xs", title: "text-sm", subtitle: "text-xs" },
  lg: { tile: 40, mark: "text-sm", title: "text-base", subtitle: "text-xs" },
};

// The Bettersteps mark: a rounded accent tile with the initials, the product
// name beside it and a quiet subtitle underneath — the same pairing used
// across the Bettersteps portals.
export function Logo({ size = "md" }: LogoProps) {
  const { tile, mark, title, subtitle } = sizes[size];
  return (
    <div className="flex items-center gap-2.5">
      <div
        className={`flex items-center justify-center shrink-0 font-semibold text-white ${mark}`}
        style={{
          width: tile,
          height: tile,
          background: "var(--accent)",
          borderRadius: "var(--radius)",
        }}
      >
        BS
      </div>
      <div className="min-w-0 leading-tight">
        <p className={`${title} font-semibold truncate`} style={{ color: "var(--text-primary)" }}>
          Bettersteps
        </p>
        <p className={subtitle} style={{ color: "var(--text-muted)" }}>
          GTM tools
        </p>
      </div>
    </div>
  );
}
