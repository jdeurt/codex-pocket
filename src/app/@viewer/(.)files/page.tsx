import { FileViewer } from "@/components/file-viewer";

/**
Intercept a file link without unmounting its parent chat or losing draft and scroll state.
@param props - Next route search parameters.
@returns The file overlay whose back action restores the retained chat route.
*/
export default async function FileOverlay({ searchParams }: PageProps<"/files">) {
  const params = await searchParams;

  return (
    <FileViewer
      key={`${String(params.pocket)}:${String(params.path)}`}
      pocketId={typeof params.pocket === "string" ? params.pocket : "main"}
      overlay
      filename={typeof params.path === "string" ? params.path : ""}
    />
  );
}
