import type { Metadata } from "next";
import { AdminView } from "@/components/admin/admin-view";

export const metadata: Metadata = { title: "Admin", description: "AI providers, models, Auto mode and usage weights." };

export default function AdminPage() {
  return <AdminView />;
}
