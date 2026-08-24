import { SignIn } from "@clerk/nextjs";
import { Logo } from "@/components/Logo";

export default function SignInPage() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-8 px-4"
      style={{ background: "var(--background)" }}
    >
      <Logo size="lg" />
      <SignIn />
    </div>
  );
}
