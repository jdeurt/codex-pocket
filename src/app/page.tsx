import { homeDestination } from "@/state/pockets";
import { headers } from "next/headers";
import { PocketStateProvider } from "@/providers/pocket-state";
import { readClientBootstrap } from "@/server/client-bootstrap";
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
  const next = homeDestination(entries);

  if (next) {
    redirect(pocketHref(next));
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

  const requestHeaders = await headers();
  const url = new URL("http://localhost/");

  if (typeof params.pocket === "string") {
    url.searchParams.set("pocket", params.pocket);
  }

  const initial = await readClientBootstrap(new Request(url, { headers: requestHeaders }));

  return (
    <PocketStateProvider key={initial.pocketId} initial={initial}>
      <Chat />
    </PocketStateProvider>
  );
}
