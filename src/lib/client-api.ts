import { object, string } from "./protocol";

async function request(path: string, options: RequestInit) {
  const response = await fetch(path, options);

  if (!response.ok) {
    const failure = object(await response.json());
    throw new Error(string(failure.error) || "Couldn't send. Your message is saved here.");
  }

  return object(await response.json());
}

export const get = (path: string, signal: AbortSignal) => request(path, { signal });

export const post = (path: string, data: unknown) =>
  request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
