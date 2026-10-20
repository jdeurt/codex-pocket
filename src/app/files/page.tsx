import { FileViewer } from "@/components/file-viewer";

/**
Open a directly navigated local file using browser-native rendering.
@param props - Next route search parameters.
@returns The file surface with a reliable route back to chat.
*/
export default async function FilePage({ searchParams }: PageProps<"/files">) {
  const params = await searchParams;

  return <FileViewer key={String(params.path)} filename={typeof params.path === "string" ? params.path : ""} />;
}
