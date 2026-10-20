import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import nextConfig from "../../next.config";
import path from "node:path";

/**
Reserve a generated Next project beneath this worktree's test-output directory.
@returns A fresh directory that cannot collide with another fixture's build lock.
*/
async function spinnerDirectory() {
  const directory = path.resolve(".next/test-sites");

  await mkdir(directory, { recursive: true });

  return mkdtemp(path.join(directory, "spinner-"));
}

/**
Create a disposable standalone app for the real spinner routes, component and styles.
@returns The generated project directory owned by the browser test lifecycle.
*/
export async function createSpinnerSite() {
  const repository = process.cwd();
  const project = await spinnerDirectory();
  const baseConfig = path.join(repository, "tsconfig.json");
  const sourcePattern = path.join(repository, "src/*");
  const stylePath = path.join(repository, "src/app/globals.css");
  const appDirectory = path.join(project, "app");
  const tsconfig = JSON.stringify({
    extends: path.relative(project, baseConfig),
    compilerOptions: { paths: { "@/*": [path.relative(project, sourcePattern)] } },
    include: ["app/**/*.tsx", "app/**/*.ts", ".next/types/**/*.ts"],
  });
  const config = JSON.stringify({ ...nextConfig, turbopack: { ...nextConfig.turbopack, root: repository } });
  const styles = JSON.stringify(path.relative(appDirectory, stylePath));

  await mkdir(path.join(project, "app/api/spinner/[id]"), { recursive: true });
  await Promise.all([
    writeFile(path.join(project, "package.json"), JSON.stringify({ private: true, type: "module" })),
    writeFile(path.join(project, "tsconfig.json"), tsconfig),
    writeFile(path.join(project, "next.config.ts"), `export default ${config};`),
    writeFile(
      path.join(project, "app/layout.tsx"),
      `import ${styles};` +
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
