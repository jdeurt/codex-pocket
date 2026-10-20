import { Chat } from "@/components/chat";
import { pocketHost } from "@/server/pocket-config";
import { pocketHref } from "@/lib/pockets";
import { pocketStore } from "@/server/pocket-store";
import { redirect } from "next/navigation";

/**
Pick a surviving saved Pocket without changing any other browser tab.
*/
function selectHome() {
  const entries = pocketStore().list();
  const next = entries.find((entry) => entry.state === "ready");

  if (next && entries.every((entry) => entry.id !== "main")) {
    redirect(pocketHref(next.id));
  }
}

/**
Redirect an old home bookmark after the original Pocket was explicitly deleted.
*/
async function restoreHome() {
  await pocketHost();
  selectHome();
}

/** Mount the selected parent conversation at Pocket's root route.
@param props - Explicit per-tab Pocket selection.
@returns The interactive chat surface with independent native state.
*/
export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;

  if (!params.pocket && process.env.CODEX_THREAD_ID) {
    await restoreHome();
  }

  return <Chat />;
}
