import { CostDashboard } from "@/components/cost-dashboard";
import { pocketHref } from "@/lib/pockets";

/** Mount the host-wide Settings accounting view without starting an agent or making provider calls.
@param props - Optional selected Pocket identity retained for return navigation.
@returns Independently scrollable usage dashboard.
*/
export default async function UsagePage({ searchParams }: { searchParams: Promise<{ pocket?: string }> }) {
  const params = await searchParams;

  return <CostDashboard backHref={pocketHref(params.pocket ?? "main")} />;
}
