import { object, string } from "./protocol";

export async function post(path: string, data: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const failure = object(await response.json());
    throw new Error(string(failure.error) || "Couldn't send. Your message is saved here.");
  }

  return object(await response.json());
}
