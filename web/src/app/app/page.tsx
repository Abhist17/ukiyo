import type { Metadata } from "next";
import { DApp } from "@/components/app/DApp";

export const metadata: Metadata = {
  title: "Ukiyo App · Curator vaults scored by Edge",
  description: "Deposit into curator vaults ranked live by Edge, swap through the hook-exclusive pool, and watch the hook classify every swap.",
};

export default function AppPage() {
  return <DApp />;
}
