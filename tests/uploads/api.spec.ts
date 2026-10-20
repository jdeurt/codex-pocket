import { MAX_FILE_BYTES, fileAttachmentSchema } from "../../src/lib/attachments";
import { directory, isOk } from "./replay-state";
import { expect, test } from "@playwright/test";
import { UPLOAD_ORIGIN } from "../fixtures/browser-defaults";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const fileResponseSchema = z.object({ file: fileAttachmentSchema });

test("API confines IDs, origins, filenames, content and retries", async ({ request }) => {
  const id = crypto.randomUUID();
  const url = `/api/uploads?${new URLSearchParams({ id, name: "safe.html", type: "text/html" })}`;
  const options = {
    headers: { Origin: UPLOAD_ORIGIN, "Content-Type": "application/octet-stream" },
    data: Buffer.from("<script>alert('test')</script>"),
  };
  const first = await request.put(url, options);
  const firstBody = await test.step("Accept the first scoped file upload", async () => {
    expect(first.ok()).toBeTruthy();

    return fileResponseSchema.parse(await first.json());
  });
  const downloaded = await test.step("Keep identical retries idempotent and reject changed bytes", async () => {
    const changedBytes = Buffer.from("changed");

    expect(firstBody.file.kind).toBe("file");
    expect(await isOk(request.put(url, options))).toBeTruthy();
    expect(await isOk(request.put(url, { ...options, data: changedBytes }))).toBeFalsy();

    return await request.get(`/api/uploads?id=${id}`);
  });
  const unrelatedId = await test.step("Sandbox downloaded content and reject unsafe file identities", async () => {
    const traversalId = crypto.randomUUID();
    const missingId = crypto.randomUUID();

    expect(downloaded.headers()["content-type"]).toBe("application/octet-stream");
    expect(downloaded.headers()["content-security-policy"]).toContain("sandbox");
    expect(
      await isOk(request.put(`/api/uploads?id=${traversalId}&name=..%2Fevil&type=text%2Fplain`, options))
    ).toBeFalsy();
    expect(await isOk(request.get("/api/uploads?id=../../etc/passwd"))).toBeFalsy();
    expect(await isOk(request.get(`/api/uploads?id=${missingId}`))).toBeFalsy();

    return await readFile(path.join(directory, "unrelated-id.txt"), "utf8");
  });
  const oversized = await test.step("Reject foreign ownership, hostile origins and unavailable previews", async () => {
    expect(await isOk(request.get(`/api/uploads?id=${unrelatedId}`))).toBeFalsy();
    expect(
      await isOk(request.put(url, { ...options, headers: { ...options.headers, Origin: "https://evil.example" } }))
    ).toBeFalsy();
    expect(await isOk(request.get(`/api/uploads?id=${id}&preview=1`))).toBeFalsy();

    return await request.put(`/api/uploads?id=${crypto.randomUUID()}&name=big.bin&type=application%2Foctet-stream`, {
      ...options,
      data: Buffer.alloc(MAX_FILE_BYTES + 1),
    });
  });
  const emptyMessage = await test.step("Reject oversized upload bodies and empty messages", async () => {
    expect(oversized.ok()).toBeFalsy();

    return await request.post("/api/messages", {
      headers: { Origin: UPLOAD_ORIGIN },
      data: { id: crypto.randomUUID(), text: "" },
    });
  });

  expect(emptyMessage.ok()).toBeFalsy();
});
