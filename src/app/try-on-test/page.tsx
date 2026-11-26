import { notFound } from "next/navigation";
import { TryOnTestGrid } from "@/components/ar/try-on-test-grid";

// A development tool: renders every try-on shade on fixed test photos. Not part of the shop.
export default function TryOnTestPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <TryOnTestGrid />;
}
