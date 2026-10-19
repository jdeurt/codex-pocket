import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import nextConfig from "../../next.config";
import path from "node:path";

export async function createSpinnerSite() {
  const repository = process.cwd();
  const project = await mkdtemp(path.resolve(".local/spinner-fixture-"));
  await mkdir(path.join(project, "app/api/spinner/[id]"), { recursive: true });
  await Promise.all([
    writeFile(path.join(project, "package.json"), JSON.stringify({ private: true, type: "module" })),
    writeFile(
      path.join(project, "tsconfig.json"),
      JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { paths: { "@/*": ["../../src/*"] } },
        include: ["app/**/*.tsx", "app/**/*.ts", ".next/types/**/*.ts"],
      })
    ),
    writeFile(
      path.join(project, "next.config.ts"),
      `export default ${JSON.stringify({ ...nextConfig, turbopack: { ...nextConfig.turbopack, root: repository } })};`
    ),
    writeFile(
      path.join(project, "app/layout.tsx"),
      `import ${JSON.stringify("../../../src/app/globals.css")};` +
        'export default function Layout({children}: {children: React.ReactNode}) { return <html lang="en" className="dark"><body>{children}</body></html>; }'
    ),
    writeFile(
      path.join(project, "app/page.tsx"),
      `import {ActivitySpinner} from "@/components/activity-spinner"; export default function Page(){return <main style={{padding:24}}><div className="activity-indicator" role="status"><ActivitySpinner/><span>Considering options</span></div></main>;}`
    ),
    copyFile(path.join(repository, "src/app/api/spinner/route.ts"), path.join(project, "app/api/spinner/route.ts")),
    copyFile(
      path.join(repository, "src/app/api/spinner/[id]/route.ts"),
      path.join(project, "app/api/spinner/[id]/route.ts")
    ),
  ]);

  return project;
}
