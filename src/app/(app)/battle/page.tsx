import type { Metadata } from "next";
import { BattleView } from "@/components/battle/battle-view";
import { serverEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Model Battle" };

export default function BattlePage() {
  return <BattleView maxModels={serverEnv().maxCompareModels} />;
}
