import Image from "next/image";

interface LogoProps {
  size?: "sm" | "md" | "lg";
}

const sizes = {
  sm: { w: 80, h: 24 },
  md: { w: 100, h: 30 },
  lg: { w: 140, h: 42 },
};

export function Logo({ size = "md" }: LogoProps) {
  const { w, h } = sizes[size];
  return (
    <Image
      src="/logo/sanofi_logo.png"
      alt="Sanofi"
      width={w}
      height={h}
      style={{ objectFit: "contain", objectPosition: "left center" }}
      priority
    />
  );
}
