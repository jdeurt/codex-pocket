import { SuspensionFixture } from "../../../tests/browser/fixtures/suspension";
import { notFound } from "next/navigation";

export default function Page() {
  if (process.env.NODE_ENV !== "development" || process.env.POCKET_VIRTUALIZATION_FIXTURE !== "1") {
    notFound();
  }

  return <SuspensionFixture />;
}
